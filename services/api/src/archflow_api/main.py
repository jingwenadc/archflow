import json
import secrets
from uuid import uuid4
from typing import Literal
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, Response, Request, Query
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import Settings, load_settings
from .conversation_repository import ConversationRepository
from .github import GitHubDraftPullRequests
from .job_routes import job_routers
from .models import (
    CapabilitySet,
    ConversationCreate,
    ConversationRecord,
    TrashedConversation,
    DraftPullRequestRequest,
    DraftPullRequestResult,
    FileRecord,
    MessageCreate,
    MessageRecord,
    ProjectCreate,
    ProjectRecord,
    SkillDetail,
    SkillSummary,
    RunLimits, RequirementDraft, ResolvedRequirement,
)
from .run_settings import RunSettingsRepository
from .requirements import requested_unit_count
from .project_repository import ProjectRepository
from .skill_repository import SkillRepository
from .storage import LocalFileStorage
from .materials import DocumentRepository, material_directory
from .auth import AuthStore, Principal, current_principal, require_admin, reset_principal, set_principal


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


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=12, max_length=256)


class Registration(Credentials):
    signup_code: str = Field(min_length=1)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or load_settings()
    if resolved.signup_code and len(resolved.signup_code) < 24:
        raise RuntimeError("ARCHFLOW_SIGNUP_CODE must contain at least 24 characters.")
    if resolved.signup_code and any(origin.startswith("https://") for origin in resolved.allowed_origins) and not resolved.secure_cookies:
        raise RuntimeError("ARCHFLOW_COOKIE_SECURE must be true when HTTPS accounts are enabled.")
    auth = AuthStore(resolved.database_path, resolved.signup_code, resolved.secure_cookies)

    async def account_guard(request: Request):
        path = request.url.path
        principal = None
        if resolved.signup_code and request.method != "OPTIONS" and path != "/health":
            worker_header = request.headers.get("authorization", "")
            worker_expected = f"Bearer {resolved.worker_token}" if resolved.worker_token else ""
            if path.startswith("/internal/") or (worker_expected and secrets.compare_digest(worker_header, worker_expected)):
                if not worker_expected or not secrets.compare_digest(worker_header, worker_expected):
                    raise HTTPException(401, "Worker authentication required.")
                principal = Principal("worker", "worker", "worker")
            elif path not in {"/api/v1/auth/login", "/api/v1/auth/signup", "/api/v1/auth/status"}:
                principal = auth.session(request)
        token = set_principal(principal)
        try:
            yield
        finally:
            reset_principal(token)

    storage = LocalFileStorage(resolved.upload_dir, resolved.max_upload_bytes)
    case_storage = LocalFileStorage(resolved.case_upload_dir, resolved.max_upload_bytes)
    projects = ProjectRepository(resolved.project_dir, auth if resolved.signup_code else None)
    conversations = ConversationRepository(resolved.database_path)
    documents = DocumentRepository(resolved.database_path)
    run_settings = RunSettingsRepository(resolved.database_path)
    skill_repository = SkillRepository(resolved.repository_root, SKILLS)
    pull_requests = GitHubDraftPullRequests(
        resolved.github_repository,
        resolved.github_base_branch,
        resolved.github_token,
    )
    app = FastAPI(title="ArchFlow API", version="0.1.0", dependencies=[Depends(account_guard)])
    for router in job_routers(resolved, projects, conversations):
        app.include_router(router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def no_store_private_api(request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith(("/api/", "/internal/")):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/auth/status")
    def auth_status() -> dict:
        return {"enabled": bool(resolved.signup_code)}

    @app.post("/api/v1/auth/signup", status_code=201)
    def signup(request: Registration, response: Response) -> dict:
        if not resolved.signup_code:
            raise HTTPException(503, "Individual accounts are not configured.")
        principal = auth.create_user(request.username, request.password, request.signup_code)
        auth.issue_session(response, principal)
        return {"id": principal.id, "username": principal.username, "role": principal.role}

    @app.post("/api/v1/auth/login")
    def login(request: Credentials, response: Response) -> dict:
        if not resolved.signup_code:
            raise HTTPException(503, "Individual accounts are not configured.")
        principal = auth.authenticate(request.username, request.password)
        auth.issue_session(response, principal)
        return {"id": principal.id, "username": principal.username, "role": principal.role}

    @app.get("/api/v1/auth/me")
    def me() -> dict:
        principal = current_principal()
        if principal is None:
            raise HTTPException(401, "Sign in required.")
        return {"id": principal.id, "username": principal.username, "role": principal.role}

    @app.post("/api/v1/auth/logout", status_code=204)
    def logout(request: Request, response: Response) -> Response:
        auth.logout(request, response)
        response.status_code = 204
        return response

    @app.get("/api/v1/admin/users")
    def admin_users() -> list[dict]:
        require_admin()
        with auth.connect() as db:
            return [dict(row) for row in db.execute("SELECT id,username,role,created_at FROM users ORDER BY created_at DESC LIMIT 500")]

    @app.get("/api/v1/admin/projects/{project_id}/members")
    def admin_project_members(project_id: str) -> list[dict]:
        require_admin()
        projects.get(project_id)
        with auth.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT u.id,u.username,m.role,m.created_at FROM project_members m JOIN users u ON u.id=m.user_id "
                "WHERE m.project_id=? ORDER BY m.created_at LIMIT 100", (project_id,))]

    @app.get("/api/v1/admin/conversations/{conversation_id}/messages", response_model=list[MessageRecord])
    def admin_conversation_messages(conversation_id: str, offset: int = Query(0, ge=0),
                                    limit: int = Query(100, ge=1, le=500)) -> list[MessageRecord]:
        require_admin()
        with auth.connect() as db:
            if not db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone():
                raise HTTPException(404, "Conversation not found.")
            rows = db.execute("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id LIMIT ? OFFSET ?",
                              (conversation_id, limit, offset))
            return [MessageRecord(**dict(row)) for row in rows]

    @app.get("/api/v1/settings/run-limits", response_model=RunLimits)
    def get_run_limits() -> RunLimits:
        return run_settings.get()

    @app.post("/api/v1/settings/run-limits", response_model=RunLimits)
    def save_run_limits(request: RunLimits) -> RunLimits:
        if resolved.signup_code:
            require_admin()
        return run_settings.save(request)

    @app.post("/api/v1/requirements/resolve", response_model=ResolvedRequirement)
    def resolve_requirement(request: RequirementDraft) -> ResolvedRequirement:
        # An already confirmed brief does not undo an explicit manual count.
        additions = request.goal[len(request.base_goal):] if request.base_goal and request.goal.startswith(request.base_goal) else request.goal
        target = requested_unit_count(additions, request.module)
        requested = requested_unit_count(request.goal, request.module)
        target = request.fallback_units if target is None else target
        return ResolvedRequirement(target_units=target, requested_units=requested,
                                   count_override=requested is not None and requested != target)

    @app.get("/api/v1/capabilities", response_model=CapabilitySet)
    def capabilities() -> CapabilitySet:
        return CapabilitySet(
            release="project-document-workspace",
            file_upload=True,
            chat=True,
            generation=resolved.agent_enabled and bool(resolved.worker_token),
            workflow_engine="sqlite-worker",
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
        projects.get(project_id)
        return conversations.list_conversations(project_id, module)

    @app.post("/api/v1/conversations", response_model=ConversationRecord, status_code=201)
    def create_conversation(request: ConversationCreate) -> ConversationRecord:
        projects.get(request.project_id)
        return conversations.create(request)

    @app.get("/api/v1/projects/{project_id}/trash", response_model=list[TrashedConversation])
    def project_trash(project_id: str) -> list[TrashedConversation]:
        projects.get(project_id)
        return conversations.list_deleted(project_id)

    @app.post("/api/v1/projects/{project_id}/trash/conversations/{conversation_id}/restore", response_model=ConversationRecord)
    def restore_conversation(project_id: str, conversation_id: str) -> ConversationRecord:
        projects.get(project_id)
        return conversations.restore(conversation_id, project_id)

    @app.delete("/api/v1/conversations/{conversation_id}", status_code=204)
    def delete_conversation(conversation_id: str, project_id: str) -> Response:
        projects.get(project_id)
        conversations.delete(conversation_id, project_id)
        return Response(status_code=204)

    @app.get("/api/v1/conversations/{conversation_id}/messages", response_model=list[MessageRecord])
    def list_messages(conversation_id: str) -> list[MessageRecord]:
        return conversations.list_messages(conversation_id)

    @app.post("/api/v1/conversations/{conversation_id}/messages", response_model=MessageRecord, status_code=201)
    def create_message(conversation_id: str, request: MessageCreate) -> MessageRecord:
        message = conversations.add_message(conversation_id, request)
        from .job_repository import JobRepository
        conversation = conversations.get(conversation_id)
        jobs = JobRepository(resolved.database_path).list(conversation.project_id, conversation_id)
        current = jobs[0] if jobs else None
        if conversation.module == "drawing":
            reply = "已收到。施工图协同仍在规划中，目前不会生成 CAD 或工程计算结果。"
        elif current and current.status in {"queued", "running"}:
            reply = "已收到并保存补充要求。当前任务正在执行，使用的是启动时确认的资料和需求。完成后可据此生成新版本；也可以先取消当前任务。"
        elif current and current.status in {"waiting_outline", "waiting_storyboard"}:
            reply = "已保存新的要求。请在下方确认新版本需求，再重新整理提纲；旧版需求与成果都会保留。右侧可独立切换成果版本，我不会把补充消息当作批准。"
        else:
            unit = "页数" if conversation.module == "concept" else "章节数"
            reply = f"已收到你的要求。项目资料会在这些对话中共享。请先在下方确认需求摘要与{unit}，确认后开始整理提纲；你也可以继续补充受众、风格或重点，无需重复上传。"
        conversations.assistant(conversation_id, reply, reply_to=message.id)
        return message

    @app.post("/api/v1/conversations/{conversation_id}/rename")
    def rename_conversation(conversation_id: str, request: dict):
        conversations.rename(conversation_id, str(request.get("title", "")))
        return {"saved": True}

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

    @app.get("/api/v1/files", response_model=list[FileRecord])
    def list_files(project_id: str | None = None) -> list[FileRecord]:
        if resolved.signup_code and not project_id:
            raise HTTPException(422, "Select a project to list its files.")
        if project_id:
            return LocalFileStorage(projects.uploads_dir(project_id), resolved.max_upload_bytes, documents, project_id).list()
        return storage.list()

    @app.post("/api/v1/files", response_model=FileRecord, status_code=201)
    async def upload_file(file: UploadFile = File(...), project_id: str | None = None) -> FileRecord:
        if resolved.signup_code and not project_id:
            raise HTTPException(422, "Select a project to upload files.")
        if project_id:
            return await LocalFileStorage(projects.uploads_dir(project_id), resolved.max_upload_bytes, documents, project_id).save(file)
        return await storage.save(file)

    @app.get("/api/v1/files/{file_id}/original")
    def original_file(file_id: str, project_id: str):
        folder = material_directory(projects.uploads_dir(project_id), file_id)
        metadata = json.loads((folder / "metadata.json").read_text("utf-8"))
        return FileResponse(next(folder.glob("original.*")), filename=metadata["name"])

    @app.get("/api/v1/files/{file_id}/pages/{page}")
    def material_page(file_id: str, page: int, project_id: str):
        folder = material_directory(projects.uploads_dir(project_id), file_id)
        if not (folder / "index.json").is_file():
            raise HTTPException(409, "资料仍在解析。")
        index = json.loads((folder / "index.json").read_text("utf-8"))
        if page < 1 or page > len(index["pages"]):
            raise HTTPException(404, "页码不存在。")
        image_id = index["pages"][page-1].get("image_id")
        asset = next(asset for asset in index["assets"] if asset["id"] == image_id)
        return FileResponse(folder / asset["file"], media_type="image/jpeg")

    @app.post("/api/v1/files/{file_id}/role")
    def file_role(file_id: str, project_id: str, role: Literal["source", "reference", "image", "excluded"]):
        folder = material_directory(projects.uploads_dir(project_id), file_id)
        path = folder / "metadata.json"
        metadata = json.loads(path.read_text("utf-8")) | {"role": role}
        temporary = folder / f"metadata-{uuid4()}.pending"
        temporary.write_text(json.dumps(metadata, ensure_ascii=False), "utf-8")
        temporary.replace(path)
        return {"saved": True}

    @app.post("/api/v1/files/{file_id}/retry")
    def retry_file(file_id: str, project_id: str):
        material_directory(projects.uploads_dir(project_id), file_id)
        documents.retry(file_id)
        return {"queued": True}

    @app.post("/api/v1/cases/files", response_model=FileRecord, status_code=201)
    async def upload_case_file(file: UploadFile = File(...)) -> FileRecord:
        return await case_storage.save(file)

    return app


app = create_app()
