from dataclasses import dataclass
from os import getenv
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    upload_dir: Path
    allowed_origins: tuple[str, ...]
    max_upload_bytes: int = 50 * 1024 * 1024


def load_settings() -> Settings:
    origins = tuple(
        origin.strip()
        for origin in getenv("ARCHFLOW_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
        if origin.strip()
    )
    return Settings(
        upload_dir=Path(getenv("ARCHFLOW_UPLOAD_DIR", ".local/uploads")),
        allowed_origins=origins,
    )
