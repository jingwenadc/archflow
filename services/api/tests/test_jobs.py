from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from archflow_api.config import Settings
from archflow_api.job_repository import JobRepository, snapshot_skills
from archflow_api.main import create_app
from archflow_api.models import ArtifactUnit, DocumentPlan, GenerationJobCreate, JobCheckpoint, PlanSection, ReviewResult, UnitBatch, UsageRecord

ROOT = Path(__file__).resolve().parents[3]
SKILLS = snapshot_skills(ROOT)


def create(repo, units=8, module="concept", **kwargs):
    return repo.create(GenerationJobCreate(project_id="cold-chain-industrial-park", module=module, goal="确认的测试任务", target_units=units, batch_size=5, **kwargs), str(uuid4()), SKILLS, "generate-model", "review-model")


def save_plan(repo, claim):
    return repo.checkpoint(claim.job.id, claim.lease_id, JobCheckpoint(action="plan", plan=DocumentPlan(skill_slug=SKILLS[0].slug, summary="需人工批准", sections=[PlanSection(title="项目分析", start_unit=1, end_unit=claim.job.target_units, objective="仅使用确认资料")])))


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


@pytest.mark.parametrize("module", ["concept", "bid"])
def test_hundred_units_complete_only_after_reviews(tmp_path, module):
    repo = JobRepository(tmp_path / "db.sqlite3")
    job = create(repo, 100, module=module)
    claim = ready(repo, job)
    review = ReviewResult(passed=True, summary="检查通过", issues=[])
    for batch in job.batches:
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="draft", batch=unit_batch(batch.start_unit, batch.end_unit)))
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="review", review=review))
    assert repo.detail(job.id).status == "running"
    assert repo.detail(job.id).completed_units == 100
    repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="final_review", review=review))
    assert repo.detail(job.id).status == "completed"
    assert [unit.unit_index for unit in repo.units(job.id, "draft", 95, 5)] == list(range(96, 101))


def test_idempotency_and_frozen_skills(tmp_path):
    repo = JobRepository(tmp_path / "db.sqlite3")
    request = GenerationJobCreate(project_id="one", module="bid", goal="测试", target_units=1)
    first = repo.create(request, "same", SKILLS, "m", "r")
    assert repo.create(request, "same", SKILLS, "m", "r").id == first.id
    with pytest.raises(HTTPException, match="409"):
        repo.create(request.model_copy(update={"goal": "不同"}), "same", SKILLS, "m", "r")
    assert repo.list("other") == []
    assert repo.claim().skills[0].sha256 == SKILLS[0].sha256


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


def test_api_worker_auth_disable_and_download(tmp_path):
    settings = Settings(upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects", case_upload_dir=tmp_path / "cases", database_path=tmp_path / "db.sqlite3", repository_root=ROOT, allowed_origins=(), worker_token="test-worker", agent_enabled=True)
    client = TestClient(create_app(settings))
    request = {"project_id": "cold-chain-industrial-park", "module": "concept", "goal": "测试", "target_units": 2}
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
