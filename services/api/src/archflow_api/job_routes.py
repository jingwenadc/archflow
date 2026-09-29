import secrets
import base64
import json
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.responses import StreamingResponse, FileResponse

from .config import Settings
from .conversation_repository import ConversationRepository
from .job_repository import JobRepository, snapshot_skills
from .models import (
    ArtifactUnit, ClaimedJob, GenerationJobCreate, GenerationJobDetail,
    GenerationJobEvent, GenerationJobRecord, JobCheckpoint, UsageRecord, WorkerProgress, RunLimits,
    ReviewComment, ReviewCommentCreate, ReviewSubmission, SkillSnapshot,
)
from .project_repository import ProjectRepository
from .materials import DocumentRepository, collect_materials
from .artifacts import queue_export, export_status, exported_file
from .reviews import Reviews


def job_routers(settings: Settings, projects: ProjectRepository,
                conversations: ConversationRepository) -> tuple[APIRouter, APIRouter]:
    jobs = JobRepository(settings.database_path)
    documents = DocumentRepository(settings.database_path)
    public = APIRouter(prefix="/api/v1/jobs", tags=["generation"])

    def require_worker(authorization: Annotated[str | None, Header()] = None) -> None:
        expected = f"Bearer {settings.worker_token}" if settings.worker_token else ""
        if not expected or not secrets.compare_digest(authorization or "", expected):
            raise HTTPException(401, "Worker authentication required.")

    internal = APIRouter(prefix="/internal/jobs", dependencies=[Depends(require_worker)])

    @public.post("", response_model=GenerationJobDetail, status_code=202)
    def create_job(request: GenerationJobCreate,
                   idempotency_key: Annotated[str | None, Header(max_length=200)] = None) -> GenerationJobDetail:
        if not settings.agent_enabled or not settings.worker_token:
            raise HTTPException(503, "Agent worker is not configured. Set ARCHFLOW_AGENT_ENABLED and worker credentials.")
        if request.module == "drawing":
            raise HTTPException(422, "Drawing generation is not enabled in this prototype.")
        projects.get(request.project_id)
        if request.conversation_id:
            available = conversations.list_conversations(request.project_id, request.module)
            if not any(item.id == request.conversation_id for item in available):
                raise HTTPException(404, "Conversation does not belong to this project and module.")
        materials = collect_materials(projects.uploads_dir(request.project_id), documents)
        created = jobs.create(request, idempotency_key or str(uuid4()), snapshot_skills(settings.repository_root),
                              settings.llm_model, settings.review_model, sources=materials)
        return created

    @public.post("/{job_id}/revise", response_model=GenerationJobDetail, status_code=202)
    def revise(job_id: str, request: dict, idempotency_key: Annotated[str | None, Header(max_length=200)] = None):
        if not settings.agent_enabled or not settings.worker_token:
            raise HTTPException(503, "模型服务尚未配置。")
        old = jobs.detail(job_id)
        if old.scope_mismatch:
            raise HTTPException(409, "原需求范围不一致，请重新确认完整需求，而不是局部修改。")
        if old.status not in {"completed", "needs_review", "cancelled", "failed"}:
            raise HTTPException(409, "请先等待任务结束或取消，然后创建新版本。")
        instruction = str(request.get("instruction", "")).strip()
        indices = request.get("units", [])
        if not instruction or len(instruction) > 4000 or not indices or not all(type(i) is int and 1 <= i <= old.target_units for i in indices):
            raise HTTPException(422, "请提供修改要求与有效页码范围。")
        if len(jobs.units(old.id, "draft", 0, 500)) != old.target_units:
            raise HTTPException(409, "原版本尚未生成完整内容，请先补齐或重新整理提纲。")
        defaults = jobs.run_settings.get()
        try:
            limits = RunLimits(max_model_calls=request.get("max_model_calls", defaults.max_model_calls),
                               max_total_tokens=request.get("max_total_tokens", defaults.max_total_tokens))
        except ValueError:
            raise HTTPException(422, "请提供有效的模型调用与累计 token 上限。")
        try:
            body = GenerationJobCreate(project_id=old.project_id, conversation_id=old.conversation_id, module=old.module,
                                       goal=old.goal, target_units=old.target_units, count_override=old.count_override,
                                       batch_size=old.batch_size, max_revision_rounds=old.max_revision_rounds,
                                       **limits.model_dump())
        except ValueError:
            raise HTTPException(422, "完整需求过长或交付数量改变，请精简需求或重新确认完整范围；不会截断原需求。")
        with jobs.connect() as db:
            skills = [SkillSnapshot(**value) for value in json.loads(jobs.require(db, old.id)["skills"])]
        created = jobs.create(body, idempotency_key or str(uuid4()), skills, settings.llm_model, settings.review_model,
                              sources=documents.sources(old.id), parent_id=old.id, revision_units=sorted(set(indices)),
                              review_request=ReviewSubmission(kind="draft", overall=instruction))
        return jobs.detail(created.id)

    @public.get("", response_model=list[GenerationJobRecord])
    def list_jobs(project_id: str, conversation_id: str | None = None) -> list[GenerationJobRecord]:
        projects.get(project_id)
        return jobs.list(project_id, conversation_id)

    @public.get("/{job_id}", response_model=GenerationJobDetail)
    def get_job(job_id: str) -> GenerationJobDetail:
        return jobs.detail(job_id)

    @public.get("/{job_id}/units", response_model=list[ArtifactUnit])
    def get_units(job_id: str, kind: Literal["storyboard", "draft"] = "draft",
                  offset: int = Query(0, ge=0), limit: int = Query(10, ge=1, le=20)) -> list[ArtifactUnit]:
        return jobs.units(job_id, kind, offset, limit)

    @public.get("/{job_id}/comments", response_model=list[ReviewComment])
    def comments(job_id: str):
        with jobs.connect() as db:
            jobs.require(db, job_id)
            return Reviews.comments(db, job_id)

    @public.post("/{job_id}/comments", response_model=ReviewComment, status_code=201)
    def add_comment(job_id: str, request: ReviewCommentCreate,
                    idempotency_key: Annotated[str | None, Header(max_length=200)] = None):
        with jobs.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return Reviews.add(db, jobs.require(db, job_id), request, idempotency_key or str(uuid4()))

    @public.delete("/{job_id}/comments/{comment_id}", status_code=204)
    def remove_comment(job_id: str, comment_id: str):
        with jobs.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            jobs.require(db, job_id)
            row = db.execute("SELECT submitted_job_id FROM review_comments WHERE id=? AND job_id=?", (comment_id, job_id)).fetchone()
            if row is None:
                raise HTTPException(404, "批注不存在。")
            if row[0]:
                raise HTTPException(409, "已提交的批注是修订依据，不能删除；请在新版本继续反馈。")
            db.execute("DELETE FROM review_comments WHERE id=?", (comment_id,))
        return Response(status_code=204)

    @public.post("/{job_id}/feedback", response_model=GenerationJobDetail, status_code=202)
    def submit_feedback(job_id: str, request: ReviewSubmission,
                        idempotency_key: Annotated[str | None, Header(max_length=200)] = None):
        if not settings.agent_enabled or not settings.worker_token:
            raise HTTPException(503, "模型服务尚未配置；可以先保存批注。")
        with jobs.connect() as db:
            parent = jobs.require(db, job_id)
            jobs.require_consistent_scope(parent)
            skills = [SkillSnapshot(**value) for value in json.loads(parent["skills"])]
        body = GenerationJobCreate(project_id=parent["project_id"], conversation_id=parent["conversation_id"],
                                   module=parent["module"], goal=parent["goal"], target_units=parent["target_units"],
                                   count_override=bool(parent["count_override"]), batch_size=parent["batch_size"], max_revision_rounds=parent["max_revision_rounds"])
        return jobs.create(body, idempotency_key or str(uuid4()), skills, settings.llm_model, settings.review_model,
                           sources=documents.sources(job_id), parent_id=job_id, review_request=request)

    @public.post("/{job_id}/continue", response_model=GenerationJobDetail)
    def continue_job(job_id: str, request: RunLimits):
        if not settings.agent_enabled or not settings.worker_token:
            raise HTTPException(503, "模型服务尚未配置。")
        return jobs.continue_with_budget(job_id, request.max_model_calls, request.max_total_tokens)

    @public.get("/{job_id}/events", response_model=list[GenerationJobEvent])
    def get_events(job_id: str, after: int = Query(0, ge=0)) -> list[GenerationJobEvent]:
        return jobs.events(job_id, after)

    @public.get("/{job_id}/export")
    def get_export(job_id: str):
        jobs.detail(job_id)
        return export_status(job_id, documents)

    @public.post("/{job_id}/export")
    def export(job_id: str):
        return queue_export(jobs.detail(job_id), jobs, projects, documents)

    @public.post("/{job_id}/export/retry")
    def retry_export(job_id: str):
        jobs.detail(job_id)
        documents.retry(f"export:{job_id}")
        return export_status(job_id, documents)

    @public.get("/{job_id}/export/{format}")
    def export_download(job_id: str, format: Literal["pptx", "docx", "pdf"]):
        jobs.detail(job_id)
        return FileResponse(exported_file(job_id, f"archflow.{format}", documents), filename=f"archflow-{job_id}.{format}")

    @public.get("/{job_id}/preview/{page}")
    def preview(job_id: str, page: int):
        jobs.detail(job_id)
        if page < 1 or page > 2000:
            raise HTTPException(404, "页码不存在。")
        return FileResponse(exported_file(job_id, f"page-{page}.jpg", documents), media_type="image/jpeg")

    @public.post("/{job_id}/{action}", response_model=GenerationJobDetail)
    def control_job(job_id: str, action: Literal["approve", "cancel", "retry"]) -> GenerationJobDetail:
        detail = jobs.control(job_id, action)
        if action == "approve" and detail.status == "completed":
            queue_export(detail, jobs, projects, documents)
        return detail

    @public.get("/{job_id}/download")
    def download(job_id: str) -> StreamingResponse:
        detail = jobs.detail(job_id)
        if detail.status not in {"completed", "needs_review", "failed", "cancelled"}:
            raise HTTPException(409, "Wait until generation stops before downloading a draft.")

        def content():
            yield '{"job":' + detail.model_dump_json() + ',"units":['
            with jobs.connect() as db:
                db.execute("BEGIN")
                rows = db.execute("SELECT payload FROM generation_units WHERE job_id=? AND kind='draft' ORDER BY unit_index", (job_id,))
                for index, row in enumerate(rows):
                    yield ("," if index else "") + row[0]
            yield "]}"

        return StreamingResponse(content(), media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="archflow-{job_id}-draft.json"',
            "Cache-Control": "no-store",
        })

    @internal.post("/claim", response_model=ClaimedJob | None)
    def claim() -> ClaimedJob | None:
        return jobs.claim()

    @internal.get("/{job_id}/sources")
    def source_pages(job_id: str, query: str = "", source_id: str | None = None):
        jobs.detail(job_id)
        return documents.search(job_id, query[:200], source_id)

    @internal.get("/{job_id}/images")
    def source_image(job_id: str, image_id: str):
        jobs.detail(job_id)
        path = documents.asset(job_id, image_id)
        if path.stat().st_size > 4 * 1024 * 1024:
            raise HTTPException(413, "图片超过模型读取上限。")
        return {"data": base64.b64encode(path.read_bytes()).decode(), "mime_type": "image/jpeg"}

    @internal.get("/{job_id}/review-units", response_model=list[ArtifactUnit])
    def review_units(job_id: str, kind: Literal["storyboard", "draft"], offset: int = Query(0, ge=0), limit: int = Query(5, ge=1, le=5)):
        detail = jobs.detail(job_id)
        if not detail.review_request:
            raise HTTPException(404, "此任务没有上一版审阅素材。")
        return jobs.units(detail.review_request.parent_id, kind, offset, limit)

    @internal.post("/{job_id}/heartbeat", status_code=204)
    def heartbeat(job_id: str, lease_id: Annotated[str, Header()]) -> Response:
        jobs.heartbeat(job_id, lease_id)
        return Response(status_code=204)

    @internal.post("/{job_id}/progress", status_code=204)
    def progress(job_id: str, request: WorkerProgress, lease_id: Annotated[str, Header()]) -> Response:
        jobs.progress(job_id, lease_id, request)
        return Response(status_code=204)

    @internal.post("/{job_id}/checkpoint", response_model=GenerationJobDetail)
    def checkpoint(job_id: str, request: JobCheckpoint,
                   lease_id: Annotated[str, Header()]) -> GenerationJobDetail:
        detail = jobs.checkpoint(job_id, lease_id, request)
        if detail.status in {"completed", "needs_review"} and jobs.units(job_id, "draft", 0, 1):
            queue_export(detail, jobs, projects, documents)
        return detail

    @internal.post("/{job_id}/calls/{operation}", status_code=204)
    def record_call(job_id: str, operation: Literal["reserve", "usage"], request: UsageRecord,
                    lease_id: Annotated[str, Header()]) -> Response:
        if operation == "reserve":
            jobs.reserve_call(job_id, lease_id, request)
        else:
            jobs.usage(job_id, lease_id, request)
        return Response(status_code=204)

    return public, internal
