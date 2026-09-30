import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from archflow_api.materials import DocumentRepository, collect_materials
from archflow_api.citations import display_citations
from archflow_api.artifacts import queue_export
from archflow_api.models import ArtifactUnit, MessageCreate, ConversationCreate, JobCheckpoint, ReviewResult
from archflow_api.conversation_repository import ConversationRepository
from test_jobs import create, ready, unit_batch, SKILLS
from archflow_api.job_repository import JobRepository


def test_concept_skill_snapshot_freezes_style_tokens_and_visual_atlases(tmp_path):
    from archflow_api.job_repository import snapshot_skills
    snapshot = next(skill for skill in snapshot_skills(Path(__file__).resolve().parents[3])
                    if skill.slug == "architectural-concept-presentation")
    assert "screen169" in snapshot.files["assets/style-tokens.json"]
    assert "scripts/check_storyboard.py" in snapshot.files
    assert snapshot.images["assets/reference-atlas-campus.jpg"].startswith("/9j/")
    assert snapshot.images["assets/reference-atlas-energy.jpg"].startswith("/9j/")
    repo = JobRepository(tmp_path / "db")
    create(repo, 1)
    create(repo, 1)
    with repo.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM skill_assets").fetchone()[0] == 2
        payload = db.execute("SELECT skills FROM generation_jobs LIMIT 1").fetchone()[0]
    assert len(payload) < 150_000, "Job rows should store atlas hashes, not duplicate large images."


def test_generated_tool_schemas_preserve_title_fields():
    root = Path(__file__).resolve().parents[3]
    text = (root / "services/agent/src/contracts.ts").read_text()
    schemas = json.loads(text.split("export const schemas = ", 1)[1].removesuffix(";\n"))
    section = schemas["DocumentPlan"]["properties"]["sections"]["items"]
    unit = schemas["UnitBatch"]["properties"]["units"]["items"]
    assert "title" in section["properties"]
    assert "title" in unit["properties"]
    assert "slide_copy" in unit["properties"]
    assert "visual_plan" in unit["properties"]
    def validate(schema):
        if isinstance(schema, dict):
            if schema.get("type") == "object" and "properties" in schema:
                assert set(schema.get("required", [])) <= set(schema["properties"])
            for value in schema.values():
                validate(value)
        elif isinstance(schema, list):
            for value in schema:
                validate(value)
    validate(schemas)


def test_storyboard_copy_and_visual_plan_roundtrip_without_breaking_old_units():
    prior = ArtifactUnit(unit_index=1, title="场地", body="介绍场地条件", evidence=[], missing_facts=[])
    assert prior.slide_copy == []
    assert prior.visual_plan == ""
    planned = ArtifactUnit(unit_index=2, title="多温区物流园", body="说明空间组织", evidence=["任务书:p3"],
                           missing_facts=[], slide_copy=["多温区协同", "集中交通"], visual_plan="总图示意，标明五栋仓库与环路")
    assert ArtifactUnit.model_validate_json(planned.model_dump_json()) == planned


def test_message_retry_preserves_single_user_and_ack(tmp_path):
    repo = ConversationRepository(tmp_path / "db")
    conversation = repo.create(ConversationCreate(project_id="one", module="concept", title="新对话"))
    request = MessageCreate(content="生成 5 页设计方案", client_id="retry-key")
    first = repo.add_message(conversation.id, request)
    repo.assistant(conversation.id, "已收到", reply_to=first.id)
    second = repo.add_message(conversation.id, request)
    repo.assistant(conversation.id, "再次收到", reply_to=second.id)
    assert first.id == second.id
    assert len(repo.list_messages(conversation.id)) == 2
    assert repo.get(conversation.id).title == request.content
    with pytest.raises(HTTPException, match="409"):
        repo.add_message(conversation.id, MessageCreate(content="不同内容", client_id="retry-key"))


def test_frozen_sources_and_image_boundaries(tmp_path):
    repo = DocumentRepository(tmp_path / "db")
    folder = tmp_path / str(uuid4())
    folder.mkdir()
    (folder / "image.jpg").write_bytes(b"fixture")
    doc = {"file_id": folder.name, "name": "taskbook", "role": "source", "page_count": 1, "theme": {}, "directory": str(folder), "pages": [{"id": "file:p1", "page": 1, "text": "建筑面积 36000 平方米", "image_id": "file:image"}], "assets": [{"id": "file:image", "file": "image.jpg"}]}
    repo.snapshot("one", [doc])
    doc["pages"][0]["text"] = "本地修改"
    assert "36000" in repo.search("one", "面积")[0]["text"]
    assert repo.asset("one", "file:image") == folder / "image.jpg"
    with pytest.raises(HTTPException, match="404"):
        repo.asset("another-project", "file:image")
    assert "directory" not in repo.catalog("one")[0]


