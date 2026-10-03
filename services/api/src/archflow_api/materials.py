"""Durable document work and frozen, project-scoped evidence. No model calls here."""
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID

from fastapi import HTTPException


class DocumentRepository:
    def __init__(self, database: Path):
        self.database = database
        database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS document_work (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT NOT NULL,
                    path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
                    lease_until REAL, error TEXT, result TEXT
                );
                CREATE TABLE IF NOT EXISTS job_sources (
                    job_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
                    parent_job_id TEXT, revision_units TEXT NOT NULL DEFAULT '[]'
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=10000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def queue(self, work_id: str, kind: str, project_id: str, path: Path):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO document_work(id,kind,project_id,path) VALUES(?,?,?,?)",
                       (work_id, kind, project_id, str(path)))

    def status(self, work_id: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM document_work WHERE id=?", (work_id,)).fetchone()
        if row is None:
            return {"status": "queued", "error": None, "result": None}
        return dict(row) | {"result": json.loads(row["result"]) if row["result"] else None}

    def retry(self, work_id: str):
        with self.connect() as db:
            db.execute("UPDATE document_work SET status='queued',error=NULL WHERE id=? AND status='failed'", (work_id,))

    def claim(self) -> dict | None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM document_work WHERE status='queued' OR (status='processing' AND lease_until<?) ORDER BY rowid LIMIT 1", (time.time(),)).fetchone()
            if row is None:
                return None
            db.execute("UPDATE document_work SET status='processing',lease_until=? WHERE id=?", (time.time() + 90, row["id"]))
        return dict(row)

    def finish(self, work_id: str, result: dict | None = None, error: str | None = None):
        with self.connect() as db:
            db.execute("UPDATE document_work SET status=?,result=?,error=?,lease_until=NULL WHERE id=?",
                       ("failed" if error else "ready", json.dumps(result, ensure_ascii=False), error, work_id))

    def renew(self, work_id: str):
        with self.connect() as db:
            db.execute("UPDATE document_work SET lease_until=? WHERE id=? AND status='processing'", (time.time() + 90, work_id))

    def snapshot(self, job_id: str, documents: list[dict], parent: str | None = None, revision_units: list[int] | None = None):
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO job_sources VALUES(?,?,?,?)",
                       (job_id, json.dumps(documents, ensure_ascii=False), parent, json.dumps(revision_units or [])))

    def sources(self, job_id: str) -> list[dict]:
        with self.connect() as db:
            row = db.execute("SELECT payload FROM job_sources WHERE job_id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else []

    def catalog(self, job_id: str) -> list[dict]:
        return [{key: doc[key] for key in ["file_id", "name", "role", "page_count", "theme", "assets"]} for doc in self.sources(job_id)]

    def revisions(self, job_id: str) -> list[int]:
        with self.connect() as db:
            row = db.execute("SELECT revision_units FROM job_sources WHERE job_id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else []

    def search(self, job_id: str, query: str = "", source_id: str | None = None) -> list[dict]:
        import re
        terms = re.findall(r"[A-Za-z0-9]+|[\u4e00-\u9fff]{2,}", query.lower())
        terms += [term[i:i+2] for term in terms for i in range(len(term)-1) if len(term) > 3]
        pages = []
        for doc in self.sources(job_id):
            for page in doc["pages"]:
                if source_id and page["id"] != source_id:
                    continue
                score = sum(page["text"].lower().count(term) for term in terms)
                pages.append((score, {"id": page["id"], "file": doc["name"], "role": doc["role"], "page": page["page"], "text": page["text"][:4000], "image_id": page.get("image_id")}))
        pages.sort(key=lambda item: item[0], reverse=True)
        return [item[1] for item in pages[:3]]

    def asset(self, job_id: str, asset_id: str) -> Path:
        for doc in self.sources(job_id):
            for asset in doc["assets"]:
                if asset["id"] == asset_id:
                    path = Path(doc["directory"]) / asset["file"]
                    if path.is_file() and path.resolve().is_relative_to(Path(doc["directory"]).resolve()):
                        return path
        raise HTTPException(404, "Image is not part of this job's frozen project materials.")


def material_directory(root: Path, file_id: str) -> Path:
    try:
        UUID(file_id)
    except ValueError:
        raise HTTPException(404, "File not found.")
    path = root / file_id
    if not (path / "metadata.json").is_file():
        raise HTTPException(404, "File not found.")
    return path


def collect_materials(root: Path, documents: DocumentRepository) -> list[dict]:
    result = []
    for meta in sorted(root.glob("*/metadata.json")):
        record = json.loads(meta.read_text("utf-8"))
        if record.get("role") == "excluded":
            continue
        status = documents.status(record["id"])
        if status["status"] != "ready":
            raise HTTPException(409, f"{record['name']}：资料尚未解析成功，请等待、重试或将它排除。")
        index = json.loads((meta.parent / "index.json").read_text("utf-8"))
        result.append(index | {"role": record.get("role", "source"), "directory": str(meta.parent)})
    return result
