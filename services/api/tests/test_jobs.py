from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from archflow_api.config import Settings
from archflow_api.job_repository import JobRepository, snapshot_skills
from archflow_api.main import create_app
from archflow_api.models import AgentMemory, ArtifactUnit, DocumentPlan, GenerationJobCreate, JobCheckpoint, PlanSection, ReviewResult, UnitBatch, UsageRecord, WorkerProgress

ROOT = Path(__file__).resolve().parents[3]
SKILLS = snapshot_skills(ROOT)


def create(repo, units=8, module="concept", **kwargs):
    return repo.create(GenerationJobCreate(project_id=kwargs.pop("project_id", "test-project"), module=module, goal="确认的测试任务", target_units=units, batch_size=5, **kwargs), str(uuid4()), SKILLS, "generate-model", "review-model")


def save_plan(repo, claim):
    return repo.checkpoint(claim.job.id, claim.lease_id, JobCheckpoint(action="plan", plan=DocumentPlan(skill_slug=SKILLS[0].slug, summary="需人工批准", target_units=claim.job.target_units, sections=[PlanSection(title="项目分析", start_unit=1, end_unit=claim.job.target_units, objective="仅使用确认资料")])))


def unit_batch(start, end):
    return UnitBatch(units=[ArtifactUnit(unit_index=index, title=f"页面 {index}", body="资料完整的测试内容", evidence=["user-brief"], missing_facts=[]) for index in range(start, end + 1)])


def ready(repo, job):
    claim = repo.claim()
    save_plan(repo, claim)
    assert repo.claim() is None
    repo.control(job.id, "approve")
    claim = repo.claim()
    for start in range(1, job.target_units + 1, job.batch_size):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="storyboard", batch=unit_batch(start, min(job.target_units, start + job.batch_size - 1))))
    assert repo.detail(job.id).status == "waiting_storyboard"
    repo.control(job.id, "approve")
    return repo.claim()


@pytest.mark.parametrize("module,units", [("concept", 1), ("bid", 7), ("concept", 100), ("bid", 137), ("concept", 500)])
def test_variable_length_documents_complete_only_after_reviews(tmp_path, module, units):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, units, module=module)
    claim = ready(repo, job)
    review = ReviewResult(passed=True, summary="检查通过", issues=[])
    for batch in job.batches:
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(batch.start_unit, batch.end_unit)))
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="review", review=review))
    assert repo.detail(job.id).status == "running"
    assert repo.detail(job.id).completed_units == units
    assert repo.list(job.project_id)[0].completed_units == units
    assert repo.list(job.project_id)[0].storyboard_units == units
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="final_review", review=review))
    assert repo.detail(job.id).status == "completed"
    start = max(0, units - 5)
    assert [unit.unit_index for unit in repo.units(job.id, "draft", start, 5)] == list(range(start + 1, units + 1))


def test_idempotency_and_frozen_skills(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    request = GenerationJobCreate(project_id="one", module="bid", goal="测试", target_units=1)
    first = repo.create(request, "same", SKILLS, "m", "r")
    assert repo.create(request, "same", SKILLS, "m", "r").id == first.id
    with pytest.raises(HTTPException, match="409"):
        repo.create(request.model_copy(update={"goal": "不同"}), "same", SKILLS, "m", "r")
    assert repo.list("other") == []
    assert repo.claim().skills[0].sha256 == SKILLS[0].sha256


@pytest.mark.parametrize("module", ["concept", "bid"])
@pytest.mark.parametrize("kind", ["budget", "context", "configuration", "provider", "workflow"])
def test_failure_categories_survive_restart_without_matching_error_text(tmp_path, module, kind):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 3, module=module)
    claim = repo.claim()
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="failure", error="Unrelated diagnostic words", failure_kind=kind))
    restarted = JobRepository(repo.path)
    assert restarted.detail(job.id).failure_kind == kind
    assert restarted.list(job.project_id)[0].failure_kind == kind
    restarted.control(job.id, "retry")
    assert restarted.detail(job.id).failure_kind is None
    assert restarted.detail(job.id).total_tokens == 0


def test_failure_migration_preserves_existing_records(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 17)
    claim = repo.claim()
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="failure", error="Legacy diagnostic"))
    with repo.connect() as db:
        db.execute("ALTER TABLE generation_jobs DROP COLUMN failure_kind")
    migrated = JobRepository(repo.path).detail(job.id)
    assert migrated.failure_kind is None
    assert migrated.status == "failed"
    assert migrated.goal == job.goal
    assert migrated.target_units == 17


