from typing import Literal

from pydantic import BaseModel, Field, field_validator


class CapabilitySet(BaseModel):
    release: str
    file_upload: bool
    chat: bool
    generation: bool
    workflow_engine: Literal["sqlite-worker"]


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


JobModule = Literal["concept", "bid", "drawing"]
JobStatus = Literal["queued", "running", "waiting_outline", "waiting_storyboard", "needs_review", "completed", "failed", "cancelled"]
JobStage = Literal["planning", "storyboarding", "generating", "final_review"]


class GenerationJobCreate(BaseModel):
    project_id: str = Field(min_length=1, max_length=100)
    conversation_id: str | None = Field(default=None, max_length=100)
    module: JobModule
    goal: str = Field(min_length=1, max_length=20_000)
    target_units: int = Field(ge=1, le=500)
    batch_size: int = Field(default=5, ge=1, le=10)
    max_revision_rounds: int = Field(default=2, ge=0, le=3)
    max_model_calls: int = Field(default=400, ge=1, le=1000)
    max_total_tokens: int = Field(default=250_000, ge=1000, le=2_000_000)

    @field_validator("goal")
    @classmethod
    def normalize_goal(cls, value: str) -> str:
        content = value.strip()
        if not content:
            raise ValueError("Generation goal cannot be blank")
        return content


class PlanSection(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    start_unit: int = Field(ge=1, le=500)
    end_unit: int = Field(ge=1, le=500)
    objective: str = Field(min_length=1, max_length=2000)


class DocumentPlan(BaseModel):
    skill_slug: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=4000)
    sections: list[PlanSection] = Field(min_length=1, max_length=30)


class ArtifactUnit(BaseModel):
    unit_index: int = Field(ge=1, le=500)
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=12000)
    evidence: list[str] = Field(max_length=30)
    missing_facts: list[str] = Field(max_length=30)


class UnitBatch(BaseModel):
    units: list[ArtifactUnit] = Field(min_length=1, max_length=10)


class ReviewResult(BaseModel):
    passed: bool
    summary: str = Field(min_length=1, max_length=4000)
    issues: list[str] = Field(max_length=30)


class JobCheckpoint(BaseModel):
    action: Literal["plan", "storyboard", "draft", "review", "final_review", "failure"]
    plan: DocumentPlan | None = None
    batch: UnitBatch | None = None
    review: ReviewResult | None = None
    error: str | None = Field(default=None, max_length=2000)


class UsageRecord(BaseModel):
    call_id: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)
    total_tokens: int = Field(ge=0)


class GenerationBatchRecord(BaseModel):
    batch_index: int
    start_unit: int
    end_unit: int
    status: Literal["pending", "draft", "completed"]
    draft_count: int
    review: ReviewResult | None = None


class GenerationJobRecord(BaseModel):
    id: str
    project_id: str
    conversation_id: str | None
    module: JobModule
    goal: str
    target_units: int
    batch_size: int
    max_revision_rounds: int
    status: JobStatus
    stage: JobStage
    completed_units: int
    storyboard_units: int
    model_calls: int
    total_tokens: int
    max_model_calls: int
    max_total_tokens: int
    model: str
    review_model: str
    error: str | None = None
    created_at: str
    updated_at: str


class GenerationJobDetail(GenerationJobRecord):
    outline: DocumentPlan | None = None
    batches: list[GenerationBatchRecord]
    final_review: ReviewResult | None = None


class GenerationJobEvent(BaseModel):
    id: int
    job_id: str
    event_type: str
    message: str
    created_at: str


class SkillSnapshot(BaseModel):
    slug: str
    description: str
    sha256: str
    files: dict[str, str]


class ClaimedJob(BaseModel):
    job: GenerationJobDetail
    lease_id: str
    skills: list[SkillSnapshot]
    current_units: list[ArtifactUnit]
