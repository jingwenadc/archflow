import sqlite3
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from archflow_api.config import Settings
from archflow_api.conversation_repository import ConversationRepository
from archflow_api.job_repository import JobRepository
from archflow_api.main import create_app
from archflow_api.models import GenerationJobCreate
from test_api import make_client
from test_jobs import SKILLS, ROOT


def test_delete_is_persistent_idempotent_and_project_scoped(tmp_path):
    client = make_client(tmp_path)
    project = client.post("/api/v1/projects", json={"name": "删除标签测试"}).json()
    other = client.post("/api/v1/projects", json={"name": "其他项目"}).json()
    conversation = client.post("/api/v1/conversations", json={
        "project_id": project["id"], "module": "concept", "title": "待删除对话",
    }).json()
    path = f"/api/v1/conversations/{conversation['id']}"
    client.post(path + "/messages", json={"content": "保留历史内容"})
    client.post(f"/api/v1/files?project_id={project['id']}", files={"file": ("brief.pdf", b"project fixture")})
    assert client.delete(path, params={"project_id": other["id"]}).status_code == 404
    assert len(client.get(path + "/messages").json()) == 2
    assert client.delete(path, params={"project_id": project["id"]}).status_code == 204
    assert client.delete(path, params={"project_id": project["id"]}).status_code == 204
    assert client.get(path + "/messages").status_code == 404
    assert client.post(path + "/messages", json={"content": "不应保存"}).status_code == 404
    assert client.post(path + "/rename", json={"title": "不应改名"}).status_code == 404
    restarted = make_client(tmp_path)
    assert restarted.get("/api/v1/conversations", params={"project_id": project["id"], "module": "concept"}).json() == []
    assert len(restarted.get("/api/v1/files", params={"project_id": project["id"]}).json()) == 1
    with sqlite3.connect(tmp_path / "archflow.sqlite3") as database:
        assert database.execute("SELECT count(*) FROM messages WHERE conversation_id=?", (conversation["id"],)).fetchone()[0] == 2
    assert restarted.post("/api/v1/conversations", json={"project_id": project["id"], "module": "concept", "title": "新对话"}).status_code == 201


def test_delete_cancels_all_unfinished_jobs_and_fences_worker(tmp_path):
    client = TestClient(create_app(Settings(
        upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", case_upload_dir=tmp_path / "cases",
        database_path=tmp_path / "archflow.sqlite3", repository_root=ROOT, allowed_origins=(),
        worker_token="test-worker", agent_enabled=True,
    )))
    project = client.post("/api/v1/projects", json={"name": "任务项目"}).json()
    conversation = client.post("/api/v1/conversations", json={"project_id": project["id"], "module": "concept", "title": "任务对话"}).json()
    repo = JobRepository(tmp_path / "archflow.sqlite3")
    request = GenerationJobCreate(project_id=conversation["project_id"], conversation_id=conversation["id"], module="concept", goal="虚构测试任务", target_units=1)
    states = ["running", "queued", "waiting_outline", "waiting_storyboard", "failed", "completed", "needs_review"]
    jobs = [repo.create(request, str(uuid4()), SKILLS, "m", "r") for _ in states]
    claim = repo.claim()
    with repo.connect() as database:
        for job, state in zip(jobs[1:], states[1:]):
            database.execute("UPDATE generation_jobs SET status=? WHERE id=?", (state, job.id))
    assert client.delete(f"/api/v1/conversations/{conversation['id']}", params={"project_id": conversation["project_id"]}).status_code == 204
    assert [repo.detail(job.id).status for job in jobs] == ["cancelled"] * 5 + ["completed", "needs_review"]
    with pytest.raises(HTTPException, match="409"):
        repo.heartbeat(claim.job.id, claim.lease_id)
    with pytest.raises(HTTPException, match="404"):
        repo.create(request, str(uuid4()), SKILLS, "m", "r")
    assert repo.claim() is None
    # Public routes also refuse to create a task against an archived conversation.
    assert client.post("/api/v1/jobs", json=request.model_dump()).status_code == 404


