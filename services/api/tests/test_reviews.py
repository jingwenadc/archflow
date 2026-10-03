"""Review drafts are inert; a single atomic submission creates a phase-aware revision."""
import json
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from archflow_api.config import Settings
from archflow_api.citations import display_citations
from archflow_api.job_repository import JobRepository
from archflow_api.main import create_app
from archflow_api.models import JobCheckpoint, ReviewResult
from test_jobs import ROOT, create, save_plan, ready, unit_batch


@pytest.fixture
def env(tmp_path):
    settings = Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", case_upload_dir=tmp_path / "cases",
                        database_path=tmp_path / "db", repository_root=ROOT, allowed_origins=(), worker_token="test", agent_enabled=True)
    client = TestClient(create_app(settings))
    project = client.post("/api/v1/projects", json={"name": "Independent review fixture"}).json()
    conversation = client.post("/api/v1/conversations", json={"project_id": project["id"], "module": "concept", "title": "Review"}).json()
    repo = JobRepository(settings.database_path)
    job = create(repo, 8, project_id=project["id"], conversation_id=conversation["id"])
    return client, repo, job


def comment(client, job, kind="outline", index=1, quote="仅使用确认资料", body="让这部分更清楚", key=None):
    return client.post(f"/api/v1/jobs/{job.id}/comments", headers={"Idempotency-Key": key or str(uuid4())},
                       json={"kind": kind, "body": body, "anchor": {"unit_index": index, "quote": quote}})


def feedback(client, job, **body):
    return client.post(f"/api/v1/jobs/{job.id}/feedback", headers={"Idempotency-Key": "review-submit"}, json={"kind": "outline", **body})


def complete(repo, job):
    claim = ready(repo, job)
    passed = ReviewResult(passed=True, summary="Approved", issues=[])
    for batch in job.batches:
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(batch.start_unit, batch.end_unit)))
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="review", review=passed))
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="final_review", review=passed))


def test_saving_comments_is_inert_persistent_and_idempotent(env):
    client, repo, job = env
    save_plan(repo, repo.claim())
    response = comment(client, job, key="single-comment")
    assert response.status_code == 201
    assert comment(client, job, key="single-comment").json()["id"] == response.json()["id"]
    assert comment(client, job, key="single-comment", body="Different").status_code == 409
    restored = JobRepository(repo.path)
    assert restored.detail(job.id).status == "waiting_outline"
    assert restored.detail(job.id).model_calls == 0
    assert len(restored.list(job.project_id)) == 1
    assert client.get(f"/api/v1/jobs/{job.id}/comments").json()[0]["anchor"]["quote"] == "仅使用确认资料"


def test_frozen_filename_citations_and_displayed_text_remain_annotatable(env):
    client, repo, job = env
    file_id = str(uuid4())
    source = {"file_id": file_id, "name": "设计任务书.pdf", "role": "source", "page_count": 9,
              "directory": "/unused", "pages": [], "assets": [], "theme": {}}
    with repo.connect() as db:
        db.execute("UPDATE job_sources SET payload=? WHERE job_id=?", (json.dumps([source]), job.id))
    save_plan(repo, repo.claim())
    with repo.connect() as db:
        outline = json.loads(db.execute("SELECT outline FROM generation_jobs WHERE id=?", (job.id,)).fetchone()[0])
        outline["summary"] = f"证据：{file_id}:page1、page3、page6。"
        db.execute("UPDATE generation_jobs SET outline=? WHERE id=?", (json.dumps(outline), job.id))
    sources = client.get(f"/api/v1/jobs/{job.id}/source-citations").json()
    assert sources == [{"file_id": file_id, "name": "设计任务书.pdf", "page_count": 9}]
    assert "directory" not in sources[0]
    readable = display_citations(outline["summary"], [source])
    assert readable == "证据：《设计任务书.pdf》第 1、3、6 页。"
    saved = comment(client, job, index=0, quote="《设计任务书.pdf》第 1、3、6 页").json()
    assert saved["anchor"]["quote"] == "《设计任务书.pdf》第 1、3、6 页"
    child = feedback(client, job, comment_ids=[saved["id"]]).json()
    assert child["feedback_kind"] == "outline"
    assert client.get(f"/api/v1/jobs/{child['id']}/source-citations").json() == sources


