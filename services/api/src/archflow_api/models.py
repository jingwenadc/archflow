from typing import Literal

from pydantic import BaseModel, Field, field_validator


class CapabilitySet(BaseModel):
    release: str
    file_upload: bool
    chat: bool
    generation: bool
    workflow_engine: Literal["tbd"]


class FileRecord(BaseModel):
    id: str
    name: str
    size: int
    content_type: str
    status: Literal["uploaded"]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Project name cannot be blank")
        return normalized


class ProjectRecord(BaseModel):
    id: str
    name: str
    created_at: str
    status: Literal["ready"]


class SkillSummary(BaseModel):
    slug: str
    name: str
    module: str
    status: Literal["available"]
    source_path: str


class SkillFile(BaseModel):
    path: str
    size: int
    kind: Literal["markdown", "code", "image", "binary"]
    editable: bool
    content: str | None = None


class SkillDetail(SkillSummary):
    files: list[SkillFile]


class SkillFileEdit(BaseModel):
    path: str
    content: str


class DraftPullRequestRequest(BaseModel):
    title: str
    description: str = ""
    changes: list[SkillFileEdit]


class DraftPullRequestResult(BaseModel):
    url: str
    number: int
    branch: str