def test_project_trash_restores_messages_and_generated_versions_without_restart(tmp_path):
    client = make_client(tmp_path)
    project = client.post("/api/v1/projects", json={"name": "项目回收站"}).json()
    other = client.post("/api/v1/projects", json={"name": "其他项目"}).json()
    chats = [client.post("/api/v1/conversations", json={
        "project_id": project["id"], "module": module, "title": title,
    }).json() for module, title in [("concept", "方案初稿"), ("bid", "投标初稿")]]
    concept = chats[0]
    client.post(f"/api/v1/conversations/{concept['id']}/messages", json={"content": "保留我的要求"})
    repo = JobRepository(tmp_path / "archflow.sqlite3")
    request = GenerationJobCreate(project_id=project["id"], conversation_id=concept["id"], module="concept", goal="测试", target_units=1)
    job = repo.create(request, str(uuid4()), SKILLS, "m", "r")
    with repo.connect() as database:
        database.execute("UPDATE generation_jobs SET status='completed' WHERE id=?", (job.id,))
    for chat in chats:
        assert client.delete(f"/api/v1/conversations/{chat['id']}", params={"project_id": project["id"]}).status_code == 204
    assert client.get(f"/api/v1/projects/{other['id']}/trash").json() == []
    trash = client.get(f"/api/v1/projects/{project['id']}/trash").json()
    assert {entry["module"] for entry in trash} == {"concept", "bid"}
    assert next(entry for entry in trash if entry["id"] == concept["id"])["generation_count"] == 1
    assert repo.detail(job.id).status == "completed"

    restore = f"/api/v1/projects/{project['id']}/trash/conversations/{concept['id']}/restore"
    assert client.post(restore.replace(project["id"], other["id"])).status_code == 404
    assert client.post(restore).status_code == 200
    assert client.post(restore).status_code == 404
    assert len(client.get(f"/api/v1/conversations/{concept['id']}/messages").json()) == 2
    assert client.get("/api/v1/conversations", params={"project_id": project["id"], "module": "concept"}).json()[0]["id"] == concept["id"]
    assert repo.detail(job.id).status == "completed"
    assert [entry["id"] for entry in client.get(f"/api/v1/projects/{project['id']}/trash").json()] == [chats[1]["id"]]


def test_restoring_deleted_running_chat_does_not_restart_cancelled_job(tmp_path):
    client = make_client(tmp_path)
    project = client.post("/api/v1/projects", json={"name": "恢复测试"}).json()
    chat = client.post("/api/v1/conversations", json={"project_id": project["id"], "module": "concept", "title": "进行中"}).json()
    repo = JobRepository(tmp_path / "archflow.sqlite3")
    job = repo.create(GenerationJobCreate(project_id=project["id"], conversation_id=chat["id"], module="concept", goal="测试", target_units=1), str(uuid4()), SKILLS, "m", "r")
    assert client.delete(f"/api/v1/conversations/{chat['id']}", params={"project_id": project["id"]}).status_code == 204
    assert client.post(f"/api/v1/projects/{project['id']}/trash/conversations/{chat['id']}/restore").status_code == 200
    assert repo.detail(job.id).status == "cancelled"


def test_v1_database_migrates_without_losing_conversations(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as database:
        database.execute("CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, module TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        database.execute("INSERT INTO conversations VALUES('legacy','one','concept','旧对话','2026-09-28','2026-09-28')")
        database.execute("PRAGMA user_version=1")
    repo = ConversationRepository(path)
    assert repo.list_conversations("one", "concept")[0].title == "旧对话"
    repo.delete("legacy", "one")
    assert ConversationRepository(path).list_conversations("one", "concept") == []


def test_cors_allows_delete(tmp_path):
    response = make_client(tmp_path).options("/api/v1/conversations/id", headers={
        "Origin": "http://localhost:3000", "Access-Control-Request-Method": "DELETE",
    })
    assert response.status_code == 200
    assert "DELETE" in response.headers["access-control-allow-methods"]
