from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from archflow_api.auth import AuthStore
from archflow_api import bootstrap_admin
from archflow_api.config import Settings
from archflow_api.main import create_app


ROOT = Path(__file__).resolve().parents[3]
CODE = "a-long-random-signup-secret"


def client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(Settings(
        upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects",
        case_upload_dir=tmp_path / "cases", database_path=tmp_path / "db.sqlite3",
        repository_root=ROOT, allowed_origins=("http://localhost:3000",),
        signup_code=CODE, agent_enabled=True, worker_token="worker-test-token",
    )))


def signup(api: TestClient, username: str) -> None:
    response = api.post("/api/v1/auth/signup", json={
        "username": username, "password": "correct-horse-battery-456", "signup_code": CODE,
    })
    assert response.status_code == 201, response.text
    api.headers.update({"X-CSRF-Token": api.cookies["archflow_csrf"]})


def test_private_projects_and_nested_resources(tmp_path: Path) -> None:
    alice = client(tmp_path)
    bob = client(tmp_path)
    unauthenticated = alice.get("/api/v1/projects")
    assert unauthenticated.status_code == 401
    assert unauthenticated.headers["Cache-Control"] == "no-store"
    signup(alice, "alice")
    project = alice.post("/api/v1/projects", json={"name": "Private design"}).json()
    conversation = alice.post("/api/v1/conversations", json={
        "project_id": project["id"], "module": "concept", "title": "方案",
    }).json()
    assert alice.post(f"/api/v1/conversations/{conversation['id']}/messages", json={"content": "private brief"}).status_code == 201
    job_response = alice.post("/api/v1/jobs", json={
        "project_id": project["id"], "conversation_id": conversation["id"],
        "module": "concept", "goal": "private brief", "target_units": 2,
    })
    assert job_response.status_code == 202, job_response.text
    job_id = job_response.json()["id"]
    signup(bob, "bob")
    assert bob.get("/api/v1/projects").json() == []
    assert bob.get(f"/api/v1/conversations?project_id={project['id']}&module=concept").status_code == 404
    assert bob.get(f"/api/v1/conversations/{conversation['id']}/messages").status_code == 404
    assert bob.post(f"/api/v1/conversations/{conversation['id']}/rename", json={"title": "stolen"}).status_code == 404
    assert bob.get(f"/api/v1/jobs/{job_id}").status_code == 404
    assert bob.get(f"/api/v1/jobs/{job_id}/units").status_code == 404
    assert bob.get(f"/api/v1/jobs?project_id={project['id']}").status_code == 404
    assert bob.get(f"/api/v1/projects/{project['id']}/trash").status_code == 404
    assert bob.get(f"/api/v1/files?project_id={project['id']}").status_code == 404
    assert bob.post("/api/v1/projects", json={"name": "Bob's project"}).status_code == 201
    assert len(bob.get("/api/v1/projects").json()) == 1
    assert len(alice.get("/api/v1/projects").json()) == 1
    # Future invitations only need a membership record; no tenant migration.
    store = AuthStore(tmp_path / "db.sqlite3", CODE, False)
    with store.connect() as db:
        bob_id = db.execute("SELECT id FROM users WHERE username='bob'").fetchone()[0]
        db.execute("INSERT INTO project_members VALUES(?,?,?,?)", (project["id"], bob_id, "member", 1))
    assert len(bob.get("/api/v1/projects").json()) == 2
    assert bob.get(f"/api/v1/conversations/{conversation['id']}/messages").status_code == 200
    restarted = client(tmp_path)
    restarted.cookies.update(alice.cookies)
    assert restarted.get("/api/v1/projects").json() == [project]


def test_signup_code_is_required_and_attempts_are_bounded(tmp_path: Path) -> None:
    api = client(tmp_path)
    payload = {"username": "target", "password": "correct-horse-battery-456", "signup_code": "wrong"}
    for _ in range(8):
        assert api.post("/api/v1/auth/signup", json=payload).status_code == 403
    assert api.post("/api/v1/auth/signup", json=payload | {"signup_code": CODE}).status_code == 429


