import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../client.js";
import { processJob } from "../worker.js";
import { readSkill, runStep, type ModelConfig } from "../runtime.js";
import type { ArtifactUnit, ClaimedJob, GenerationJobDetail, JobCheckpoint, UsageRecord } from "../contracts.js";

class MemoryApi extends ApiClient {
  job: GenerationJobDetail = {
    id: "test-job", project_id: "test", conversation_id: null, module: "concept", goal: "明确的测试条件", target_units: 8, batch_size: 5, max_revision_rounds: 2,
    status: "running", stage: "planning", completed_units: 0, storyboard_units: 0, model_calls: 0, total_tokens: 0, max_model_calls: 100, max_total_tokens: 100_000,
    model: "test-model", review_model: "review-model", created_at: "now", updated_at: "now", outline: null, final_review: null,
    batches: [{ batch_index: 0, start_unit: 1, end_unit: 5, status: "pending", draft_count: 0 }, { batch_index: 1, start_unit: 6, end_unit: 8, status: "pending", draft_count: 0 }],
  };
  data = { storyboard: [] as ArtifactUnit[], draft: [] as ArtifactUnit[] };
  constructor() { super("http://unused", "test"); }
  override async detail() { return structuredClone(this.job); }
  override async heartbeat() {}
  override async units(_id: string, kind: "draft" | "storyboard", offset: number, limit = 10) { return this.data[kind].slice(offset, offset + limit); }
  override async call(_id: string, _lease: string, action: "reserve" | "usage", usage: UsageRecord) {
    if (action === "reserve") { if (this.job.model_calls >= this.job.max_model_calls) throw new Error("Budget exhausted"); this.job.model_calls++; }
    else this.job.total_tokens += usage.total_tokens;
  }
  override async checkpoint(_id: string, _lease: string, checkpoint: JobCheckpoint) {
    if (checkpoint.action === "plan") { this.job.outline = checkpoint.plan; this.job.status = "waiting_outline"; }
    if (checkpoint.action === "storyboard") { this.data.storyboard.push(...checkpoint.batch!.units); this.job.storyboard_units = this.data.storyboard.length; if (this.job.storyboard_units === 8) this.job.status = "waiting_storyboard"; }
    const batch = this.job.batches.find(item => item.status !== "completed");
    if (checkpoint.action === "draft") {
      for (const unit of checkpoint.batch!.units) this.data.draft[unit.unit_index - 1] = unit;
      batch!.draft_count++; batch!.status = "draft"; batch!.review = null;
    }
    if (checkpoint.action === "review") {
      batch!.review = checkpoint.review;
      if (checkpoint.review!.passed) { batch!.status = "completed"; this.job.completed_units += batch!.end_unit - batch!.start_unit + 1; }
      if (this.job.completed_units === 8) this.job.stage = "final_review";
    }
    if (checkpoint.action === "final_review") { this.job.final_review = checkpoint.review; this.job.status = checkpoint.review!.passed ? "completed" : "needs_review"; }
    if (checkpoint.action === "failure") { this.job.error = checkpoint.error; this.job.status = "failed"; }
    return this.detail();
  }
  async claimSnapshot(): Promise<ClaimedJob> { return {
    job: await this.detail(), lease_id: "test-lease", current_units: [], skills: [{ slug: "test-skill", description: "For conceptual documents", sha256: "frozen", files: { "SKILL.md": "Read this skill before submitting. Produce review drafts based on the brief; never fabricate facts. Require outline/storyboard approvals." } }],
  }; }
}

/** A deterministic SSE fixture exercises the REAL Pi Responses adapter and tool loop. */
async function provider() {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); requests.push(payload);
    assert.equal(payload.store, false);
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer test-only");
    assert.deepEqual(payload.tools.map((item: { name: string }) => item.name).sort(), ["read", "read_units", "submit"]);
    const input = payload.input as Array<{ type?: string; role?: string; content?: Array<{ text?: string }>; name?: string }>;
    const prompt = JSON.parse(input.find(item => item.role === "user")!.content![0].text!);
    const hasRead = input.some(item => item.type === "function_call" && item.name === "read");
    let name = "read"; let args: unknown = { path: "/skills/test-skill/SKILL.md" };
    if (hasRead) {
      name = "submit";
      if (prompt.task === "plan") args = { skill_slug: "test-skill", summary: "Outline ready", sections: [{ title: "Project", start_unit: 1, end_unit: prompt.target_units, objective: "Review draft" }] };
      else if (["review", "final_review"].includes(prompt.task)) {
        const failed = prompt.task === "review" && prompt.existing_units[0].body === "first draft";
        args = { passed: !failed, summary: failed ? "Revise content" : "Consistent", issues: failed ? ["Needs revision"] : [] };
      } else args = { units: Array.from({ length: prompt.unit_range[1] - prompt.unit_range[0] + 1 }, (_, index) => ({ unit_index: prompt.unit_range[0] + index, title: `Unit ${prompt.unit_range[0] + index}`, body: prompt.task === "draft" && !prompt.previous_review ? "first draft" : "revised draft", evidence: ["user-brief"], missing_facts: [] })) };
    }
    const argumentsText = JSON.stringify(args);
    const item = { type: "function_call", id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name, arguments: argumentsText, status: "completed" };
    const response = { id: `resp_${requests.length}`, object: "response", model: payload.model, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: argumentsText },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: argumentsText },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test("Pi selects/reads skills, pauses for two approvals, iterates revisions and accounts calls", async () => {
  const endpoint = await provider(); const workDir = await mkdtemp(join(tmpdir(), "archflow-pi-test-"));
  const config: ModelConfig = { baseUrl: endpoint.baseUrl, apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir };
  const api = new MemoryApi();
  try {
    await processJob(api, await api.claimSnapshot(), config, new AbortController().signal);
    assert.equal(api.job.status, "waiting_outline", api.job.error ?? "plan failed");
    api.job.status = "running"; api.job.stage = "storyboarding";
    await processJob(api, await api.claimSnapshot(), config, new AbortController().signal);
    assert.equal(api.job.status, "waiting_storyboard", api.job.error ?? "storyboard failed");
    api.job.status = "running"; api.job.stage = "generating";
    await processJob(api, await api.claimSnapshot(), config, new AbortController().signal);
    assert.equal(api.job.status, "completed", api.job.error ?? "generation failed");
    assert.equal(api.job.completed_units, 8);
    assert.equal(api.job.batches[0].draft_count, 2);
    assert.equal(api.job.model_calls, endpoint.requests.length);
    assert.ok(endpoint.requests.every(request => !request.prompt_cache_key), "Gateway-unsafe affinity must remain disabled.");
    assert.equal(api.job.total_tokens, endpoint.requests.length * 120);
    assert.ok(endpoint.requests.some(request => request.model === "review-model"));
    assert.equal(api.data.draft.length, 8);
  } finally { await endpoint.close(); await rm(workDir, { recursive: true, force: true }); }
});

