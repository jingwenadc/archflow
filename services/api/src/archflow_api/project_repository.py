import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .models import ProjectRecord


class ProjectRepository:
    """Small filesystem-backed project registry for the review release."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._ensure_default_project()

    def _ensure_default_project(self) -> None:
        default_dir = self.root / "cold-chain-industrial-park"
        metadata_path = default_dir / "metadata.json"
        if metadata_path.exists():
            return
        project = ProjectRecord(
            id="cold-chain-industrial-park",
            name="冷链产业园",
            created_at=datetime.now(timezone.utc).isoformat(),
            status="ready",
        )
        (default_dir / "uploads").mkdir(parents=True, exist_ok=True)
        (default_dir / "workspace").mkdir(exist_ok=True)
        metadata_path.write_text(
            json.dumps(project.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def list(self) -> list[ProjectRecord]:
        self.root.mkdir(parents=True, exist_ok=True)
        projects: list[ProjectRecord] = []
        for metadata_path in self.root.glob("*/metadata.json"):
            try:
                projects.append(ProjectRecord.model_validate_json(metadata_path.read_text("utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(projects, key=lambda project: project.created_at)

    def create(self, name: str) -> ProjectRecord:
        project = ProjectRecord(
            id=str(uuid4()),
            name=name,
            created_at=datetime.now(timezone.utc).isoformat(),
            status="ready",
        )
        project_dir = self.root / project.id
        (project_dir / "uploads").mkdir(parents=True, exist_ok=False)
        (project_dir / "workspace").mkdir()
        (project_dir / "metadata.json").write_text(
            json.dumps(project.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return project

    def uploads_dir(self, project_id: str) -> Path:
        project_dir = (self.root / project_id).resolve()
        if not project_dir.is_relative_to(self.root.resolve()) or not (project_dir / "metadata.json").is_file():
            from fastapi import HTTPException, status

            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
        uploads_dir = project_dir / "uploads"
        uploads_dir.mkdir(parents=True, exist_ok=True)
        return uploads_dir