def test_single_submission_freezes_overall_and_inline_and_retains_scope(env):
    client, repo, job = env
    save_plan(repo, repo.claim())
    saved = comment(client, job).json()
    body = {"overall": "保留页数，强调设计决策", "comment_ids": [saved["id"]]}
    response = feedback(client, job, **body)
    assert response.status_code == 202, response.text
    child = response.json()
    assert child["parent_id"] == job.id and child["feedback_kind"] == "outline"
    assert child["target_units"] == job.target_units and child["goal"] == job.goal
    assert len(child["review_request"]["comments"]) == 2
    assert child["max_total_tokens"] == 100_000_000
    assert feedback(client, job, **body).json()["id"] == child["id"]
    assert len(repo.list(job.project_id)) == 2
    assert repo.detail(job.id).outline.summary == "需人工批准"
    assert client.delete(f"/api/v1/jobs/{job.id}/comments/{saved['id']}").status_code == 409
    assert client.get(f"/api/v1/jobs/{job.id}/comments").json()[0]["submitted_job_id"] == child["id"]
    assert repo.detail(child["id"]).review_request.parent_id == job.id


def test_invalid_and_stale_anchors_and_atomic_rollback(env):
    client, repo, job = env
    save_plan(repo, repo.claim())
    assert comment(client, job, index=2).status_code == 422
    assert comment(client, job, quote="Not present").status_code == 409
    assert comment(client, job, kind="draft", quote="资料完整的测试内容").status_code == 422
    assert feedback(client, job, comment_ids=["wrong-version"]).status_code == 409
    assert len(repo.list(job.project_id)) == 1
    saved = comment(client, job).json()
    with repo.connect() as db:
        outline = json.loads(db.execute("SELECT outline FROM generation_jobs WHERE id=?", (job.id,)).fetchone()[0])
        outline["sections"][0]["objective"] += " changed after selection"
        db.execute("UPDATE generation_jobs SET outline=? WHERE id=?", (json.dumps(outline), job.id))
    assert feedback(client, job, overall="Together", comment_ids=[saved["id"]]).status_code == 409
    assert len(repo.list(job.project_id)) == 1
    assert len(client.get(f"/api/v1/jobs/{job.id}/comments").json()) == 1
    assert client.get(f"/api/v1/jobs/{job.id}/comments").json()[0]["submitted_job_id"] is None


def test_running_job_accepts_saved_comments_but_not_revision(env):
    client, repo, job = env
    complete(repo, job)
    saved = comment(client, job, kind="draft", quote="资料完整的测试内容").json()
    response = feedback(client, job, kind="draft", comment_ids=[saved["id"]])
    assert response.status_code == 202
    assert feedback(client, job, overall="Another submission").status_code == 409
    # The older completed version remains annotatable while its child runs.
    assert comment(client, job, kind="draft", quote="资料完整的测试内容").status_code == 201


def test_pending_comment_delete_does_not_touch_artifact(env):
    client, repo, job = env
    save_plan(repo, repo.claim())
    saved = comment(client, job).json()
    assert client.delete(f"/api/v1/jobs/{job.id}/comments/{saved['id']}").status_code == 204
    assert client.get(f"/api/v1/jobs/{job.id}/comments").json() == []
    assert repo.detail(job.id).outline.sections[0].objective == "仅使用确认资料"


def test_inline_outline_preserves_uncommented_summary(env):
    client, repo, job = env
    save_plan(repo, repo.claim())
    saved = comment(client, job).json()
    child = feedback(client, job, comment_ids=[saved["id"]]).json()
    claim = repo.claim()
    plan = repo.detail(job.id).outline.model_copy(deep=True)
    plan.sections[0].objective = "Revision applied"
    invalid = plan.model_copy(update={"summary": "Unauthorized change"})
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="plan", plan=invalid))
    revised = repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="plan", plan=plan))
    assert revised.status == "waiting_outline"
    assert repo.detail(job.id).outline.sections[0].objective == "仅使用确认资料"


