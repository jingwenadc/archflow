from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from archflow_api.config import Settings
from archflow_api.main import create_app
from archflow_api.models import GenerationJobCreate, RunLimits, JobCheckpoint, DocumentPlan, PlanSection
from archflow_api.job_repository import JobRepository, snapshot_skills
from archflow_api.requirements import requested_unit_count
from archflow_api.run_settings import RunSettingsRepository

ROOT = Path(__file__).resolve().parents[3]
SKILLS = snapshot_skills(ROOT)


@pytest.mark.parametrize("text,module,count", [
    ("10页太少，改成40页", "concept", 40), ("制作100页", "concept", 100),
    ("做40页，修改第10页", "concept", 40), ("做40页，不要10页", "concept", 40),
    ("修改第 10 页", "concept", None), ("修改3-5页", "concept", None), ("第3至5页", "concept", None),
    ("Create 27 slides", "concept", 27), ("Prepare 135 pages, not 10 pages", "concept", 135),
    ("编制100页投标文件", "bid", None), ("修改第 7 章", "bid", None),
    ("Prepare 47 chapters", "bid", 47), ("做600页", "concept", 600),
])
def test_shared_count_resolution(text, module, count):
    assert requested_unit_count(text, module) == count


def test_every_supported_length():
    for count in range(1, 501):
        assert requested_unit_count(f"制作{count}页", "concept") == count
        assert requested_unit_count(f"Create {count} slides", "concept") == count
        assert requested_unit_count(f"编制{count}章节", "bid") == count


@pytest.mark.parametrize("module,goal,target", [("concept", "制作57页", 57), ("bid", "编制23章", 23)])
def test_scope_contract_rejects_conflict_and_preserves_explicit_override(module, goal, target):
    with pytest.raises(ValidationError):
        GenerationJobCreate(project_id="independent", module=module, goal=goal, target_units=10)
    manual = GenerationJobCreate(project_id="independent", module=module, goal=goal, target_units=10, count_override=True)
    assert manual.target_units == 10
    automatic = GenerationJobCreate(project_id="independent", module=module, goal=goal, target_units=target)
    assert automatic.target_units == target


def client(tmp_path):
    return TestClient(create_app(Settings(upload_dir=tmp_path / "uploads", allowed_origins=("http://localhost:3000",),
        project_dir=tmp_path / "projects", database_path=tmp_path / "db", case_upload_dir=tmp_path / "cases",
        repository_root=ROOT, agent_enabled=True, worker_token="test-only")))


def test_settings_are_persistent_shared_defaults_not_job_control(tmp_path):
    api = client(tmp_path)
    defaults = api.get("/api/v1/settings/run-limits").json()
    assert defaults == {"max_model_calls": 20_000, "max_total_tokens": 100_000_000}
    changed = {"max_model_calls": 30_000, "max_total_tokens": 200_000_000}
    assert api.post("/api/v1/settings/run-limits", json=changed).status_code == 200
    assert client(tmp_path).get("/api/v1/settings/run-limits").json() == changed
    project = api.post("/api/v1/projects", json={"name": "独立项目"}).json()
    job = api.post("/api/v1/jobs", json={"project_id": project["id"], "module": "concept", "goal": "制作57页", "target_units": 57}).json()
    assert job["max_total_tokens"] == changed["max_total_tokens"]
    assert job["max_model_calls"] == changed["max_model_calls"]
    assert api.post("/api/v1/settings/run-limits", json=defaults).status_code == 200
    unchanged = api.get(f'/api/v1/jobs/{job["id"]}').json()
    assert unchanged["max_total_tokens"] == changed["max_total_tokens"]
    assert unchanged["model_calls"] == 0
    assert api.post("/api/v1/settings/run-limits", json={"max_model_calls": True}).status_code == 422
    assert api.post(f'/api/v1/jobs/{job["id"]}/continue', json={}).status_code == 422, "Continuation must explicitly supply limits"


def test_resolver_preserves_manual_scope_until_new_explicit_length(tmp_path):
    api = client(tmp_path)
    base = "制作57页，已手动确认20页"
    result = api.post("/api/v1/requirements/resolve", json={"module": "concept", "goal": base + "\n修改第3页配色", "base_goal": base, "fallback_units": 20}).json()
    assert result["target_units"] == 20
    assert api.post("/api/v1/requirements/resolve", json={"module": "concept", "goal": "制作57页", "fallback_units": 10}).json()["target_units"] == 57
    assert api.post("/api/v1/requirements/resolve", json={"module": "concept", "goal": base + "\n增加到83页", "base_goal": base, "fallback_units": 20}).json()["target_units"] == 83


