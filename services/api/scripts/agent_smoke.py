"""Explicit opt-in paid test against a local preview. Uses an isolated synthetic project."""
import argparse
import json
import os
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:18081")
    parser.add_argument("--run-paid-test", action="store_true", required=True)
    parser.add_argument("--resume", action="store_true", help="Resume only this fixture directory's isolated test job")
    args = parser.parse_args()
    password = os.environ.get("ARCHFLOW_TEST_PASSWORD")
    if not password:
        raise SystemExit("Set ARCHFLOW_TEST_PASSWORD; this is the website password, NOT the model key.")
    client = httpx.Client(base_url=args.url, auth=("archflow", password), timeout=120)
    def request(method, path, **kwargs):
        response = client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json()
    state_path = args.fixtures / "agent-state.json"
    state = json.loads(state_path.read_text()) if args.resume else None
    project = {"id": state["project_id"]} if state else request("POST", "/api/v1/projects", json={"name": "自动验收 · 虚构冷链资料"})
    for source in ([] if state else [args.fixtures / "brief.docx", args.fixtures / "concept/archflow.pptx"]):
        with source.open("rb") as stream:
            request("POST", f"/api/v1/files?project_id={project['id']}", files={"file": (source.name, stream)})
    deadline = time.monotonic()+1200
    while time.monotonic() < deadline:
        files = request("GET", f"/api/v1/files?project_id={project['id']}")
        if any(file["processing_status"] == "failed" for file in files):
            raise RuntimeError("Synthetic material parse failed: " + str([file["processing_error"] for file in files]))
        if all(file["processing_status"] == "ready" for file in files):
            break
        time.sleep(2)
    else:
        raise RuntimeError("Material parse timeout")
    conversation = {"id": state["conversation_id"]} if state else request("POST", "/api/v1/conversations", json={"project_id": project["id"], "module": "concept", "title": "新对话"})
    brief = "根据已上传的虚构任务书和参考演示文稿制作 5 页简洁中文概念汇报 PPT：项目条件、目标、设计思路和下一步。只用已确认的 100 亩、36000 平方米等本项目事实；不编造总平面、效果图、流线、造价或工程计算。参考仅用于结构与风格。色卡不是建筑图片，不得冒充效果图。缺失信息在审阅元数据标记，正文不要生成 QA 操作话术。"
    if not state:
        request("POST", f"/api/v1/conversations/{conversation['id']}/messages", json={"content": brief, "client_id": "smoke-initial"})
        job = request("POST", "/api/v1/jobs", headers={"Idempotency-Key": f"smoke-{project['id']}"}, json={"project_id": project["id"], "conversation_id": conversation["id"], "module": "concept", "goal": brief, "target_units": 5, "batch_size": 5, "max_model_calls": 70, "max_total_tokens": 250000, "max_revision_rounds": 2})
    else:
        job = request("GET", f"/api/v1/jobs/{state['job_id']}")
        if job["status"] == "failed":
            job = request("POST", f"/api/v1/jobs/{state['job_id']}/retry")
    state_path.write_text(json.dumps({"project_id": project["id"], "conversation_id": conversation["id"], "job_id": job["id"]}))
    previous = None
    while time.monotonic() < deadline:
        job = request("GET", f"/api/v1/jobs/{job['id']}")
        state = (job["status"], job["stage"], job["completed_units"], job["model_calls"])
        if state != previous:
            print(json.dumps({"job_id": job["id"], "status": job["status"], "stage": job["stage"], "units": job["completed_units"], "calls": job["model_calls"], "tokens": job["total_tokens"]}), flush=True)
            previous = state
        if job["status"] in {"waiting_outline", "waiting_storyboard"}:
            # Only auto-approve this explicitly requested synthetic test, never a user project.
            request("POST", f"/api/v1/jobs/{job['id']}/approve")
        elif job["status"] == "failed":
            raise RuntimeError(job["error"])
        elif job["status"] in {"completed", "needs_review"}:
            result = request("GET", f"/api/v1/jobs/{job['id']}/export")
            if result["status"] == "failed":
                raise RuntimeError(result["error"])
            if result["status"] == "ready":
                for extension in ["pptx", "pdf"]:
                    response = client.get(f"/api/v1/jobs/{job['id']}/export/{extension}")
                    response.raise_for_status()
                    (args.fixtures / f"agent-generated.{extension}").write_bytes(response.content)
                report = {"job_id": job["id"], "status": job["status"], "model_calls": job["model_calls"], "total_tokens": job["total_tokens"], "export": result["result"]}
                (args.fixtures / "agent-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
                print(json.dumps(report, ensure_ascii=False), flush=True)
                return
        time.sleep(2)
    request("POST", f"/api/v1/jobs/{job['id']}/cancel")
    raise RuntimeError("Test timeout; synthetic job cancelled, checkpoints preserved.")


if __name__ == "__main__":
    main()
