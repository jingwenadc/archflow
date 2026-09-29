import json
from pathlib import Path

from fastapi import HTTPException

from .materials import DocumentRepository
from .citations import display_citations


def queue_export(job, jobs, projects, documents: DocumentRepository) -> dict:
    # Failed jobs may resume and change units; their diagnostic JSON remains available.
    if job.status not in {"completed", "needs_review"}:
        raise HTTPException(409, "完成生成或进入人工复核后才能排版。失败任务请先从检查点继续；诊断草稿仍可下载。")
    units = jobs.units(job.id, "draft", 0, 500)
    if not units:
        raise HTTPException(409, "尚无已生成的页面。")
    folder = projects.root / job.project_id / "workspace" / "versions" / job.id
    folder.mkdir(parents=True, exist_ok=True)
    sources = documents.sources(job.id)
    rendered_units = [unit.model_dump() for unit in units]
    for unit in rendered_units:
        unit["title"] = display_citations(unit["title"], sources)
        unit["body"] = display_citations(unit["body"], sources)
    request = {"title": display_citations(job.outline.summary[:80] if job.outline else job.goal[:80], sources), "module": job.module,
               "units": rendered_units, "sources": sources}
    path = folder / "input.json"
    if not path.exists():
        path.write_text(json.dumps(request, ensure_ascii=False), "utf-8")
    documents.queue(f"export:{job.id}", "export", job.project_id, folder)
    return export_status(job.id, documents)


def export_status(job_id: str, documents: DocumentRepository) -> dict:
    work = documents.status(f"export:{job_id}")
    return {"status": work["status"], "error": work["error"], "result": work["result"], "requested": "path" in work}


def exported_file(job_id: str, filename: str, documents: DocumentRepository) -> Path:
    work = documents.status(f"export:{job_id}")
    if work["status"] != "ready" or "path" not in work:
        raise HTTPException(409, "文件还未渲染完成。")
    path = Path(work["path"]) / filename
    if not path.is_file():
        raise HTTPException(404, "文件或页面不存在。")
    return path