def test_export_renders_readable_citations_without_changing_stored_evidence(tmp_path):
    repo = JobRepository(tmp_path / "db")
    job = create(repo, 1)
    file_id = str(uuid4())
    source = {"file_id": file_id, "name": "设计任务书.pdf", "role": "source", "page_count": 1,
              "directory": str(tmp_path), "pages": [{"id": f"{file_id}:p1", "page": 1, "text": "规划依据"}], "assets": [], "theme": {}}
    with repo.connect() as db:
        db.execute("UPDATE job_sources SET payload=? WHERE job_id=?", (json.dumps([source]), job.id))
    claim = ready(repo, job)
    batch = unit_batch(1, 1)
    batch.units[0].body = f"证据：{file_id}:page1。"
    batch.units[0].evidence = [f"{file_id}:p1"]
    passed = ReviewResult(passed=True, summary="通过", issues=[])
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=batch))
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="review", review=passed))
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="final_review", review=passed))
    documents = DocumentRepository(repo.path)
    queue_export(repo.detail(job.id), repo, SimpleNamespace(root=tmp_path), documents)
    request = json.loads((tmp_path / job.project_id / "workspace" / "versions" / job.id / "input.json").read_text())
    assert request["units"][0]["body"] == "证据：《设计任务书.pdf》第 1 页。"
    assert request["units"][0]["evidence"] == [f"{file_id}:p1"]
    assert repo.units(job.id, "draft", 0, 1)[0].body == f"证据：{file_id}:page1。"
    assert display_citations(f"{file_id}:p1–p3", [source]) == "《设计任务书.pdf》第 1–3 页"


def test_incomplete_concept_version_cannot_export_as_a_complete_deck(tmp_path):
    from fastapi.testclient import TestClient
    from archflow_api.config import Settings
    from archflow_api.main import create_app
    repo = JobRepository(tmp_path / "db")
    job = create(repo, 40)
    claim = ready(repo, job)
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(1, 5)))
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET status='needs_review' WHERE id=?", (job.id,))
    with pytest.raises(HTTPException, match="5 / 40"):
        queue_export(repo.detail(job.id), repo, SimpleNamespace(root=tmp_path), DocumentRepository(repo.path))
    client = TestClient(create_app(Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects",
        database_path=repo.path, repository_root=Path(__file__).resolve().parents[3], allowed_origins=())))
    assert client.get(f"/api/v1/jobs/{job.id}/export").json()["status"] == "incomplete"
    assert client.get(f"/api/v1/jobs/{job.id}/export/pptx").status_code == 409
    assert client.get(f"/api/v1/jobs/{job.id}/preview/1").status_code == 409


def test_slide_preview_requires_active_lease_and_consumes_rendered_images(tmp_path):
    from fastapi.testclient import TestClient
    from archflow_api.config import Settings
    from archflow_api.main import create_app

    settings = Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", case_upload_dir=tmp_path / "cases",
        database_path=tmp_path / "db", repository_root=Path(__file__).resolve().parents[3], allowed_origins=(), worker_token="test-worker", agent_enabled=True)
    client = TestClient(create_app(settings))
    project = client.post("/api/v1/projects", json={"name": "预览项目"}).json()
    repo = JobRepository(settings.database_path)
    job = create(repo, 1, project_id=project["id"])
    claim = ready(repo, job)
    endpoint = f"/internal/jobs/{job.id}/slide-previews"
    body = {"units": [{"unit_index": 1, "title": "封面", "body": "可阅读的摘要", "evidence": ["user-brief"],
        "missing_facts": [], "slide": {"background": "FFFFFF", "elements": [{"kind": "text", "x": 1, "y": 1,
        "w": 8, "h": 1, "text": "可编辑标题", "font_size": 30}]}}]}
    auth = {"Authorization": "Bearer test-worker", "Lease-Id": claim.lease_id}
    skill_image = client.get(f"/internal/jobs/{job.id}/skill-images", params={"path": "/skills/architectural-concept-presentation/assets/reference-atlas-campus.jpg"}, headers=auth)
    assert skill_image.status_code == 200
    assert skill_image.json()["data"].startswith("/9j/")
    assert client.get(f"/internal/jobs/{job.id}/skill-images", params={"path": "/skills/architectural-concept-presentation/assets/../../secret.jpg"}, headers=auth).status_code == 404
    assert client.post(endpoint, json=body, headers={"Authorization": "Bearer test-worker"}).status_code == 422
    assert client.post(endpoint, json=body, headers=auth | {"Lease-Id": "wrong"}).status_code == 409
    assert client.post(endpoint, json={"units": [body["units"][0] | {"slide": {"elements": [{"kind": "image", "x": 1, "y": 1, "w": 4, "h": 3, "image_id": "other:image"}]}}]}, headers=auth).status_code == 422
    response = client.post(endpoint, json=body, headers=auth)
    assert response.status_code == 202
    preview_id = response.json()["preview_id"]
    folder = settings.project_dir / project["id"] / "workspace" / "previews" / job.id / preview_id
    assert json.loads((folder / "input.json").read_text())["units"][0]["slide"]["elements"][0]["text"] == "可编辑标题"
    assert client.get(f"{endpoint}/{preview_id}", headers=auth).json()["status"] == "queued"
    (folder / "page-1.jpg").write_bytes(b"preview-fixture")
    documents = DocumentRepository(settings.database_path)
    documents.finish(f"preview:{preview_id}", {"page_count": 1})
    preview = client.get(f"{endpoint}/{preview_id}", headers=auth)
    assert preview.status_code == 200
    assert preview.json()["status"] == "ready"
    assert len(preview.json()["images"]) == 1
    assert not folder.exists()
    assert client.get(f"{endpoint}/{preview_id}", headers=auth).status_code == 404


