from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .requirements import scope_mismatch


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
    processing_status: Literal["queued", "processing", "ready", "failed"] = "queued"
    processing_error: str | None = None
    page_count: int = 0
    role: Literal["source", "reference", "image", "excluded"] = "source"


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
    client_id: str | None = Field(default=None, max_length=100)

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
JobStatus = Literal["queued", "running", "waiting_outline", "waiting_storyboard", "waiting_review", "needs_review", "completed", "failed", "cancelled"]
JobStage = Literal["planning", "storyboarding", "generating", "final_review"]

CallLimit = Annotated[int, Field(strict=True, ge=1, le=100_000)]
TokenLimit = Annotated[int, Field(strict=True, ge=1000, le=1_000_000_000)]


class RunLimits(BaseModel):
    max_model_calls: CallLimit
    max_total_tokens: TokenLimit


DEFAULT_RUN_LIMITS = RunLimits(max_model_calls=20_000, max_total_tokens=100_000_000)


class RequirementDraft(BaseModel):
    module: JobModule
    goal: str = Field(max_length=20_000)
    base_goal: str = Field(default="", max_length=20_000)
    fallback_units: int = Field(default=10, ge=1, le=500)


class ResolvedRequirement(BaseModel):
    target_units: int
    requested_units: int | None
    count_override: bool


class GenerationJobCreate(BaseModel):
    project_id: str = Field(min_length=1, max_length=100)
    conversation_id: str | None = Field(default=None, max_length=100)
    module: JobModule
    goal: str = Field(min_length=1, max_length=20_000)
    target_units: int = Field(ge=1, le=500)
    batch_size: int = Field(default=5, ge=1, le=10)
    max_revision_rounds: int = Field(default=2, ge=0, le=3)
    count_override: bool = False
    max_model_calls: CallLimit | None = None
    max_total_tokens: TokenLimit | None = None

    @model_validator(mode="after")
    def validate_scope(self):
        if scope_mismatch(self.goal, self.module, self.target_units, self.count_override):
            raise ValueError("文字要求与交付数量不一致，请重新确认数量，或明确使用手动设置的数量。")
        return self

    @field_validator("goal")
    @classmethod
    def normalize_goal(cls, value: str) -> str:
        content = value.strip()
        if not content:
            raise ValueError("Generation goal cannot be blank")
        return content


class PlanSection(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    start_unit: int = Field(ge=1, le=500, description="Inclusive actual slide/chapter index, not the outline section number.")
    end_unit: int = Field(ge=1, le=500, description="Inclusive actual slide/chapter index; a section may span many units.")
    objective: str = Field(min_length=1, max_length=2000)


class DocumentPlan(BaseModel):
    skill_slug: str = Field(min_length=1, max_length=100)
    summary: str = Field(min_length=1, max_length=4000, description="Project and design strategy summary. Scope is declared separately in target_units; do not propose a different length or narrate workflow/approval instructions.")
    sections: list[PlanSection] = Field(min_length=1, max_length=30)
    target_units: int = Field(ge=1, le=500, description="Must equal the user's confirmed deliverable length, not len(sections).")


class ArtifactUnit(BaseModel):
    unit_index: int = Field(ge=1, le=500)
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=12000)
    evidence: list[str] = Field(max_length=30)
    missing_facts: list[str] = Field(max_length=30)
    layout: Literal["cover", "text", "image", "table"] = "text"
    image_id: str | None = None
    table: list[list[str]] = Field(default_factory=list, max_length=15)


ArtifactKind = Literal["outline", "storyboard", "draft"]


class CommentAnchor(BaseModel):
    unit_index: int = Field(ge=0, le=500, description="Outline: 0 is summary, 1-based section index otherwise. Storyboard/draft: actual unit index.")
    quote: str = Field(min_length=1, max_length=4000)


class ReviewCommentCreate(BaseModel):
    kind: ArtifactKind
    body: str = Field(min_length=1, max_length=4000)
    anchor: CommentAnchor | None = None

    @field_validator("body")
    @classmethod
    def nonblank_body(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("反馈不能为空。")
        return value.strip()


class ReviewComment(ReviewCommentCreate):
    id: str
    job_id: str
    snapshot_hash: str | None = None
    created_at: str
    submitted_job_id: str | None = None


class ReviewSubmission(BaseModel):
    kind: ArtifactKind
    overall: str = Field(default="", max_length=4000)
    comment_ids: list[str] = Field(default_factory=list, max_length=100)


class ReviewSnapshot(BaseModel):
    parent_id: str
    kind: ArtifactKind
    comments: list[ReviewComment]
    original_outline: DocumentPlan | None = None


class UnitBatch(BaseModel):
    units: list[ArtifactUnit] = Field(min_length=1, max_length=10)


class ReviewResult(BaseModel):
    passed: bool
    summary: str = Field(min_length=1, max_length=4000)
    issues: list[str] = Field(max_length=30)


FailureKind = Literal["budget", "context", "configuration", "provider", "workflow"]


class JobCheckpoint(BaseModel):
    action: Literal["plan", "storyboard", "draft", "review", "final_review", "failure"]
    plan: DocumentPlan | None = None
    batch: UnitBatch | None = None
    review: ReviewResult | None = None
    error: str | None = Field(default=None, max_length=2000)
    failure_kind: FailureKind | None = None


class UsageRecord(BaseModel):
    call_id: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=200)
    total_tokens: int = Field(ge=0)


class AgentMemory(BaseModel):
    scope: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=40000)


class WorkerProgress(BaseModel):
    step: Literal["skills", "materials", "planning", "storyboarding", "generating", "reviewing", "compacting", "continuing"]
    memory: AgentMemory | None = None


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
    count_override: bool = False
    scope_mismatch: bool = False
    parent_id: str | None = None
    feedback_kind: ArtifactKind | None = None
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
    failure_kind: FailureKind | None = None
    created_at: str
    updated_at: str


class GenerationJobDetail(GenerationJobRecord):
    storyboard_range: list[int] | None = None
    outline: DocumentPlan | None = None
    batches: list[GenerationBatchRecord]
    final_review: ReviewResult | None = None
    progress: str | None = None
    review_request: ReviewSnapshot | None = None


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
    sources: list[dict] = Field(default_factory=list)
    revision_units: list[int] = Field(default_factory=list)
    memory: AgentMemory | None = None
