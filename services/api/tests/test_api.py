from pathlib import Path

from fastapi.testclient import TestClient

from archflow_api.config import Settings
from archflow_api.main import create_app


def make_client(upload_dir: Path) -> TestClient:
    repository_root = Path(__file__).resolve().parents[3]
    app = create_app(
        Settings(
            upload_dir=upload_dir / "uploads",
            allowed_origins=("http://localhost:3000",),
            project_dir=upload_dir / "projects",
            case_upload_dir=upload_dir / "cases",
            database_path=upload_dir / "archflow.sqlite3",
            repository_root=repository_root,
        )
    )
    return TestClient(app)


def test_health(tmp_path: Path) -> None:
    response = make_client(tmp_path).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_capabilities_expose_persistent_chat(tmp_path: Path) -> None:
    response = make_client(tmp_path).get("/api/v1/capabilities")
    assert response.status_code == 200
    assert response.json()["workflow_engine"] == "tbd"
    assert response.json()["chat"] is True


def test_upload_supported_file(tmp_path: Path) -> None:
    response = make_client(tmp_path).post(
        "/api/v1/files",
        files={"file": ("brief.pdf", b"review content", "application/pdf")},
    )
    assert response.status_code == 201
    assert response.json()["name"] == "brief.pdf"
    assert response.json()["status"] == "uploaded"
    assert next((tmp_path / "uploads").rglob("original.pdf")).read_bytes() == b"review content"


def test_upload_rejects_cad(tmp_path: Path) -> None:
    response = make_client(tmp_path).post(
        "/api/v1/files",
        files={"file": ("plan.dwg", b"not enabled", "application/octet-stream")},
    )
    assert response.status_code == 415


def test_create_project_builds_isolated_workspace(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    response = client.post("/api/v1/projects", json={"name": "  新医院  项目  "})

    assert response.status_code == 201
    project = response.json()
    assert project["name"] == "新医院 项目"
    project_dir = tmp_path / "projects" / project["id"]
    assert (project_dir / "metadata.json").exists()
    assert (project_dir / "uploads").is_dir()
    assert (project_dir / "workspace").is_dir()
    projects = client.get("/api/v1/projects").json()
    assert any(item["id"] == "cold-chain-industrial-park" for item in projects)
    assert any(item["id"] == project["id"] for item in projects)


def test_project_name_cannot_be_blank(tmp_path: Path) -> None:
    response = make_client(tmp_path).post("/api/v1/projects", json={"name": "   "})
    assert response.status_code == 422


def test_conversation_and_messages_persist(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    conversation = client.post("/api/v1/conversations", json={
        "project_id": "cold-chain-industrial-park", "module": "concept", "title": "方案 PPT V1",
    })
    assert conversation.status_code == 201
    conversation_id = conversation.json()["id"]
    message = client.post(f"/api/v1/conversations/{conversation_id}/messages", json={"content": "整理项目条件"})
    assert message.status_code == 201
    assert message.json()["role"] == "user"
    assert client.get(f"/api/v1/conversations/{conversation_id}/messages").json()[0]["content"] == "整理项目条件"


def test_case_upload_uses_separate_storage(tmp_path: Path) -> None:
    response = make_client(tmp_path).post(
        "/api/v1/cases/files",
        files={"file": ("reference.pptx", b"case content", "application/vnd.ms-powerpoint")},
    )
    assert response.status_code == 201
    assert response.json()["name"] == "reference.pptx"
    assert next((tmp_path / "cases").rglob("original.pptx")).read_bytes() == b"case content"


def test_skill_detail_contains_all_files(tmp_path: Path) -> None:
    response = make_client(tmp_path).get("/api/v1/skills/architectural-concept-presentation")
    assert response.status_code == 200
    files = response.json()["files"]
    assert any(file["path"] == "SKILL.md" and file["content"] for file in files)
    assert any(file["path"] == "assets/reference-atlas-campus.jpg" and not file["editable"] for file in files)


def test_draft_pr_requires_server_integration(tmp_path: Path) -> None:
    response = make_client(tmp_path).post(
        "/api/v1/skills/architectural-concept-presentation/draft-pr",
        json={
            "title": "Update skill guidance",
            "description": "Review draft",
            "changes": [{"path": "SKILL.md", "content": "# Updated"}],
        },
    )
    assert response.status_code == 503
    assert "GitHub integration" in response.json()["detail"]
