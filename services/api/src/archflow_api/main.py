from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import Settings, load_settings
from .conversation_repository import ConversationRepository
from .github import GitHubDraftPullRequests
from .models import (
    CapabilitySet,
    ConversationCreate,
    ConversationRecord,
    DraftPullRequestRequest,
    DraftPullRequestResult,
    FileRecord,
    MessageCreate,
    MessageRecord,
    ProjectCreate,
    ProjectRecord,
    SkillDetail,
    SkillSummary,
)
from .project_repository import ProjectRepository
from .skill_repository import SkillRepository
from .storage import LocalFileStorage


SKILLS = (
    SkillSummary(
        slug="architectural-concept-presentation",
        name="建筑概念方案演示",
        module="方案设计",
        status="available",
        source_path="skills/architectural-concept-presentation",
    ),
    SkillSummary(
        slug="aec-technical-bid-authoring",
        name="建筑工程技术标编制",
        module="投标文件",
        status="available",
        source_path="skills/aec-technical-bid-authoring",
    ),
)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or load_settings()
    storage = LocalFileStorage(resolved.upload_dir, resolved.max_upload_bytes)
    case_storage = LocalFileStorage(resolved.case_upload_dir, resolved.max_upload_bytes)
    projects = ProjectRepository(resolved.project_dir)
    conversations = ConversationRepository(resolved.database_path)
    skill_repository = SkillRepository(resolved.repository_root, SKILLS)
    pull_requests = GitHubDraftPullRequests(
        resolved.github_repository,
        resolved.github_base_branch,
        resolved.github_token,
    )
    app = FastAPI(title="ArchFlow API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/capabilities", response_model=CapabilitySet)
    def capabilities() -> CapabilitySet:
        return CapabilitySet(
            release="review-ui",
            file_upload=True,
            chat=True,
            generation=False,
            workflow_engine="tbd",
        )

    @app.get("/api/v1/skills", response_model=list[SkillSummary])
    def list_skills() -> tuple[SkillSummary, ...]:
        return skill_repository.list()

    @app.get("/api/v1/projects", response_model=list[ProjectRecord])
    def list_projects() -> list[ProjectRecord]:
        return projects.list()

    @app.post("/api/v1/projects", response_model=ProjectRecord, status_code=201)
    def create_project(request: ProjectCreate) -> ProjectRecord:
        return projects.create(request.name)

    @app.get("/api/v1/conversations", response_model=list[ConversationRecord])
    def list_conversations(project_id: str, module: str) -> list[ConversationRecord]:
        if module not in {"concept", "bid", "drawing"}:
            raise HTTPException(status_code=422, detail="Unsupported module.")
        return conversations.list_conversations(project_id, module)

    @app.post("/api/v1/conversations", response_model=ConversationRecord, status_code=201)
    def create_conversation(request: ConversationCreate) -> ConversationRecord:
        return conversations.create(request)

    @app.get("/api/v1/conversations/{conversation_id}/messages", response_model=list[MessageRecord])
    def list_messages(conversation_id: str) -> list[MessageRecord]:
        return conversations.list_messages(conversation_id)

    @app.post("/api/v1/conversations/{conversation_id}/messages", response_model=MessageRecord, status_code=201)
    def create_message(conversation_id: str, request: MessageCreate) -> MessageRecord:
        return conversations.add_message(conversation_id, request)

    @app.get("/api/v1/skills/{slug}", response_model=SkillDetail)
    def get_skill(slug: str) -> SkillDetail:
        return skill_repository.detail(slug)

    @app.get("/api/v1/skills/{slug}/files/{file_path:path}", response_class=FileResponse)
    def get_skill_file(slug: str, file_path: str) -> FileResponse:
        return FileResponse(skill_repository.resolve_file(slug, file_path))

    @app.post("/api/v1/skills/{slug}/draft-pr", response_model=DraftPullRequestResult, status_code=201)
    async def create_skill_draft_pr(slug: str, request: DraftPullRequestRequest) -> DraftPullRequestResult:
        changes = [
            (skill_repository.github_path(slug, change.path), change.content)
            for change in request.changes
        ]
        return await pull_requests.create(
            slug=slug,
            title=request.title,
            description=request.description,
            changes=changes,
        )

    @app.post("/api/v1/files", response_model=FileRecord, status_code=201)
    async def upload_file(file: UploadFile = File(...), project_id: str | None = None) -> FileRecord:
        if project_id:
            return await LocalFileStorage(projects.uploads_dir(project_id), resolved.max_upload_bytes).save(file)
        return await storage.save(file)

    @app.post("/api/v1/cases/files", response_model=FileRecord, status_code=201)
    async def upload_case_file(file: UploadFile = File(...)) -> FileRecord:
        return await case_storage.save(file)

    return app


app = create_app()
