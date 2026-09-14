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


class ConversationCreate(BaseModel):
    project_id: str = Field(min_length=1, max_length=100)
    module: Literal["concept", "bid", "drawing"]
    title: str = Field(min_length=1, max_length=120)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Conversation title cannot be blank")
        return normalized


class ConversationRecord(BaseModel):
    id: str
    project_id: str
    module: Literal["concept", "bid", "drawing"]
    title: str
    created_at: str
    updated_at: str


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        content = value.strip()
        if not content:
            raise ValueError("Message content cannot be blank")
        return content


class MessageRecord(BaseModel):
    id: str
    conversation_id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: str


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