def test_legacy_project_is_assigned_to_bootstrapped_admin(tmp_path: Path, monkeypatch) -> None:
    legacy = TestClient(create_app(Settings(
        upload_dir=tmp_path / "uploads", project_dir=tmp_path / "projects",
        case_upload_dir=tmp_path / "cases", database_path=tmp_path / "db.sqlite3",
        allowed_origins=("http://localhost:3000",),
    )))
    old_project = legacy.post("/api/v1/projects", json={"name": "Existing project"}).json()
    monkeypatch.setenv("ARCHFLOW_SIGNUP_CODE", CODE)
    monkeypatch.setenv("ARCHFLOW_DATABASE_PATH", str(tmp_path / "db.sqlite3"))
    monkeypatch.setenv("ARCHFLOW_PROJECT_DIR", str(tmp_path / "projects"))
    monkeypatch.setattr("builtins.input", lambda _prompt: "owner")
    monkeypatch.setattr("getpass.getpass", lambda _prompt: "admin-password-long-123")
    bootstrap_admin.main()
    admin = client(tmp_path)
    assert admin.post("/api/v1/auth/login", json={
        "username": "owner", "password": "admin-password-long-123",
    }).status_code == 200
    assert old_project in admin.get("/api/v1/projects").json()
    members = admin.get(f"/api/v1/admin/projects/{old_project['id']}/members").json()
    assert members[0]["username"] == "owner" and members[0]["role"] == "owner"
    ordinary = client(tmp_path)
    signup(ordinary, "new-user")
    assert ordinary.get("/api/v1/projects").json() == []


def test_csrf_login_admin_and_full_call_trace(tmp_path: Path) -> None:
    user = client(tmp_path)
    signup(user, "alice")
    project = user.post("/api/v1/projects", json={"name": "Private"}).json()
    job = user.post("/api/v1/jobs", json={
        "project_id": project["id"], "module": "concept", "goal": "secret brief", "target_units": 1,
    }).json()
    no_csrf = client(tmp_path)
    no_csrf.cookies.update(user.cookies)
    assert no_csrf.post("/api/v1/projects", json={"name": "Denied"}).status_code == 403
    assert user.get(f"/api/v1/jobs/{job['id']}/model-calls").status_code == 403

    worker = client(tmp_path)
    headers = {"Authorization": "Bearer worker-test-token"}
    claim = worker.post("/internal/jobs/claim", headers=headers).json()
    assert claim["job"]["id"] == job["id"]
    lease = claim["lease_id"]
    call_id = str(uuid4())
    assert worker.post(f"/internal/jobs/{job['id']}/calls/reserve", json={
        "call_id": call_id, "model": "test-model", "total_tokens": 0,
    }, headers=headers | {"Lease-Id": lease}).status_code == 204
    for phase, data in (("request", {"body": {"input": "full secret prompt"}}),
                        ("response", {"message": {"output": "full secret answer"}})):
        response = worker.post(f"/internal/jobs/{job['id']}/calls/{call_id}/trace",
                               json={"phase": phase, "data": data}, headers=headers | {"Lease-Id": lease})
        assert response.status_code == 204, response.text
        assert worker.post(f"/internal/jobs/{job['id']}/calls/{call_id}/trace",
                           json={"phase": phase, "data": data}, headers=headers | {"Lease-Id": lease}).status_code == 204
        assert worker.post(f"/internal/jobs/{job['id']}/calls/{call_id}/trace",
                           json={"phase": phase, "data": {"tampered": True}},
                           headers=headers | {"Lease-Id": lease}).status_code == 409
    assert worker.get(f"/api/v1/jobs/{job['id']}", headers=headers).status_code == 200

    store = AuthStore(tmp_path / "db.sqlite3", CODE, False)
    store.create_user("owner", "admin-password-long-123", "", role="admin")
    admin = client(tmp_path)
    assert admin.post("/api/v1/auth/login", json={
        "username": "owner", "password": "admin-password-long-123",
    }).status_code == 200
    assert project in admin.get("/api/v1/projects").json()
    assert len(admin.get("/api/v1/admin/users").json()) == 2
    assert admin.get(f"/api/v1/jobs/{job['id']}/model-calls").json()[0]["call_id"] == call_id
    trace = admin.get(f"/api/v1/jobs/{job['id']}/model-calls/{call_id}").json()
    assert trace["request"]["body"]["input"] == "full secret prompt"
    assert trace["response"]["message"]["output"] == "full secret answer"
    conversation = user.post("/api/v1/conversations", json={
        "project_id": project["id"], "module": "concept", "title": "Private chat",
    }).json()
    assert user.post(f"/api/v1/conversations/{conversation['id']}/messages", json={"content": "private conversation text"}).status_code == 201
    assert user.delete(f"/api/v1/conversations/{conversation['id']}?project_id={project['id']}").status_code == 204
    assert user.get(f"/api/v1/conversations/{conversation['id']}/messages").status_code == 404
    admin_messages = admin.get(f"/api/v1/admin/conversations/{conversation['id']}/messages")
    assert admin_messages.status_code == 200
    assert admin_messages.json()[0]["content"] == "private conversation text"