def test_storyboard_revision_fills_holes_not_count_plus_one(env):
    client, repo, job = env
    complete(repo, job)
    saved = [comment(client, job, kind="storyboard", index=index, quote="资料完整的测试内容").json()["id"] for index in [2, 7]]
    child = feedback(client, job, kind="storyboard", comment_ids=saved).json()
    assert child["storyboard_units"] == 6
    assert child["storyboard_range"] == [2, 2]
    claim = repo.claim()
    first = repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="storyboard", batch=unit_batch(2, 2)))
    assert first.storyboard_range == [7, 7]
    last = repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="storyboard", batch=unit_batch(7, 7)))
    assert last.status == "waiting_storyboard"
    assert repo.units(child["id"], "storyboard", 2, 1) == repo.units(job.id, "storyboard", 2, 1)
    repo.control(child["id"], "approve")
    assert repo.documents.revisions(child["id"]) == []


def test_draft_inline_preserves_other_units_and_requires_new_approval(env):
    client, repo, job = env
    complete(repo, job)
    saved = comment(client, job, kind="draft", index=2, quote="资料完整的测试内容").json()
    child = feedback(client, job, kind="draft", comment_ids=[saved["id"]]).json()
    previous_url = f"/internal/jobs/{child['id']}/review-units?kind=draft&offset=1&limit=1"
    assert client.get(previous_url).status_code == 401
    previous = client.get(previous_url, headers={"Authorization": "Bearer test"})
    assert previous.status_code == 200 and previous.json()[0]["unit_index"] == 2
    assert previous.json()[0]["body"] == "资料完整的测试内容"
    assert child["stage"] == "generating" and child["completed_units"] == 3
    claim = repo.claim()
    batch = unit_batch(1, 5)
    batch.units[0].body = "Unauthorized edit"
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="draft", batch=batch))
    batch.units[0].body = "资料完整的测试内容"
    batch.units[1].body = "Tailored revision"
    repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="draft", batch=batch))
    passed = ReviewResult(passed=True, summary="Feedback applied", issues=[])
    repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="review", review=passed))
    result = repo.checkpoint(child["id"], claim.lease_id, JobCheckpoint(action="final_review", review=passed))
    assert result.status == "waiting_review"
    assert repo.claim() is None
    assert client.get(f"/api/v1/jobs/{child['id']}/export").json()["requested"] is False
    assert client.post(f"/api/v1/jobs/{child['id']}/approve").json()["status"] == "completed"
    assert client.get(f"/api/v1/jobs/{child['id']}/export").json()["requested"] is True
    assert repo.units(job.id, "draft", 1, 1)[0].body == "资料完整的测试内容"


def test_mixed_phase_feedback_uses_one_submission_and_earliest_phase(env):
    client, repo, job = env
    complete(repo, job)
    ids = [comment(client, job).json()["id"], comment(client, job, kind="draft", index=4, quote="资料完整的测试内容").json()["id"]]
    response = feedback(client, job, kind="draft", overall="正文减少重复", comment_ids=ids)
    assert response.status_code == 202, response.text
    child = response.json()
    assert child["feedback_kind"] == "outline" and child["stage"] == "planning"
    assert len(child["review_request"]["comments"]) == 3
    assert {item["kind"] for item in child["review_request"]["comments"]} == {"outline", "draft"}


def test_deleted_conversation_cannot_start_revision(env):
    client, repo, job = env
    save_plan(repo, repo.claim())
    saved = comment(client, job).json()
    assert client.delete(f"/api/v1/conversations/{job.conversation_id}?project_id={job.project_id}").status_code == 204
    assert feedback(client, job, comment_ids=[saved["id"]]).status_code == 404
    assert len(repo.list(job.project_id)) == 1
