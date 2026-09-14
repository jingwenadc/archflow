from pathlib import Path

from fastapi.testclient import TestClient

from archflow_api.config import Settings
from archflow_api.main import create_app


def make_client(upload_dir: Path) -> TestClient:
    app = create_app(Settings(upload_dir=upload_dir, allowed_origins=("http://localhost:3000",)))
    return TestClient(app)


def test_health(tmp_path: Path) -> None:
    response = make_client(tmp_path).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_capabilities_keep_ai_disabled(tmp_path: Path) -> None:
    response = make_client(tmp_path).get("/api/v1/capabilities")
    assert response.status_code == 200
    assert response.json()["workflow_engine"] == "tbd"
    assert response.json()["chat"] is False


def test_upload_supported_file(tmp_path: Path) -> None:
    response = make_client(tmp_path).post(
        "/api/v1/files",
        files={"file": ("brief.pdf", b"review content", "application/pdf")},
    )
    assert response.status_code == 201
    assert response.json()["name"] == "brief.pdf"
    assert response.json()["status"] == "uploaded"
    assert next(tmp_path.rglob("original.pdf")).read_bytes() == b"review content"


def test_upload_rejects_cad(tmp_path: Path) -> None:
    response = make_client(tmp_path).post(
        "/api/v1/files",
        files={"file": ("plan.dwg", b"not enabled", "application/octet-stream")},
    )
    assert response.status_code == 415
