"""Durable, compressed model I/O snapshots, separate from diagnostic exports.

Trace files live under the project's persistent workspace and are never returned
by ordinary job endpoints. Projects retain their existing directory IDs (including
legacy slugs); job and call IDs are UUIDs. Callers authorize the job before access.
"""

import gzip
import json
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import HTTPException


class CallTraces:
    def __init__(self, projects_root: Path):
        self.root = projects_root

    def folder(self, project_id: str, job_id: str, call_id: str) -> Path:
        # Project IDs predate UUID-based project creation. Validate the path
        # component without changing the ID used by the project registry.
        if not project_id or project_id in {".", ".."} or any(char in project_id for char in ("/", "\\", "\x00")):
            raise HTTPException(404, "Invalid model-call project path.")
        try:
            job_id, call_id = (str(UUID(value)) for value in (job_id, call_id))
        except ValueError as error:
            raise HTTPException(404, "Invalid model-call identifier.") from error
        folder = self.root.resolve() / project_id / "workspace" / "model-calls" / job_id / call_id
        # Reject symlinks below the configured root, including links to a
        # different project's workspace, before reading or creating anything.
        if folder.resolve() != folder:
            raise HTTPException(404, "Invalid model-call storage path.")
        return folder

    def save(self, project_id: str, job_id: str, call_id: str, phase: str, data: dict) -> None:
        if phase not in {"request", "response"}:
            raise HTTPException(422, "Invalid trace phase.")
        folder = self.folder(project_id, job_id, call_id)
        for directory in (folder.parent.parent, folder.parent, folder):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
        target = folder / f"{phase}.json.gz"
        # A redelivered call may replace an incomplete snapshot, but never
        # a completed one. Each write is atomic so admin readers see whole JSON.
        if target.exists():
            if json.loads(gzip.decompress(target.read_bytes())) == data:
                return
            raise HTTPException(409, "This model-call trace phase is already recorded.")
        temporary = folder / f".{phase}-{uuid4()}.tmp"
        try:
            temporary.write_bytes(gzip.compress(json.dumps(data, ensure_ascii=False).encode("utf-8"), compresslevel=6))
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

    def read(self, project_id: str, job_id: str, call_id: str) -> dict:
        folder = self.folder(project_id, job_id, call_id)
        result = {}
        for phase in ("request", "response"):
            path = folder / f"{phase}.json.gz"
            if path.is_file():
                result[phase] = json.loads(gzip.decompress(path.read_bytes()))
        return result