def test_legacy_conflict_is_readable_but_cannot_resume_or_approve(tmp_path):
    repo = JobRepository(tmp_path / "db")
    job = repo.create(GenerationJobCreate(project_id="any", module="concept", goal="制作57页", target_units=57), str(uuid4()), SKILLS, "m", "r")
    # Simulate an old release's inconsistent record, never a special project/job ID.
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET target_units=10,status='failed',stage='storyboarding',total_tokens=300000 WHERE id=?", (job.id,))
    assert repo.detail(job.id).scope_mismatch
    assert repo.list("any")[0].scope_mismatch
    for operation in [lambda: repo.control(job.id, "retry"), lambda: repo.control(job.id, "approve"), lambda: repo.continue_with_budget(job.id, 30000, 100000000)]:
        with pytest.raises(HTTPException, match="409"):
            operation()
    assert repo.detail(job.id).total_tokens == 300000
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET status='queued' WHERE id=?", (job.id,))
    assert repo.claim() is None
    assert repo.detail(job.id).status == "failed"
    assert repo.control(job.id, "cancel").status == "cancelled"


def test_plan_scope_is_pages_not_section_count(tmp_path):
    repo = JobRepository(tmp_path / "db")
    job = repo.create(GenerationJobCreate(project_id="any", module="concept", goal="制作57页", target_units=57), str(uuid4()), SKILLS, "m", "r")
    claim = repo.claim()
    sections = [PlanSection(title="一", start_unit=1, end_unit=17, objective="资料与分析"), PlanSection(title="二", start_unit=18, end_unit=57, objective="设计方案")]
    plan = DocumentPlan(skill_slug=SKILLS[0].slug, summary="整体提纲", target_units=2, sections=sections)
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="plan", plan=plan))
    with pytest.raises(HTTPException, match="422"):
        repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="plan", plan=plan.model_copy(update={"target_units": 57, "summary": "建议制作70页"})))
    result = repo.checkpoint(job.id, claim.lease_id, JobCheckpoint(action="plan", plan=plan.model_copy(update={"target_units": 57})))
    assert result.target_units == 57
    assert len(result.outline.sections) == 2
    assert result.status == "waiting_outline"


def test_resume_accepts_same_high_settings_contract_and_preserves_usage(tmp_path):
    repo = JobRepository(tmp_path / "db")
    job = repo.create(GenerationJobCreate(project_id="any", module="bid", goal="编制23章", target_units=23, max_total_tokens=1000), str(uuid4()), SKILLS, "m", "r")
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET status='failed',total_tokens=1100,model_calls=2 WHERE id=?", (job.id,))
    limits = RunSettingsRepository(tmp_path / "db").get()
    continued = repo.continue_with_budget(job.id, **{"calls": limits.max_model_calls, "tokens": limits.max_total_tokens})
    assert continued.total_tokens == 1100
    assert continued.model_calls == 2
    assert continued.stage == "planning"
    assert continued.max_total_tokens == 100_000_000


def test_legacy_plan_adapts_count_without_rewriting_and_flags_conflicting_narrative(tmp_path):
    import json
    repo = JobRepository(tmp_path / "db")
    job = repo.create(GenerationJobCreate(project_id="any", module="concept", goal="项目汇报", target_units=37), str(uuid4()), SKILLS, "m", "r")
    old_plan = {"skill_slug": SKILLS[0].slug, "summary": "项目设计策略", "sections": [{"title": "方案", "start_unit": 1, "end_unit": 37, "objective": "项目分析与设计"}]}
    with repo.connect() as db:
        db.execute("UPDATE generation_jobs SET outline=?,status='waiting_outline' WHERE id=?", (json.dumps(old_plan), job.id))
    assert repo.detail(job.id).outline.target_units == 37
    assert not repo.detail(job.id).scope_mismatch
    with repo.connect() as db:
        assert "target_units" not in json.loads(db.execute("SELECT outline FROM generation_jobs WHERE id=?", (job.id,)).fetchone()[0])
        old_plan["summary"] = "建议制作71页"
        db.execute("UPDATE generation_jobs SET outline=? WHERE id=?", (json.dumps(old_plan), job.id))
    assert repo.detail(job.id).scope_mismatch
    assert repo.list("any")[0].scope_mismatch
    with pytest.raises(HTTPException, match="409"):
        repo.control(job.id, "approve")
