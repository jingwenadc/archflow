"""Version-bound review comments. Saving a comment never schedules model work."""
import hashlib
import json
import re
import sqlite3
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException

from .models import CommentAnchor, DocumentPlan, ReviewComment, ReviewCommentCreate, ReviewSnapshot, ReviewSubmission


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


class Reviews:
    @staticmethod
    def initialize(db: sqlite3.Connection) -> None:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS review_comments (
                id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id),
                kind TEXT NOT NULL, body TEXT NOT NULL, anchor TEXT, snapshot_hash TEXT,
                created_at TEXT NOT NULL, submitted_job_id TEXT REFERENCES generation_jobs(id),
                request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                UNIQUE(job_id,request_key)
            );
            CREATE TABLE IF NOT EXISTS review_runs (
                job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id), parent_id TEXT NOT NULL,
                kind TEXT NOT NULL, snapshot TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS review_comments_job_idx ON review_comments(job_id,created_at);
        """)

    @staticmethod
    def comments(db: sqlite3.Connection, job_id: str) -> list[ReviewComment]:
        return [ReviewComment(**(dict(row) | {"anchor": json.loads(row["anchor"]) if row["anchor"] else None}))
                for row in db.execute("SELECT * FROM review_comments WHERE job_id=? ORDER BY created_at,id", (job_id,))]

    @staticmethod
    def snapshot(db: sqlite3.Connection, job_id: str) -> ReviewSnapshot | None:
        row = db.execute("SELECT snapshot FROM review_runs WHERE job_id=?", (job_id,)).fetchone()
        return ReviewSnapshot.model_validate_json(row[0]) if row else None

    @staticmethod
    def anchor_hash(db: sqlite3.Connection, job: sqlite3.Row, kind: str, anchor: CommentAnchor) -> str:
        if kind == "outline":
            if not job["outline"]:
                raise HTTPException(409, "此版本尚无提纲。")
            plan = json.loads(job["outline"])
            if anchor.unit_index == 0:
                text = plan["summary"]
            elif 1 <= anchor.unit_index <= len(plan["sections"]):
                section = plan["sections"][anchor.unit_index - 1]
                text = section["title"] + "\n" + section["objective"]
            else:
                raise HTTPException(422, "提纲批注位置不存在。")
        else:
            row = db.execute("SELECT payload FROM generation_units WHERE job_id=? AND kind=? AND unit_index=?",
                             (job["id"], kind, anchor.unit_index)).fetchone()
            if not row:
                raise HTTPException(422, "此页或章节尚未保存，无法添加批注。")
            unit = json.loads(row[0])
            text = unit["title"] + "\n" + unit["body"]
        text = normalized_text(text)
        if not normalized_text(anchor.quote) or normalized_text(anchor.quote) not in text:
            raise HTTPException(409, "选中的文字不属于此版本，或内容已经改变。请重新选择后批注。")
        return hashlib.sha256(text.encode()).hexdigest()

    @classmethod
    def add(cls, db: sqlite3.Connection, job: sqlite3.Row, request: ReviewCommentCreate, key: str) -> ReviewComment:
        fingerprint = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
        previous = db.execute("SELECT * FROM review_comments WHERE job_id=? AND request_key=?", (job["id"], key)).fetchone()
        if previous:
            if previous["request_hash"] != fingerprint:
                raise HTTPException(409, "此提交标识已经用于其他反馈。")
            return next(item for item in cls.comments(db, job["id"]) if item.id == previous["id"])
        digest = cls.anchor_hash(db, job, request.kind, request.anchor) if request.anchor else None
        comment = ReviewComment(**request.model_dump(), id=str(uuid4()), job_id=job["id"], snapshot_hash=digest,
                                created_at=datetime.now(UTC).isoformat())
        db.execute("INSERT INTO review_comments(id,job_id,kind,body,anchor,snapshot_hash,created_at,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?)",
                   (comment.id, comment.job_id, comment.kind, comment.body, request.anchor.model_dump_json() if request.anchor else None,
                    digest, comment.created_at, key, fingerprint))
        return comment

    @classmethod
    def prepare(cls, db: sqlite3.Connection, parent: sqlite3.Row, request: ReviewSubmission, child_id: str) -> ReviewSnapshot:
        if parent["status"] in {"queued", "running"} or db.execute(
            "SELECT 1 FROM generation_jobs WHERE conversation_id=? AND id<>? AND status IN ('queued','running')", (parent["conversation_id"], child_id)
        ).fetchone():
            raise HTTPException(409, "请等待当前任务结束或暂停后提交修订；批注可以先保存。")
        if request.kind == "outline" and not parent["outline"]:
            raise HTTPException(409, "提纲尚未保存。")
        if request.kind != "outline" and not db.execute(
            "SELECT 1 FROM generation_units WHERE job_id=? AND kind=?", (parent["id"], request.kind)
        ).fetchone():
            raise HTTPException(409, "此阶段尚无内容可修订。")
        ids = set(request.comment_ids)
        comments = [item for item in cls.comments(db, parent["id"]) if item.id in ids]
        if len(comments) != len(ids) or any(item.submitted_job_id for item in comments):
            raise HTTPException(409, "请选择此版本尚未提交的批注。")
        for comment in comments:
            if comment.anchor and cls.anchor_hash(db, parent, comment.kind, comment.anchor) != comment.snapshot_hash:
                raise HTTPException(409, "批注对应的内容已改变，请重新审阅后批注。")
        if request.overall.strip():
            comments.append(cls.add(db, parent, ReviewCommentCreate(kind=request.kind, body=request.overall), f"overall:{child_id}"))
        if not comments:
            raise HTTPException(422, "请填写整体反馈或选择未提交的批注。")
        plan = json.loads(parent["outline"]) if parent["outline"] else None
        if plan:
            plan.setdefault("target_units", parent["target_units"])
        # A single review can cover several phases. Restart at the earliest
        # affected phase; later feedback remains pinned for its own phase.
        kind = min((comment.kind for comment in comments), key=("outline", "storyboard", "draft").index)
        snapshot = ReviewSnapshot(parent_id=parent["id"], kind=kind, comments=comments,
                                  original_outline=DocumentPlan(**plan) if plan else None)
        db.execute("INSERT INTO review_runs VALUES(?,?,?,?)", (child_id, parent["id"], kind, snapshot.model_dump_json()))
        db.executemany("UPDATE review_comments SET submitted_job_id=? WHERE id=?", [(child_id, comment.id) for comment in comments])
        return snapshot

    @staticmethod
    def validate_plan(snapshot: ReviewSnapshot | None, plan: DocumentPlan) -> None:
        if not snapshot or snapshot.kind != "outline":
            return
        comments = [comment for comment in snapshot.comments if comment.kind == "outline"]
        if any(comment.anchor is None for comment in comments):
            return
        original = snapshot.original_outline
        assert original is not None
        targets = {comment.anchor.unit_index for comment in comments if comment.anchor}
        if plan.skill_slug != original.skill_slug or len(plan.sections) != len(original.sections):
            raise HTTPException(422, "定向批注修订需保留未涉及的提纲结构；整体重组请提交整体反馈。")
        if 0 not in targets and plan.summary != original.summary:
            raise HTTPException(422, "请保留未批注的提纲摘要。")
        for index, section in enumerate(plan.sections, 1):
            if index not in targets and section != original.sections[index - 1]:
                raise HTTPException(422, "请保留未批注的提纲章节。")
