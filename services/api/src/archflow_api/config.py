from dataclasses import dataclass
from os import getenv
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    upload_dir: Path
    allowed_origins: tuple[str, ...]
    max_upload_bytes: int = 50 * 1024 * 1024
    repository_root: Path = Path(".")
    github_repository: str = "jingwenadc/archflow"
    github_base_branch: str = "main"
    github_token: str | None = None


def load_settings() -> Settings:
    origins = tuple(
        origin.strip()
        for origin in getenv("ARCHFLOW_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
        if origin.strip()
    )
    return Settings(
        upload_dir=Path(getenv("ARCHFLOW_UPLOAD_DIR", ".local/uploads")),
        allowed_origins=origins,
        repository_root=Path(
            getenv("ARCHFLOW_REPOSITORY_ROOT", Path(__file__).resolve().parents[4])
        ),
        github_repository=getenv("ARCHFLOW_GITHUB_REPOSITORY", "jingwenadc/archflow"),
        github_base_branch=getenv("ARCHFLOW_GITHUB_BASE_BRANCH", "main"),
        github_token=getenv("ARCHFLOW_GITHUB_TOKEN") or None,
    )
