from pathlib import Path

from fastapi import HTTPException, status

from .models import SkillDetail, SkillFile, SkillSummary


TEXT_EXTENSIONS = {".md", ".txt", ".json", ".yaml", ".yml", ".py"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}
MAX_TEXT_BYTES = 512 * 1024


class SkillRepository:
    def __init__(self, root: Path, catalog: tuple[SkillSummary, ...]) -> None:
        self.root = root.resolve()
        self.catalog = {skill.slug: skill for skill in catalog}

    def list(self) -> tuple[SkillSummary, ...]:
        return tuple(self.catalog.values())

    def detail(self, slug: str) -> SkillDetail:
        summary = self._summary(slug)
        skill_root = self._skill_root(summary)
        files = [self._describe_file(path, skill_root) for path in sorted(skill_root.rglob("*")) if path.is_file()]
        return SkillDetail(**summary.model_dump(), files=files)

    def resolve_file(self, slug: str, relative_path: str, *, editable: bool = False) -> Path:
        summary = self._summary(slug)
        skill_root = self._skill_root(summary)
        target = (skill_root / relative_path).resolve()
        if not target.is_relative_to(skill_root) or not target.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill file not found.")
        if editable and (target.suffix.lower() not in TEXT_EXTENSIONS or target.stat().st_size > MAX_TEXT_BYTES):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="This file cannot be edited online.")
        return target

    def github_path(self, slug: str, relative_path: str) -> str:
        target = self.resolve_file(slug, relative_path, editable=True)
        return target.relative_to(self.root).as_posix()

    def _summary(self, slug: str) -> SkillSummary:
        summary = self.catalog.get(slug)
        if summary is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found.")
        return summary

    def _skill_root(self, summary: SkillSummary) -> Path:
        skill_root = (self.root / summary.source_path).resolve()
        if not skill_root.is_relative_to(self.root) or not skill_root.is_dir():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill content is unavailable.")
        return skill_root

    def _describe_file(self, path: Path, skill_root: Path) -> SkillFile:
        suffix = path.suffix.lower()
        size = path.stat().st_size
        if suffix == ".md":
            kind = "markdown"
        elif suffix in TEXT_EXTENSIONS:
            kind = "code"
        elif suffix in IMAGE_EXTENSIONS:
            kind = "image"
        else:
            kind = "binary"
        editable = suffix in TEXT_EXTENSIONS and size <= MAX_TEXT_BYTES
        content = path.read_text(encoding="utf-8") if editable else None
        return SkillFile(
            path=path.relative_to(skill_root).as_posix(),
            size=size,
            kind=kind,
            editable=editable,
            content=content,
        )
