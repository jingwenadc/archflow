import secrets
import base64
import json
import re
import shutil
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from fastapi.responses import StreamingResponse, FileResponse

from .config import Settings
from .conversation_repository import ConversationRepository
from .job_repository import JobRepository, snapshot_skills
from .models import (
    AgentMemory, ArtifactUnit, ClaimedJob, GenerationJobCreate, GenerationJobDetail,
    GenerationJobEvent, GenerationJobRecord, JobCheckpoint, UsageRecord, WorkerProgress, WorkerDiagnostic, RunLimits,
    ReviewComment, ReviewCommentCreate, ReviewSubmission, SkillSnapshot, UnitBatch,
)
from .project_repository import ProjectRepository
from .materials import DocumentRepository, collect_materials
from .artifacts import queue_export, export_status, exported_file
from .reviews import Reviews
from .auth import require_admin
from .call_traces import CallTraces


def job_routers(settings: Settings, projects: ProjectRepository,
                conversations: ConversationRepository) -> tuple[APIRouter, APIRouter]:
    jobs = JobRepository(settings.database_path)
    documents = DocumentRepository(settings.database_path)
    traces = CallTraces(settings.project_dir)
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

    @public.get("/{job_id}/source-citations")
    def source_citations(job_id: str) -> list[dict]:
        jobs.detail(job_id)
        return [{"file_id": source["file_id"], "name": source["name"], "page_count": source["page_count"]}
                for source in documents.catalog(job_id)]

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
        detail = jobs.detail(job_id)
        completed = len(jobs.units(job_id, "draft", 0, 500))
        if completed != detail.target_units:
            return {"status": "incomplete", "requested": True, "result": None,
                "error": f"已保存 {completed} / {detail.target_units} 页；完成所有页面后才能导出完整文件。"}
        return export_status(job_id, documents)

    @public.post("/{job_id}/export")
    def export(job_id: str):
        return queue_export(jobs.detail(job_id), jobs, projects, documents)

    @public.post("/{job_id}/export/retry")
    def retry_export(job_id: str):
        detail = jobs.detail(job_id)
        if len(jobs.units(job_id, "draft", 0, 500)) != detail.target_units:
            raise HTTPException(409, "页面未全部完成，不能重试导出。")
        documents.retry(f"export:{job_id}")
        return export_status(job_id, documents)

    @public.get("/{job_id}/export/{format}")
    def export_download(job_id: str, format: Literal["pptx", "docx", "pdf"]):
        detail = jobs.detail(job_id)
        if len(jobs.units(job_id, "draft", 0, 500)) != detail.target_units:
            raise HTTPException(409, "此版本尚未完成全部内容，不能下载为完整文件。")
        return FileResponse(exported_file(job_id, f"archflow.{format}", documents), filename=f"archflow-{job_id}.{format}")

    @public.get("/{job_id}/preview/{page}")
    def preview(job_id: str, page: int):
        detail = jobs.detail(job_id)
        if len(jobs.units(job_id, "draft", 0, 500)) != detail.target_units:
            raise HTTPException(409, "此版本尚未完成全部内容，不能显示旧的部分导出预览。")
        if page < 1 or page > 2000:
            raise HTTPException(404, "页码不存在。")
        return FileResponse(exported_file(job_id, f"page-{page}.jpg", documents), media_type="image/jpeg")

    @public.post("/{job_id}/{action}", response_model=GenerationJobDetail)
    def control_job(job_id: str, action: Literal["approve", "cancel", "retry"]) -> GenerationJobDetail:
        detail = jobs.control(job_id, action)
        if action == "approve" and detail.status == "completed":
            queue_export(detail, jobs, projects, documents)
        return detail

    def diagnostic_content(job_id: str, detail: GenerationJobDetail, include_model_io: bool):
        yield '{"job":' + detail.model_dump_json() + ',"units":['
        with jobs.connect() as db:
            db.execute("BEGIN")
            rows = db.execute("SELECT payload FROM generation_units WHERE job_id=? AND kind='draft' ORDER BY unit_index", (job_id,))
            for index, row in enumerate(rows):
                yield ("," if index else "") + row[0]
            yield '],"workflow_events":['
            rows = db.execute("SELECT id,event_type,message,created_at FROM generation_events WHERE job_id=? AND event_type!='diagnostic' ORDER BY id", (job_id,))
            for index, row in enumerate(rows):
                yield ("," if index else "") + json.dumps(dict(row), ensure_ascii=False)
            yield '],"diagnostics":['
            rows = db.execute("SELECT id,created_at,message FROM generation_events WHERE job_id=? AND event_type='diagnostic' ORDER BY id", (job_id,))
            for index, row in enumerate(rows):
                yield ("," if index else "") + json.dumps({"id": row[0], "time": row[1], **json.loads(row[2])}, ensure_ascii=False)
            yield '],"model_calls":['
            rows = db.execute("SELECT call_id,model,total_tokens FROM generation_calls WHERE job_id=? ORDER BY rowid", (job_id,))
            for index, row in enumerate(rows):
                yield ("," if index else "") + json.dumps(dict(row), ensure_ascii=False)
            if include_model_io:
                yield '],"model_io":['
                rows = db.execute("SELECT call_id FROM generation_calls WHERE job_id=? ORDER BY rowid", (job_id,))
                for index, row in enumerate(rows):
                    trace = traces.read(detail.project_id, job_id, row[0])
                    status = "complete" if "request" in trace and "response" in trace else "partial" if trace else "missing"
                    yield ("," if index else "") + json.dumps({"call_id": row[0], "trace_status": status, **trace}, ensure_ascii=False)
        yield "]}"

    @public.get("/{job_id}/download")
    def download(job_id: str) -> StreamingResponse:
        detail = jobs.detail(job_id)
        if detail.status not in {"completed", "needs_review", "failed", "cancelled"}:
            raise HTTPException(409, "Wait until generation stops before downloading a draft.")

        return StreamingResponse(diagnostic_content(job_id, detail, False), media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="archflow-{job_id}-draft.json"',
            "Cache-Control": "no-store",
        })

    @public.get("/{job_id}/debug-download")
    def admin_debug_download(job_id: str) -> StreamingResponse:
        require_admin()
        detail = jobs.detail(job_id)
        return StreamingResponse(diagnostic_content(job_id, detail, True), media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="archflow-{job_id}-debug.json"',
            "Cache-Control": "no-store",
        })

    @public.get("/{job_id}/model-calls")
    def admin_model_calls(job_id: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=200)):
        require_admin()
        with jobs.connect() as db:
            jobs.require(db, job_id)
            return [dict(row) for row in db.execute(
                "SELECT call_id,model,total_tokens FROM generation_calls WHERE job_id=? ORDER BY rowid LIMIT ? OFFSET ?",
                (job_id, limit, offset))]

    @public.get("/{job_id}/model-calls/{call_id}")
    def admin_model_call(job_id: str, call_id: str):
        require_admin()
        with jobs.connect() as db:
            job = jobs.require(db, job_id)
            if not db.execute("SELECT 1 FROM generation_calls WHERE job_id=? AND call_id=?", (job_id, call_id)).fetchone():
                raise HTTPException(404, "Model call not found.")
        return traces.read(job["project_id"], job_id, call_id)

    @internal.post("/claim", response_model=ClaimedJob | None)
    def claim() -> ClaimedJob | None:
        return jobs.claim()

    @internal.get("/{job_id}/memory", response_model=AgentMemory | None)
    def memory(job_id: str, lease_id: Annotated[str, Header()]) -> AgentMemory | None:
        return jobs.memory(job_id, lease_id)

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

    @internal.get("/{job_id}/skill-images")
    def skill_image(job_id: str, path: str, lease_id: Annotated[str, Header()]):
        match = re.fullmatch(r"/skills/([^/]+)/(?P<asset>assets/[^/]+\.(?:jpg|jpeg|png))", path)
        if not match:
            raise HTTPException(404, "Skill visual not found.")
        with jobs.connect() as db:
            row = jobs.leased(db, job_id, lease_id)
            snapshot = next((skill for skill in json.loads(row["skills"]) if skill["slug"] == match.group(1)), None)
            digest = snapshot and snapshot.get("images", {}).get(match.group("asset"))
            asset = db.execute("SELECT data FROM skill_assets WHERE digest=?", (digest,)).fetchone() if digest else None
        if asset is None:
            raise HTTPException(404, "Skill visual not found in this frozen job snapshot.")
        return {"data": base64.b64encode(asset[0]).decode(),
                "mime_type": "image/png" if path.endswith(".png") else "image/jpeg"}

    @internal.post("/{job_id}/slide-previews", status_code=202)
    def start_slide_preview(job_id: str, request: UnitBatch, lease_id: Annotated[str, Header()]):
        with jobs.connect() as db:
            row = jobs.leased(db, job_id, lease_id)
        if row["module"] != "concept" or row["stage"] != "generating":
            raise HTTPException(409, "Only active concept drafts can be previewed.")
        active = next((batch for batch in jobs.detail(job_id).batches if batch.status != "completed"), None)
        if active is None or [unit.unit_index for unit in request.units] != list(range(active.start_unit, active.end_unit + 1)):
            raise HTTPException(422, "Preview must contain the complete active batch in order.")
        if active.status != "draft" and any(unit.slide is None for unit in request.units):
            raise HTTPException(422, "Every previewed concept page needs an editable slide composition.")
        allowed_images = {asset["id"] for doc in documents.sources(job_id) for asset in doc["assets"]}
        if any(element.image_id not in allowed_images for unit in request.units for element in unit.slide.elements if element.image_id):
            raise HTTPException(422, "Image does not belong to this project's frozen materials.")
        preview_id = str(uuid4())
        folder = projects.root / row["project_id"] / "workspace" / "previews" / job_id / preview_id
        folder.mkdir(parents=True)
        (folder / "input.json").write_text(json.dumps({"module": "concept", "purpose": "agent-preview", "title": row["goal"][:80],
            "units": [unit.model_dump() for unit in request.units], "sources": documents.sources(job_id)}, ensure_ascii=False), "utf-8")
        documents.queue(f"preview:{preview_id}", "preview", row["project_id"], folder)
        return {"preview_id": preview_id}

    @internal.get("/{job_id}/slide-previews/{preview_id}")
    def slide_preview(job_id: str, preview_id: str, lease_id: Annotated[str, Header()]):
        with jobs.connect() as db:
            row = jobs.leased(db, job_id, lease_id)
        try:
            preview_id = str(UUID(preview_id))
        except ValueError:
            raise HTTPException(404, "Preview not found.")
        folder = projects.root / row["project_id"] / "workspace" / "previews" / job_id / preview_id
        work_id = f"preview:{preview_id}"
        work = documents.status(work_id)
        if work.get("path") != str(folder) or work.get("kind") != "preview":
            raise HTTPException(404, "Preview not found.")
        if work["status"] in {"queued", "processing"}:
            return {"status": work["status"]}
        if work["status"] == "failed":
            result = {"status": "failed", "error": work["error"]}
            shutil.rmtree(folder, ignore_errors=True)
            with documents.connect() as db:
                db.execute("DELETE FROM document_work WHERE id=? AND kind='preview'", (work_id,))
            return result
        images = sorted(folder.glob("page-*.jpg"), key=lambda path: int(path.stem.split("-")[-1]))
        if len(images) != work["result"]["page_count"] or len(images) > 10:
            raise HTTPException(500, "Rendered preview is incomplete.")
        result = {"status": "ready", "images": [{"data": base64.b64encode(image.read_bytes()).decode(),
            "mime_type": "image/jpeg"} for image in images]}
        shutil.rmtree(folder)
        with documents.connect() as db:
            db.execute("DELETE FROM document_work WHERE id=? AND kind='preview'", (work_id,))
        return result

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

    @internal.post("/{job_id}/diagnostics", status_code=204)
    def diagnostic(job_id: str, request: WorkerDiagnostic, lease_id: Annotated[str, Header()]) -> Response:
        jobs.diagnostic(job_id, lease_id, request)
        return Response(status_code=204)

    @internal.post("/{job_id}/checkpoint", response_model=GenerationJobDetail)
    def checkpoint(job_id: str, request: JobCheckpoint,
                   lease_id: Annotated[str, Header()]) -> GenerationJobDetail:
        detail = jobs.checkpoint(job_id, lease_id, request)
        if detail.status in {"completed", "needs_review"} and len(jobs.units(job_id, "draft", 0, 500)) == detail.target_units:
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

    @internal.post("/{job_id}/calls/{call_id}/trace", status_code=204)
    def record_trace(job_id: str, call_id: str, request: dict, lease_id: Annotated[str, Header()]):
        with jobs.connect() as db:
            row = jobs.leased(db, job_id, lease_id)
            if not db.execute("SELECT 1 FROM generation_calls WHERE job_id=? AND call_id=?", (job_id, call_id)).fetchone():
                raise HTTPException(404, "Reserved model call not found.")
        phase, data = request.get("phase"), request.get("data")
        if not isinstance(data, dict):
            raise HTTPException(422, "Trace data must be an object.")
        traces.save(row["project_id"], job_id, call_id, phase, data)
        return Response(status_code=204)

    return public, internal