def test_expired_lease_resumes_saved_draft_not_generation(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 8)
    claim = ready(repo, job)
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(1, 5)))
    assert repo.claim() is None
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET lease_until=0 WHERE id=?", (job.id,))
    restarted = JobRepository(tmp_path / "db.sqlite3")
    recovered = restarted.claim()
    assert recovered.lease_id != claim.lease_id
    assert recovered.job.batches[0].draft_count == 1
    assert len(recovered.current_units) == 5
    with pytest.raises(HTTPException, match="409"):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="failure", error="old worker"))


def test_revision_limit_and_invalid_checkpoints(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 3, max_revision_rounds=1)
    claim = ready(repo, job)
    with pytest.raises(HTTPException, match="409"):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="final_review", review=ReviewResult(passed=True, summary="尚未生成", issues=[])))
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(1, 2)))
    batch = unit_batch(1, 3)
    batch.units[0].evidence = ["fabricated-regulation"]
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=batch))
    for _ in range(2):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(1, 3)))
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="review", review=ReviewResult(passed=False, summary="需补条件", issues=["条件不足"])))
    assert repo.detail(job.id).status == "needs_review"
    assert repo.detail(job.id).completed_units == 0
    with pytest.raises(HTTPException, match="409"):
        repo.control(job.id, "retry")


def test_call_budget_tokens_are_persistent_and_idempotent(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 1, max_model_calls=1)
    claim = repo.claim()
    call = UsageRecord(call_id="one", model="m", total_tokens=123)
    repo.reserve_call(job.id, claim.lease_id, call)
    repo.reserve_call(job.id, claim.lease_id, call)
    repo.usage(job.id, claim.lease_id, call)
    repo.usage(job.id, claim.lease_id, call)
    assert repo.detail(job.id).model_calls == 1
    assert repo.detail(job.id).total_tokens == 123
    with pytest.raises(HTTPException, match="409"):
        repo.reserve_call(job.id, claim.lease_id, call.model_copy(update={"call_id": "two"}))
    repo.control(job.id, "cancel")
    with pytest.raises(HTTPException, match="409"):
        repo.heartbeat(job.id, claim.lease_id)
    assert repo.detail(job.id).status == "cancelled"


def test_token_budget_and_atomic_claims(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 1, max_total_tokens=1000)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: repo.claim(), range(2)))
    assert sum(claim is not None for claim in claims) == 1
    claim = next(claim for claim in claims if claim)
    call = UsageRecord(call_id="last", model="m", total_tokens=1100)
    repo.reserve_call(job.id, claim.lease_id, call)
    repo.usage(job.id, claim.lease_id, call)
    with pytest.raises(HTTPException, match="409"):
        repo.reserve_call(job.id, claim.lease_id, call.model_copy(update={"call_id": "blocked"}))
    assert repo.detail(job.id).total_tokens == 1100  # The last in-flight call can cross the soft limit.


def test_compaction_memory_is_durable_and_lease_fenced(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo)
    claim = repo.claim()
    memory = AgentMemory(scope="plan:1-5:0", summary="Confirmed fact from source-1:page3. Reference facts are not project facts.")
    repo.progress(job.id, claim.lease_id, WorkerProgress(step="compacting"))
    repo.progress(job.id, claim.lease_id, WorkerProgress(step="continuing", memory=memory))
    repo.progress(job.id, claim.lease_id, WorkerProgress(step="continuing", memory=memory))
    assert repo.detail(job.id).progress == "资料记忆已整理，继续当前步骤"
    assert len([event for event in repo.events(job.id, 0) if event.event_type == "progress"]) == 2
    assert repo.detail(job.id).total_tokens == 0  # Progress itself cannot reset/alter billing.
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET lease_until=0 WHERE id=?", (job.id,))
    resumed = JobRepository(repo.path).claim()
    assert resumed.memory == memory
    with pytest.raises(HTTPException, match="409"):
        repo.progress(job.id, claim.lease_id, WorkerProgress(step="continuing", memory=AgentMemory(scope="other", summary="stale")))
    repo.control(job.id, "cancel")
    with pytest.raises(HTTPException, match="409"):
        repo.progress(job.id, resumed.lease_id, WorkerProgress(step="planning"))


