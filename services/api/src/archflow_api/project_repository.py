import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, status

from .models import ProjectRecord
from .auth import AuthStore, authorize_project, current_principal


class ProjectRepository:
    """Small filesystem-backed project registry for the review release."""

    def __init__(self, root: Path, auth: AuthStore | None = None) -> None:
        self.root = root
        self.auth = auth
        self.root.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[ProjectRecord]:
        self.root.mkdir(parents=True, exist_ok=True)
        projects: list[ProjectRecord] = []
        for metadata_path in self.root.glob("*/metadata.json"):
            try:
                projects.append(ProjectRecord.model_validate_json(metadata_path.read_text("utf-8")))
            except (OSError, ValueError):
                continue
        principal = current_principal()
        if self.auth and principal and principal.role == "user":
            allowed = self.auth.list_project_ids(principal.id)
            projects = [project for project in projects if project.id in allowed]
        return sorted(projects, key=lambda project: project.created_at)

    def create(self, name: str) -> ProjectRecord:
        project = ProjectRecord(
            id=str(uuid4()),
            name=name,
            created_at=datetime.now(timezone.utc).isoformat(),
            status="ready",
        )
        project_dir = self.root / project.id
        (project_dir / "uploads").mkdir(parents=True, exist_ok=False, mode=0o700)
        project_dir.chmod(0o700)
        (project_dir / "workspace").mkdir(mode=0o700)
        (project_dir / "metadata.json").write_text(
            json.dumps(project.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        principal = current_principal()
        if self.auth and principal and principal.role in {"user", "admin"}:
            try:
                self.auth.add_owner(project.id, principal.id)
            except Exception:
                # The UUID directory was created in this call and has never
                # been exposed. Do not leave an ownerless visible project.
                shutil.rmtree(project_dir)
                raise
        return project

    def get(self, project_id: str) -> ProjectRecord:
        project_dir = (self.root / project_id).resolve()
        metadata_path = project_dir / "metadata.json"
        if not project_dir.is_relative_to(self.root.resolve()) or not metadata_path.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
        if self.auth:
            with self.auth.connect() as db:
                authorize_project(db, project_id)
        try:
            return ProjectRecord.model_validate_json(metadata_path.read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Project metadata is invalid.",
            ) from error

    def uploads_dir(self, project_id: str) -> Path:
        self.get(project_id)
        project_dir = (self.root / project_id).resolve()
        uploads_dir = project_dir / "uploads"
        uploads_dir.mkdir(parents=True, exist_ok=True)
        return uploads_dir
