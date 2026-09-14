from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import Settings, load_settings
from .models import CapabilitySet, FileRecord, SkillSummary
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
            chat=False,
            generation=False,
            workflow_engine="tbd",
        )

    @app.get("/api/v1/skills", response_model=list[SkillSummary])
    def list_skills() -> tuple[SkillSummary, ...]:
        return SKILLS

    @app.post("/api/v1/files", response_model=FileRecord, status_code=201)
    async def upload_file(file: UploadFile = File(...)) -> FileRecord:
        return await storage.save(file)

    return app


app = create_app()