test("exhausted budget blocks the request before reaching the endpoint", async () => {
  const endpoint = await provider(); const workDir = await mkdtemp(join(tmpdir(), "archflow-pi-budget-")); const api = new MemoryApi();
  api.job.max_model_calls = 0;
  try {
    await assert.rejects(runStep(api, await api.claimSnapshot(), { baseUrl: endpoint.baseUrl, apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir }, new AbortController().signal));
    assert.equal(endpoint.requests.length, 0);
    assert.throws(() => readSkill({ skills: [] } as unknown as ClaimedJob, "/etc/passwd"));
    assert.throws(() => readSkill({ skills: [] } as unknown as ClaimedJob, "/skills/test-skill/../../secret"));
  } finally { await endpoint.close(); await rm(workDir, { recursive: true, force: true }); }
});

test("100 units travel through real FastAPI, SQLite, Pi and the Responses adapter", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const python = process.env.ARCHFLOW_TEST_PYTHON ?? join(root, "services/api/.venv/bin/python");
  await access(python); // This test requires pip install -e 'services/api[dev]'. No silent skip.
  const workDir = await mkdtemp(join(tmpdir(), "archflow-pi-e2e-")); const endpoint = await provider();
  await mkdir(join(workDir, "skills/test-skill"), { recursive: true });
  await writeFile(join(workDir, "skills/test-skill/SKILL.md"), "---\nname: test-skill\ndescription: Conceptual document drafting\n---\nRead this skill before submitting. Produce review drafts from the brief. Require outline/storyboard approval.");
  // Reserve an ephemeral local port before spawning the actual API.
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as { port: number }).port; await new Promise<void>(resolve => portServer.close(() => resolve()));
  const child = spawn(python, ["-m", "uvicorn", "archflow_api.main:app", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: "ignore", env: {
    ...process.env, ARCHFLOW_AGENT_ENABLED: "true", ARCHFLOW_WORKER_TOKEN: "test-only", ARCHFLOW_REPOSITORY_ROOT: workDir,
    ARCHFLOW_DATABASE_PATH: join(workDir, "db.sqlite3"), ARCHFLOW_PROJECT_DIR: join(workDir, "projects"),
    ARCHFLOW_UPLOAD_DIR: join(workDir, "uploads"), ARCHFLOW_CASE_UPLOAD_DIR: join(workDir, "cases"),
    ARCHFLOW_LLM_MODEL: "test-model", ARCHFLOW_REVIEW_MODEL: "review-model",
  } });
  const apiUrl = `http://127.0.0.1:${port}`; const api = new ApiClient(apiUrl, "test-only");
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${apiUrl}/health`)).ok; } catch {}
      if (ready) break; await delay(50);
    }
    assert.ok(ready, "API did not start");
    const response = await fetch(`${apiUrl}/api/v1/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: "cold-chain-industrial-park", module: "concept", goal: "已确认的测试资料", target_units: 100, max_model_calls: 500 }) });
    assert.equal(response.status, 202);
    const job = await response.json() as GenerationJobDetail;
    const config = { baseUrl: endpoint.baseUrl, apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir: join(workDir, "agent") };
    for (const expected of ["waiting_outline", "waiting_storyboard", "completed"]) {
      const claim = await api.claim(); assert.ok(claim);
      await processJob(api, claim, config, new AbortController().signal);
      const detail = await api.detail(job.id);
      assert.equal(detail.status, expected, detail.error ?? "wrong transition");
      if (expected !== "completed") {
        assert.equal(await api.claim(), null, "approval must block worker claims");
        assert.equal((await fetch(`${apiUrl}/api/v1/jobs/${job.id}/approve`, { method: "POST" })).status, 200);
      }
    }
    const detail = await api.detail(job.id);
    assert.equal(detail.completed_units, 100);
    assert.equal(detail.model_calls, endpoint.requests.length);
    assert.equal(detail.total_tokens, endpoint.requests.length * 120);
    assert.equal((await api.units(job.id, "draft", 95, 5)).at(-1)?.unit_index, 100);
    const download = await (await fetch(`${apiUrl}/api/v1/jobs/${job.id}/download`)).json() as { units: ArtifactUnit[] };
    assert.equal(download.units.length, 100);
  } finally {
    child.kill("SIGTERM"); await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
    await endpoint.close(); await rm(workDir, { recursive: true, force: true });
  }
});