def test_api_worker_auth_disable_and_download(tmp_path):
    settings = Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", case_upload_dir=tmp_path / "cases", database_path=tmp_path / "db.sqlite3", repository_root=ROOT, allowed_origins=(), worker_token="test-worker", agent_enabled=True)
    client = TestClient(create_app(settings))
    project = client.post("/api/v1/projects", json={"name": "测试项目"}).json()
    request = {"project_id": project["id"], "module": "concept", "goal": "测试", "target_units": 2}
    assert client.post("/internal/jobs/claim", json={}).status_code == 401
    assert client.post("/api/v1/jobs", json=request | {"project_id": "missing"}).status_code == 404
    assert client.post("/api/v1/jobs", json=request | {"module": "drawing"}).status_code == 422
    job = client.post("/api/v1/jobs", json=request, headers={"Idempotency-Key": "same"}).json()
    assert client.get(f"/api/v1/jobs/{job['id']}/download").status_code == 409
    assert client.post("/internal/jobs/claim", json={}, headers={"Authorization": "Bearer test-worker"}).json()["job"]["id"] == job["id"]
    assert client.post(f"/api/v1/jobs/{job['id']}/cancel").status_code == 200
    assert client.get(f"/api/v1/jobs/{job['id']}/download").json()["units"] == []
    assert client.get(f"/api/v1/jobs/{job['id']}/units?limit=100").status_code == 422
    disabled = TestClient(create_app(Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", database_path=tmp_path / "db.sqlite3", repository_root=ROOT, allowed_origins=())))
    assert disabled.post("/api/v1/jobs", json=request).status_code == 503


def test_conversation_history_keeps_all_confirmed_briefs(tmp_path):
    from archflow_api.conversation_repository import ConversationRepository
    from archflow_api.models import ConversationCreate

    path = tmp_path / "history.sqlite3"
    conversations = ConversationRepository(path)
    conversation = conversations.create(ConversationCreate(project_id="one", module="concept", title="历史需求"))
    repo = JobRepository(path)
    first = None
    for index in range(32):
        job = repo.create(GenerationJobCreate(project_id="one", conversation_id=conversation.id, module="concept",
            goal=f"已确认要求 {index}", target_units=10 if index == 0 else 40), str(uuid4()), SKILLS, "m", "r")
        repo.control(job.id, "cancel")
        first = first or job
    # Listing history is read-only: it cannot change current jobs or requirements.
    records = JobRepository(path).list("one", conversation.id)
    assert len(records) == 32
    assert records[-1].id == first.id
    assert records[-1].goal == "已确认要求 0"
    assert records[-1].target_units == 10
    assert records[0].target_units == 40
    assert all(record.status == "cancelled" for record in records)
    assert len(repo.list("one")) == 30  # Project overview remains bounded.
    assert repo.list("other", conversation.id) == []
    assert repo.detail(first.id).goal == first.goal


def test_revision_uses_the_newly_confirmed_budget(tmp_path):
    settings = Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", case_upload_dir=tmp_path / "cases",
        database_path=tmp_path / "db", repository_root=ROOT, allowed_origins=(), worker_token="test", agent_enabled=True)
    client = TestClient(create_app(settings))
    repo = JobRepository(settings.database_path)
    project = client.post("/api/v1/projects", json={"name": "修订项目"}).json()
    old = create(repo, 1, project_id=project["id"], max_total_tokens=500000)
    claim = ready(repo, old)
    repo.checkpoint(old.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(1, 1)))
    passed = ReviewResult(passed=True, summary="通过", issues=[])
    repo.checkpoint(old.id, claim.lease_id, JobCheckpoint(action="review", review=passed))
    repo.checkpoint(old.id, claim.lease_id, JobCheckpoint(action="final_review", review=passed))
    body = {"instruction": "修改配色", "units": [1], "max_model_calls": 100, "max_total_tokens": 200000}
    response = client.post(f"/api/v1/jobs/{old.id}/revise", json=body)
    assert response.status_code == 202
    assert response.json()["max_total_tokens"] == 200000
    assert response.json()["max_model_calls"] == 100
    assert response.json()["goal"] == old.goal
    assert response.json()["review_request"]["comments"][0]["body"] == "修改配色"
    assert response.json()["parent_id"] == old.id
    assert repo.detail(old.id).max_total_tokens == 500000
    assert client.post(f"/api/v1/jobs/{old.id}/revise", json=body | {"max_total_tokens": True}).status_code == 422