def test_material_requires_ready_or_explicit_exclusion(tmp_path):
    repo = DocumentRepository(tmp_path / "db")
    folder = tmp_path / "uploads" / str(uuid4())
    folder.mkdir(parents=True)
    (folder / "metadata.json").write_text(json.dumps({"id": folder.name, "name": "brief.pdf"}))
    repo.queue(folder.name, "material", "one", folder)
    with pytest.raises(HTTPException, match="409"):
        collect_materials(folder.parent, repo)
    repo.finish(folder.name, error="无法解析")
    (folder / "metadata.json").write_text(json.dumps({"id": folder.name, "name": "brief.pdf", "role": "excluded"}))
    assert collect_materials(folder.parent, repo) == []


def test_scoped_revision_preserves_other_units_and_reaches_final_review(tmp_path):
    repo = JobRepository(tmp_path / "db")
    old = create(repo, 8)
    claim = ready(repo, old)
    passed = ReviewResult(passed=True, summary="通过", issues=[])
    for batch in old.batches:
        repo.checkpoint(old.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(batch.start_unit, batch.end_unit)))
        repo.checkpoint(old.id, claim.lease_id, JobCheckpoint(action="review", review=passed))
    repo.checkpoint(old.id, claim.lease_id, JobCheckpoint(action="final_review", review=passed))
    from archflow_api.models import GenerationJobCreate
    new = repo.create(GenerationJobCreate(project_id=old.project_id, module=old.module, goal="修改第 3 页", target_units=8, batch_size=5), str(uuid4()), SKILLS, "m", "r", parent_id=old.id, revision_units=[3])
    claim = repo.claim()
    batch = unit_batch(1, 5)
    batch.units[0].body = "不允许修改第一页"
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(new.id, claim.lease_id, JobCheckpoint(action="draft", batch=batch))
    batch = unit_batch(1, 5)
    batch.units[2].body = "按用户要求修改"
    repo.checkpoint(new.id, claim.lease_id, JobCheckpoint(action="draft", batch=batch))
    detail = repo.checkpoint(new.id, claim.lease_id, JobCheckpoint(action="review", review=passed))
    assert detail.stage == "final_review"
    repo.checkpoint(new.id, claim.lease_id, JobCheckpoint(action="final_review", review=passed))
    assert repo.units(new.id, "draft", 0, 8)[0] == repo.units(old.id, "draft", 0, 8)[0]
    assert repo.units(new.id, "draft", 0, 8)[2].body == "按用户要求修改"


def test_budget_extension_keeps_approved_storyboard(tmp_path):
    repo = JobRepository(tmp_path / "db")
    job = create(repo, 3, max_model_calls=1)
    claim = ready(repo, job)
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="failure", error="预算用完"))
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET model_calls=1,total_tokens=250000 WHERE id=?", (job.id,))
    with pytest.raises(HTTPException, match="409"):
        repo.continue_with_budget(job.id, 1, 250000)
    resumed = repo.continue_with_budget(job.id, 20, 500000)
    assert resumed.status == "queued"
    assert resumed.stage == "generating"
    assert resumed.storyboard_units == 3
    assert resumed.model_calls == 1
    assert resumed.total_tokens == 250000


def test_resumable_jobs_cannot_freeze_a_stale_office_export():
    from types import SimpleNamespace
    from archflow_api.artifacts import queue_export
    for status in ["failed", "cancelled", "running", "waiting_outline"]:
        with pytest.raises(HTTPException, match="409"):
            queue_export(SimpleNamespace(status=status), None, None, None)
