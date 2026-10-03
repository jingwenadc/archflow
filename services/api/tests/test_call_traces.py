from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException

from archflow_api.call_traces import CallTraces


@pytest.mark.parametrize("project_id", [str(uuid4()), "legacy-project", "项目资料"])
def test_traces_preserve_existing_project_directory(tmp_path: Path, project_id: str):
    traces = CallTraces(tmp_path)
    job_id, call_id = str(uuid4()), str(uuid4())
    assert traces.read(project_id, job_id, call_id) == {}
    traces.save(project_id, job_id, call_id, "request", {"body": {"input": "brief"}})
    assert (tmp_path / project_id / "workspace" / "model-calls" / job_id / call_id / "request.json.gz").is_file()
    assert traces.read(project_id, job_id, call_id)["request"]["body"]["input"] == "brief"


@pytest.mark.parametrize("project_id", ["", ".", "..", "../other", "/tmp/other", "one/two", "one\\two", "bad\x00id"])
def test_project_id_cannot_escape_its_directory(tmp_path: Path, project_id: str):
    with pytest.raises(HTTPException) as error:
        CallTraces(tmp_path).save(project_id, str(uuid4()), str(uuid4()), "request", {})
    assert error.value.status_code == 404
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("position", [0, 1])
def test_job_and_call_ids_still_require_uuid(tmp_path: Path, position: int):
    ids = [str(uuid4()), str(uuid4())]
    ids[position] = "../invalid"
    with pytest.raises(HTTPException) as error:
        CallTraces(tmp_path).save("existing-project", *ids, "request", {})
    assert error.value.status_code == 404


@pytest.mark.parametrize("depth", range(5))
def test_trace_paths_cannot_follow_symlinks(tmp_path: Path, depth: int):
    root, outside = tmp_path / "projects", tmp_path / "outside"
    outside.mkdir()
    project_id, job_id, call_id = str(uuid4()), str(uuid4()), str(uuid4())
    segments = [project_id, "workspace", "model-calls", job_id, call_id]
    link = root.joinpath(*segments[:depth + 1])
    link.parent.mkdir(parents=True)
    link.symlink_to(outside, target_is_directory=True)
    traces = CallTraces(root)
    with pytest.raises(HTTPException):
        traces.save(project_id, job_id, call_id, "request", {})
    with pytest.raises(HTTPException):
        traces.read(project_id, job_id, call_id)
    assert list(outside.iterdir()) == []
