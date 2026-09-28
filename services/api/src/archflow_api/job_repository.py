"""Single-server durable jobs. No model calls or long transactions live here."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from datetime import UTC, datetime
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import yaml
from fastapi import HTTPException

from .models import (
    ArtifactUnit, ClaimedJob, DocumentPlan, GenerationBatchRecord, GenerationJobCreate,
    GenerationJobDetail, GenerationJobEvent, GenerationJobRecord, JobCheckpoint,
    ReviewResult, SkillSnapshot, UsageRecord,
)
from .materials import DocumentRepository


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def snapshot_skills(repository_root: Path) -> list[SkillSnapshot]:
    """Freeze reviewed instruction files; do not expose arbitrary filesystem paths."""
    root = (repository_root / "skills").resolve()
    snapshots = []
    for manifest in sorted(root.glob("*/SKILL.md")):
        directory = manifest.parent.resolve()
        if not directory.is_relative_to(root) or not manifest.resolve().is_relative_to(directory):
            continue
        text = manifest.read_text("utf-8")
        parts = text.split("---", 2)
        metadata = yaml.safe_load(parts[1]) if len(parts) == 3 else {}
        if not isinstance(metadata, dict) or not metadata.get("description"):
            continue
        files = {}
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path.suffix.lower() in {".md", ".txt"}:
                if not path.resolve().is_relative_to(directory):
                    continue
                if path.stat().st_size > 512 * 1024:
                    raise HTTPException(422, "Skill instruction file exceeds snapshot limit.")
                files[path.relative_to(directory).as_posix()] = path.read_text("utf-8")
        serialized = json.dumps(files, ensure_ascii=False, sort_keys=True)
        if len(serialized.encode()) > 2 * 1024 * 1024:
            raise HTTPException(422, "Skill snapshot exceeds 2 MB limit.")
        snapshots.append(SkillSnapshot(
            slug=directory.name, description=str(metadata["description"]),
            sha256=hashlib.sha256(serialized.encode()).hexdigest(), files=files,
        ))
    if not snapshots:
        raise HTTPException(503, "No readable skills are configured.")
    return snapshots


class JobRepository:
    def __init__(self, database_path: Path) -> None:
        self.path = database_path
        self.documents = DocumentRepository(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS generation_jobs (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT,
                    module TEXT NOT NULL, goal TEXT NOT NULL, target_units INTEGER NOT NULL,
                    batch_size INTEGER NOT NULL, max_revision_rounds INTEGER NOT NULL,
                    max_model_calls INTEGER NOT NULL, max_total_tokens INTEGER NOT NULL,
                    model TEXT NOT NULL, review_model TEXT NOT NULL,
                    status TEXT NOT NULL, stage TEXT NOT NULL,
                    outline TEXT, skills TEXT NOT NULL, final_review TEXT, error TEXT,
                    model_calls INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                    lease_id TEXT, lease_until REAL,
                    UNIQUE(project_id, idempotency_key)
                );
                CREATE TABLE IF NOT EXISTS generation_batches (
                    job_id TEXT NOT NULL REFERENCES generation_jobs(id), batch_index INTEGER NOT NULL,
                    start_unit INTEGER NOT NULL, end_unit INTEGER NOT NULL, status TEXT NOT NULL,
                    draft_count INTEGER NOT NULL DEFAULT 0, review TEXT,
                    PRIMARY KEY(job_id, batch_index)
                );
                CREATE TABLE IF NOT EXISTS generation_units (
                    job_id TEXT NOT NULL REFERENCES generation_jobs(id), kind TEXT NOT NULL,
                    unit_index INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(job_id, kind, unit_index)
                );
                CREATE TABLE IF NOT EXISTS generation_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES generation_jobs(id),
                    event_type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS generation_calls (
                    job_id TEXT NOT NULL REFERENCES generation_jobs(id), call_id TEXT NOT NULL,
                    model TEXT NOT NULL, total_tokens INTEGER,
                    PRIMARY KEY(job_id, call_id)
                );
                CREATE INDEX IF NOT EXISTS generation_queue_idx ON generation_jobs(status, lease_until, created_at);
                CREATE INDEX IF NOT EXISTS generation_project_idx ON generation_jobs(project_id, created_at DESC);
            """)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def require(db: sqlite3.Connection, job_id: str) -> sqlite3.Row:
        row = db.execute("SELECT * FROM generation_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Generation job not found.")
        return row

    def leased(self, db: sqlite3.Connection, job_id: str, lease_id: str) -> sqlite3.Row:
        row = self.require(db, job_id)
        if row["status"] != "running" or row["lease_id"] != lease_id or row["lease_until"] < time.time():
            raise HTTPException(409, "Job cancelled or worker lease expired.")
        return row

    @staticmethod
    def event(db: sqlite3.Connection, job_id: str, kind: str, message: str) -> None:
        db.execute("INSERT INTO generation_events(job_id,event_type,message,created_at) VALUES(?,?,?,?)",
                   (job_id, kind, message, timestamp()))

    def create(self, request: GenerationJobCreate, key: str, skills: list[SkillSnapshot],
               model: str, review_model: str, sources: list[dict] | None = None,
               parent_id: str | None = None, revision_units: list[int] | None = None) -> GenerationJobDetail:
        fingerprint = hashlib.sha256((request.model_dump_json() + str(parent_id) + str(revision_units)).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT id,request_hash FROM generation_jobs WHERE project_id=? AND idempotency_key=?",
                                  (request.project_id, key)).fetchone()
            if previous:
                if previous["request_hash"] != fingerprint:
                    raise HTTPException(409, "Idempotency key was already used for a different request.")
                return self.detail(previous["id"])
            job_id = str(uuid4())
            values = request.model_dump() | {
                "id": job_id, "model": model, "review_model": review_model,
                "status": "queued", "stage": "planning", "created_at": timestamp(),
                "updated_at": timestamp(), "idempotency_key": key, "request_hash": fingerprint,
                "skills": json.dumps([skill.model_dump() for skill in skills], ensure_ascii=False),
            }
            columns = ",".join(values)
            placeholders = ",".join("?" for _ in values)
            db.execute(f"INSERT INTO generation_jobs({columns}) VALUES({placeholders})", tuple(values.values()))
            db.execute("INSERT INTO job_sources VALUES(?,?,?,?)", (job_id, json.dumps(sources or [], ensure_ascii=False), parent_id, json.dumps(revision_units or [])))
            for index, start in enumerate(range(1, request.target_units + 1, request.batch_size)):
                db.execute("INSERT INTO generation_batches(job_id,batch_index,start_unit,end_unit,status) VALUES(?,?,?,?,?)",
                           (job_id, index, start, min(request.target_units, start + request.batch_size - 1), "pending"))
            if parent_id:
                parent = self.require(db, parent_id)
                db.execute("UPDATE generation_jobs SET stage='generating',outline=? WHERE id=?", (parent["outline"], job_id))
                db.execute("INSERT INTO generation_units SELECT ?,kind,unit_index,payload FROM generation_units WHERE job_id=?", (job_id, parent_id))
                for batch in db.execute("SELECT * FROM generation_batches WHERE job_id=?", (job_id,)).fetchall():
                    if not any(batch["start_unit"] <= i <= batch["end_unit"] for i in revision_units or []):
                        db.execute("UPDATE generation_batches SET status='completed',review=? WHERE job_id=? AND batch_index=?",
                                   (json.dumps({"passed": True, "summary": "沿用未修改页面", "issues": []}), job_id, batch["batch_index"]))
            self.event(db, job_id, "queued", "任务已排队；产物为内容草稿。")
        return self.detail(job_id)

    def detail(self, job_id: str) -> GenerationJobDetail:
        with self.connect() as db:
            db.execute("BEGIN")
            row = dict(self.require(db, job_id))
            batches = [GenerationBatchRecord(**(dict(batch) | {
                "review": json.loads(batch["review"]) if batch["review"] else None,
            })) for batch in db.execute("SELECT * FROM generation_batches WHERE job_id=? ORDER BY batch_index", (job_id,))]
            storyboard_count = db.execute("SELECT count(*) FROM generation_units WHERE job_id=? AND kind='storyboard'", (job_id,)).fetchone()[0]
        completed = sum(batch.end_unit - batch.start_unit + 1 for batch in batches if batch.status == "completed")
        return GenerationJobDetail(**(row | {
            "completed_units": completed, "storyboard_units": storyboard_count, "batches": batches,
            "outline": json.loads(row["outline"]) if row["outline"] else None,
            "final_review": json.loads(row["final_review"]) if row["final_review"] else None,
        }))

    def list(self, project_id: str, conversation_id: str | None = None) -> list[GenerationJobRecord]:
        with self.connect() as db:
            sql = "SELECT id FROM generation_jobs WHERE project_id=?"
            args: list = [project_id]
            if conversation_id:
                sql += " AND conversation_id=?"
                args.append(conversation_id)
            rows = db.execute(sql + " ORDER BY created_at DESC LIMIT 30", args).fetchall()
        return [GenerationJobRecord(**self.detail(row["id"]).model_dump()) for row in rows]

    def units(self, job_id: str, kind: str, offset: int, limit: int) -> list[ArtifactUnit]:
        with self.connect() as db:
            self.require(db, job_id)
            rows = db.execute("SELECT payload FROM generation_units WHERE job_id=? AND kind=? ORDER BY unit_index LIMIT ? OFFSET ?",
                              (job_id, kind, limit, offset)).fetchall()
        return [ArtifactUnit.model_validate_json(row[0]) for row in rows]

    def events(self, job_id: str, after: int) -> list[GenerationJobEvent]:
        with self.connect() as db:
            self.require(db, job_id)
            return [GenerationJobEvent(**dict(row)) for row in db.execute(
                "SELECT * FROM generation_events WHERE job_id=? AND id>? ORDER BY id LIMIT 100", (job_id, after))]

    def claim(self) -> ClaimedJob | None:
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM generation_jobs WHERE status='queued' OR (status='running' AND lease_until<?) ORDER BY created_at LIMIT 1", (now,)).fetchone()
            if row is None:
                return None
            lease_id = str(uuid4())
            db.execute("UPDATE generation_jobs SET status='running',lease_id=?,lease_until=?,updated_at=? WHERE id=?",
                       (lease_id, now + 90, timestamp(), row["id"]))
            self.event(db, row["id"], "running", "Worker 已领取任务，从已保存的检查点继续。")
            skills = [SkillSnapshot(**item) for item in json.loads(row["skills"])]
        detail = self.detail(row["id"])
        batch = next((item for item in detail.batches if item.status != "completed"), None)
        current = self.units(detail.id, "draft", batch.start_unit - 1, batch.end_unit - batch.start_unit + 1) if batch and batch.status == "draft" else []
        return ClaimedJob(job=detail, lease_id=lease_id, skills=skills, current_units=current,
                          sources=self.documents.catalog(detail.id), revision_units=self.documents.revisions(detail.id))

    def heartbeat(self, job_id: str, lease_id: str) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.leased(db, job_id, lease_id)
            db.execute("UPDATE generation_jobs SET lease_until=? WHERE id=?", (time.time() + 90, job_id))

    def control(self, job_id: str, action: str) -> GenerationJobDetail:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.require(db, job_id)
            if action == "cancel":
                if row["status"] in {"completed", "cancelled"}:
                    return self.detail(job_id)
                new_status, stage = "cancelled", row["stage"]
            elif action == "approve":
                stages = {"waiting_outline": "storyboarding", "waiting_storyboard": "generating"}
                if row["status"] not in stages:
                    raise HTTPException(409, "This job is not waiting for approval.")
                new_status, stage = "queued", stages[row["status"]]
            elif action == "retry":
                if row["status"] != "failed":
                    raise HTTPException(409, "Only failed jobs can be retried; review failures need human changes.")
                if row["model_calls"] >= row["max_model_calls"] or row["total_tokens"] >= row["max_total_tokens"]:
                    raise HTTPException(409, "Job budget exhausted. Create a new job with a revised budget.")
                new_status, stage = "queued", row["stage"]
            else:
                raise HTTPException(422, "Unknown job action.")
            db.execute("UPDATE generation_jobs SET status=?,stage=?,error=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=?",
                       (new_status, stage, timestamp(), job_id))
            self.event(db, job_id, action, {"cancel": "任务已取消；已保存内容仍可查看。", "approve": "用户批准了当前计划和下一阶段范围。", "retry": "任务重新排队，将保留已有内容与用量。"}[action])
        return self.detail(job_id)

    def continue_with_budget(self, job_id: str, calls: int, tokens: int) -> GenerationJobDetail:
        if type(calls) is not int or type(tokens) is not int or not 1 <= calls <= 1000 or not 1000 <= tokens <= 10_000_000:
            raise HTTPException(422, "上限范围：1–1000 次调用，1000–10000000 累计 tokens。")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.require(db, job_id)
            if row["status"] != "failed" or calls <= row["model_calls"] or tokens <= row["total_tokens"]:
                raise HTTPException(409, "只能继续失败任务，且批准的总上限必须高于已用量。")
            db.execute("UPDATE generation_jobs SET max_model_calls=?,max_total_tokens=?,status='queued',error=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=?", (calls, tokens, timestamp(), job_id))
            self.event(db, job_id, "retry", "用户明确批准新的总调用/token 上限，保留检查点继续。")
        return self.detail(job_id)

    def reserve_call(self, job_id: str, lease_id: str, usage: UsageRecord) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.leased(db, job_id, lease_id)
            if db.execute("SELECT 1 FROM generation_calls WHERE job_id=? AND call_id=?", (job_id, usage.call_id)).fetchone():
                return
            if row["model_calls"] >= row["max_model_calls"] or row["total_tokens"] >= row["max_total_tokens"]:
                raise HTTPException(409, "Model call or token budget exhausted.")
            db.execute("INSERT INTO generation_calls(job_id,call_id,model) VALUES(?,?,?)", (job_id, usage.call_id, usage.model))
            db.execute("UPDATE generation_jobs SET model_calls=model_calls+1 WHERE id=?", (job_id,))

    def usage(self, job_id: str, lease_id: str, usage: UsageRecord) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.leased(db, job_id, lease_id)
            call = db.execute("SELECT total_tokens FROM generation_calls WHERE job_id=? AND call_id=?", (job_id, usage.call_id)).fetchone()
            if call is None:
                raise HTTPException(409, "Model call was not reserved.")
            if call[0] is None:
                db.execute("UPDATE generation_calls SET total_tokens=? WHERE job_id=? AND call_id=?", (usage.total_tokens, job_id, usage.call_id))
                db.execute("UPDATE generation_jobs SET total_tokens=total_tokens+? WHERE id=?", (usage.total_tokens, job_id))

    def checkpoint(self, job_id: str, lease_id: str, checkpoint: JobCheckpoint) -> GenerationJobDetail:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.leased(db, job_id, lease_id)
            state, stage = "running", row["stage"]
            batch = db.execute("SELECT * FROM generation_batches WHERE job_id=? AND status!='completed' ORDER BY batch_index LIMIT 1", (job_id,)).fetchone()
            if checkpoint.action == "failure":
                if not checkpoint.error:
                    raise HTTPException(422, "Failure requires an error.")
                state = "failed"
                db.execute("UPDATE generation_jobs SET error=? WHERE id=?", (checkpoint.error, job_id))
            elif checkpoint.action == "plan":
                if stage != "planning" or checkpoint.plan is None:
                    raise HTTPException(409, "Job is not planning.")
                plan = checkpoint.plan
                slugs = {skill["slug"] for skill in json.loads(row["skills"])}
                if plan.skill_slug not in slugs:
                    raise HTTPException(422, "Select a skill from this job's catalog.")
                expected = 1
                for section in plan.sections:
                    if section.start_unit != expected or section.end_unit < section.start_unit:
                        raise HTTPException(422, "Plan must cover every unit once, in order.")
                    expected = section.end_unit + 1
                if expected != row["target_units"] + 1:
                    raise HTTPException(422, "Plan must match the requested target.")
                db.execute("UPDATE generation_jobs SET outline=? WHERE id=?", (plan.model_dump_json(), job_id))
                state = "waiting_outline"
            elif checkpoint.action in {"storyboard", "draft"}:
                expected_stage = "storyboarding" if checkpoint.action == "storyboard" else "generating"
                if stage != expected_stage or checkpoint.batch is None:
                    raise HTTPException(409, "Batch is not allowed at the current stage.")
                kind = "storyboard" if stage == "storyboarding" else "draft"
                if kind == "storyboard":
                    start = db.execute("SELECT count(*)+1 FROM generation_units WHERE job_id=? AND kind='storyboard'", (job_id,)).fetchone()[0]
                    end = min(row["target_units"], start + row["batch_size"] - 1)
                else:
                    if batch is None or batch["draft_count"] >= row["max_revision_rounds"] + 1:
                        raise HTTPException(409, "Batch revision budget exhausted.")
                    if batch["status"] == "draft" and batch["review"] is None:
                        raise HTTPException(409, "Review the saved draft before revising it.")
                    start, end = batch["start_unit"], batch["end_unit"]
                units = checkpoint.batch.units
                if [unit.unit_index for unit in units] != list(range(start, end + 1)):
                    raise HTTPException(422, f"Batch must contain exactly units {start}–{end} in order.")
                for unit in units:
                    if not unit.title.strip() or not unit.body.strip():
                        raise HTTPException(422, "Artifact content cannot be blank.")
                    sources = self.documents.sources(job_id)
                    allowed = {"user-brief"} | {page["id"] for doc in sources for page in doc["pages"]}
                    if any(source not in allowed for source in unit.evidence):
                        raise HTTPException(422, "Evidence must cite this job's frozen source page IDs.")
                    if unit.image_id and unit.image_id not in {asset["id"] for doc in sources for asset in doc["assets"]}:
                        raise HTTPException(422, "Image does not belong to this project snapshot.")
                    revision_units = self.documents.revisions(job_id)
                    if kind == "draft" and revision_units and unit.unit_index not in revision_units:
                        old = db.execute("SELECT payload FROM generation_units WHERE job_id=? AND kind='draft' AND unit_index=?", (job_id, unit.unit_index)).fetchone()
                        if old and ArtifactUnit.model_validate_json(old[0]) != unit:
                            raise HTTPException(422, "A scoped revision must preserve all pages outside the authorized range.")
                    db.execute("INSERT INTO generation_units(job_id,kind,unit_index,payload) VALUES(?,?,?,?) ON CONFLICT(job_id,kind,unit_index) DO UPDATE SET payload=excluded.payload",
                               (job_id, kind, unit.unit_index, unit.model_dump_json()))
                if kind == "draft":
                    db.execute("UPDATE generation_batches SET status='draft',draft_count=draft_count+1,review=NULL WHERE job_id=? AND batch_index=?", (job_id, batch["batch_index"]))
                elif end == row["target_units"]:
                    state = "waiting_storyboard"
            elif checkpoint.action == "review":
                if stage != "generating" or batch is None or batch["status"] != "draft" or checkpoint.review is None:
                    raise HTTPException(409, "No saved batch is waiting for review.")
                review = checkpoint.review
                if review.passed and review.issues:
                    raise HTTPException(422, "A passing review cannot have unresolved issues.")
                db.execute("UPDATE generation_batches SET review=?,status=? WHERE job_id=? AND batch_index=?",
                           (review.model_dump_json(), "completed" if review.passed else "draft", job_id, batch["batch_index"]))
                if not review.passed and batch["draft_count"] >= row["max_revision_rounds"] + 1:
                    state = "needs_review"
                if review.passed and not db.execute("SELECT 1 FROM generation_batches WHERE job_id=? AND status!='completed'", (job_id,)).fetchone():
                    stage = "final_review"
            elif checkpoint.action == "final_review":
                if stage != "final_review" or batch is not None or checkpoint.review is None:
                    raise HTTPException(409, "All batches must pass before final review.")
                if checkpoint.review.passed and checkpoint.review.issues:
                    raise HTTPException(422, "A passing review cannot have unresolved issues.")
                db.execute("UPDATE generation_jobs SET final_review=? WHERE id=?", (checkpoint.review.model_dump_json(), job_id))
                state = "completed" if checkpoint.review.passed else "needs_review"
            db.execute("UPDATE generation_jobs SET status=?,stage=?,updated_at=? WHERE id=?", (state, stage, timestamp(), job_id))
            self.event(db, job_id, checkpoint.action, {
                "plan": "章节计划已保存，等待用户批准。", "storyboard": "逐页故事板批次已保存。",
                "draft": "内容批次已保存，等待独立审校。", "review": "批次审校结果已保存。",
                "final_review": "全局审校已完成。", "failure": "执行失败；可从检查点重试。",
            }[checkpoint.action])
        return self.detail(job_id)
