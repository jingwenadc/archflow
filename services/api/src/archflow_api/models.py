from typing import Literal

from pydantic import BaseModel


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
