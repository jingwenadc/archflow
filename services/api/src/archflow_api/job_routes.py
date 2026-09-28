import secrets
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.responses import StreamingResponse

from .config import Settings
from .conversation_repository import ConversationRepository
from .job_repository import JobRepository, snapshot_skills
from .models import (
    ArtifactUnit, ClaimedJob, GenerationJobCreate, GenerationJobDetail,
    GenerationJobEvent, GenerationJobRecord, JobCheckpoint, UsageRecord,
)
from .project_repository import ProjectRepository


def job_routers(settings: Settings, projects: ProjectRepository,
                conversations: ConversationRepository) -> tuple[APIRouter, APIRouter]:
    jobs = JobRepository(settings.database_path)
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
        return jobs.create(request, idempotency_key or str(uuid4()), snapshot_skills(settings.repository_root),
                           settings.llm_model, settings.review_model)

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

    @public.get("/{job_id}/events", response_model=list[GenerationJobEvent])
    def get_events(job_id: str, after: int = Query(0, ge=0)) -> list[GenerationJobEvent]:
        return jobs.events(job_id, after)

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

    @internal.post("/{job_id}/heartbeat", status_code=204)
    def heartbeat(job_id: str, lease_id: Annotated[str, Header()]) -> Response:
        jobs.heartbeat(job_id, lease_id)
        return Response(status_code=204)

    @internal.post("/{job_id}/checkpoint", response_model=GenerationJobDetail)
    def checkpoint(job_id: str, request: JobCheckpoint,
                   lease_id: Annotated[str, Header()]) -> GenerationJobDetail:
        return jobs.checkpoint(job_id, lease_id, request)

    @internal.post("/{job_id}/calls/{operation}", status_code=204)
    def record_call(job_id: str, operation: Literal["reserve", "usage"], request: UsageRecord,
                    lease_id: Annotated[str, Header()]) -> Response:
        if operation == "reserve":
            jobs.reserve_call(job_id, lease_id, request)
        else:
            jobs.usage(job_id, lease_id, request)
        return Response(status_code=204)

    return public, internal
