from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status

from .models import FileRecord
from .materials import DocumentRepository


ALLOWED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
}


class LocalFileStorage:
    """Review-only storage adapter. Replace with S3 without changing API routes."""

    def __init__(self, root: Path, max_bytes: int, documents: DocumentRepository | None = None, project_id: str = "") -> None:
        self.root = root
        self.max_bytes = max_bytes
        self.documents = documents
        self.project_id = project_id

    def list(self) -> list[FileRecord]:
        self.root.mkdir(parents=True, exist_ok=True)
        records: list[tuple[float, FileRecord]] = []
        for metadata_path in self.root.glob("*/metadata.json"):
            try:
                record = FileRecord.model_validate_json(metadata_path.read_text("utf-8"))
                if self.documents:
                    self.documents.queue(record.id, "material", self.project_id, metadata_path.parent)
                    work = self.documents.status(record.id)
                    record.processing_status = work["status"]
                    record.processing_error = work["error"]
                    record.page_count = (work["result"] or {}).get("page_count", 0)
                records.append((metadata_path.stat().st_mtime, record))
            except (OSError, ValueError):
                continue
        return [record for _, record in sorted(records, key=lambda item: item[0], reverse=True)]

    async def save(self, upload: UploadFile) -> FileRecord:
        original_name = Path(upload.filename or "unnamed").name
        extension = Path(original_name).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="Unsupported file type. CAD, DXF, SketchUp and PKPM files are not enabled in v1.",
            )

        file_id = str(uuid4())
        target_dir = self.root / file_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"original{extension}"
        metadata_path = target_dir / "metadata.json"
        size = 0
        content_type = upload.content_type or "application/octet-stream"

        try:
            with target.open("xb") as output:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > self.max_bytes:
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="File exceeds the 50 MB review limit.",
                        )
                    output.write(chunk)
            record = FileRecord(
                id=file_id,
                name=original_name,
                size=size,
                content_type=content_type,
                status="uploaded",
                role="reference" if extension in {".ppt", ".pptx"} else "image" if extension in {".jpg", ".jpeg", ".png", ".webp"} else "source",
            )
            metadata_path.write_text(record.model_dump_json(indent=2), encoding="utf-8")
            if self.documents:
                self.documents.queue(file_id, "material", self.project_id, target_dir)
        except Exception:
            target.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            target_dir.rmdir()
            raise
        finally:
            await upload.close()

        return record
