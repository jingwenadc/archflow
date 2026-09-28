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
    GenerationJobEvent, GenerationJobRecord, JobCheckpoint, UsageRecord,
)
from .project_repository import ProjectRepository
from .materials import DocumentRepository, collect_materials
from .artifacts import queue_export, export_status, exported_file


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
        if old.status not in {"completed", "needs_review", "cancelled", "failed"}:
            raise HTTPException(409, "请先等待任务结束或取消，然后创建新版本。")
        instruction = str(request.get("instruction", "")).strip()
        indices = request.get("units", [])
        if not instruction or len(instruction) > 4000 or not indices or not all(type(i) is int and 1 <= i <= old.target_units for i in indices):
            raise HTTPException(422, "请提供修改要求与有效页码范围。")
        if len(jobs.units(old.id, "draft", 0, 500)) != old.target_units:
            raise HTTPException(409, "原版本尚未生成完整内容，请先补齐或重新整理提纲。")
        body = GenerationJobCreate(project_id=old.project_id, conversation_id=old.conversation_id, module=old.module,
                                   goal=(old.goal[:15000] + "\n本次修改要求：" + instruction), target_units=old.target_units,
                                   batch_size=old.batch_size, max_revision_rounds=old.max_revision_rounds,
                                   max_model_calls=old.max_model_calls, max_total_tokens=old.max_total_tokens)
        created = jobs.create(body, idempotency_key or str(uuid4()), snapshot_skills(settings.repository_root), settings.llm_model, settings.review_model,
                              sources=documents.sources(old.id), parent_id=old.id, revision_units=sorted(set(indices)))
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

    @public.post("/{job_id}/continue", response_model=GenerationJobDetail)
    def continue_job(job_id: str, request: dict):
        if not settings.agent_enabled or not settings.worker_token:
            raise HTTPException(503, "模型服务尚未配置。")
        return jobs.continue_with_budget(job_id, request.get("max_model_calls"), request.get("max_total_tokens"))

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
        return jobs.control(job_id, action)

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

    @internal.post("/{job_id}/heartbeat", status_code=204)
    def heartbeat(job_id: str, lease_id: Annotated[str, Header()]) -> Response:
        jobs.heartbeat(job_id, lease_id)
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
