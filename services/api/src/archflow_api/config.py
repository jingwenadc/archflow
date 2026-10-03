from dataclasses import dataclass
from os import getenv
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    upload_dir: Path
    allowed_origins: tuple[str, ...]
    max_upload_bytes: int = 50 * 1024 * 1024
    project_dir: Path = Path(".local/projects")
    case_upload_dir: Path = Path(".local/cases")
    database_path: Path = Path(".local/archflow.sqlite3")
    repository_root: Path = Path(".")
    github_repository: str = "jingwenadc/archflow"
    github_base_branch: str = "main"
    github_token: str | None = None
    llm_model: str = "gpt-6-astra"
    review_model: str = "gpt-6-astra"
    agent_enabled: bool = False
    worker_token: str | None = None
    signup_code: str | None = None
    secure_cookies: bool = False


def load_settings() -> Settings:
    origins = tuple(
        origin.strip()
        for origin in getenv("ARCHFLOW_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
        if origin.strip()
    )
    return Settings(
        upload_dir=Path(getenv("ARCHFLOW_UPLOAD_DIR", ".local/uploads")),
        allowed_origins=origins,
        project_dir=Path(getenv("ARCHFLOW_PROJECT_DIR", ".local/projects")),
        case_upload_dir=Path(getenv("ARCHFLOW_CASE_UPLOAD_DIR", ".local/cases")),
        database_path=Path(getenv("ARCHFLOW_DATABASE_PATH", ".local/archflow.sqlite3")),
        repository_root=Path(
            getenv("ARCHFLOW_REPOSITORY_ROOT", Path(__file__).resolve().parents[4])
        ),
        github_repository=getenv("ARCHFLOW_GITHUB_REPOSITORY", "jingwenadc/archflow"),
        github_base_branch=getenv("ARCHFLOW_GITHUB_BASE_BRANCH", "main"),
        github_token=getenv("ARCHFLOW_GITHUB_TOKEN") or None,
        llm_model=getenv("ARCHFLOW_LLM_MODEL", "gpt-6-astra"),
        review_model=getenv("ARCHFLOW_REVIEW_MODEL", "gpt-6-astra"),
        agent_enabled=getenv("ARCHFLOW_AGENT_ENABLED", "false").lower() == "true",
        worker_token=getenv("ARCHFLOW_WORKER_TOKEN") or None,
        signup_code=getenv("ARCHFLOW_SIGNUP_CODE") or None,
        secure_cookies=getenv("ARCHFLOW_COOKIE_SECURE", "false").lower() == "true",
    )
