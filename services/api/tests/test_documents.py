import json
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException

from archflow_api.materials import DocumentRepository, collect_materials
from archflow_api.models import MessageCreate, ConversationCreate, JobCheckpoint, ReviewResult
from archflow_api.conversation_repository import ConversationRepository
from test_jobs import create, ready, unit_batch, SKILLS
from archflow_api.job_repository import JobRepository


def test_generated_tool_schemas_preserve_title_fields():
    root = Path(__file__).resolve().parents[3]
    text = (root / "services/agent/src/contracts.ts").read_text()
    schemas = json.loads(text.split("export const schemas = ", 1)[1].removesuffix(";\n"))
    section = schemas["DocumentPlan"]["properties"]["sections"]["items"]
    unit = schemas["UnitBatch"]["properties"]["units"]["items"]
    assert "title" in section["properties"]
    assert "title" in unit["properties"]
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
