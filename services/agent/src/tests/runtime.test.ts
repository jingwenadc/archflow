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
import { assertDraftDistinct, readSkill, runStep, type ModelConfig } from "../runtime.js";
import type { ArtifactUnit, ClaimedJob, GenerationJobDetail, JobCheckpoint, UsageRecord, WorkerProgress, AgentMemory } from "../contracts.js";
import { contextOverride, modelLimits } from "../model-limits.js";
import { WorkflowError } from "../errors.js";

class MemoryApi extends ApiClient {
  job: GenerationJobDetail = {
    id: "test-job", project_id: "test", conversation_id: null, module: "concept", goal: "明确的测试条件", target_units: 8, batch_size: 5, max_revision_rounds: 2,
    status: "running", stage: "planning", completed_units: 0, storyboard_units: 0, model_calls: 0, total_tokens: 0, max_model_calls: 100, max_total_tokens: 100_000,
    model: "test-model", review_model: "review-model", created_at: "now", updated_at: "now", outline: null, final_review: null,
    batches: [{ batch_index: 0, start_unit: 1, end_unit: 5, status: "pending", draft_count: 0 }, { batch_index: 1, start_unit: 6, end_unit: 8, status: "pending", draft_count: 0 }],
  };
  data = { storyboard: [] as ArtifactUnit[], draft: [] as ArtifactUnit[] };
  steps: string[] = [];
  memory: AgentMemory | null = null;
  constructor() { super("http://unused", "test"); }
  override async detail() { return structuredClone(this.job); }
  override async heartbeat() {}
  override async progress(_id: string, _lease: string, body: WorkerProgress) {
    this.steps.push(body.step); if (body.memory) this.memory = body.memory;
  }
  override async units(_id: string, kind: "draft" | "storyboard", offset: number, limit = 10) { return this.data[kind].slice(offset, offset + limit); }
  override async reviewUnits(_id: string, kind: "draft" | "storyboard", offset: number, limit = 5) { return this.data[kind].slice(offset, offset + limit); }
  override async call(_id: string, _lease: string, action: "reserve" | "usage", usage: UsageRecord) {
    if (action === "reserve") { if (this.job.model_calls >= this.job.max_model_calls) throw new WorkflowError("budget", "Budget exhausted"); this.job.model_calls++; }
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
    if (checkpoint.action === "failure") { this.job.error = checkpoint.error; this.job.failure_kind = checkpoint.failure_kind; this.job.status = "failed"; }
    return this.detail();
  }
  async claimSnapshot(): Promise<ClaimedJob> { return {
    job: await this.detail(), lease_id: "test-lease", memory: this.memory, current_units: [], skills: [{ slug: "test-skill", description: "For conceptual documents", sha256: "frozen", files: { "SKILL.md": "Read this skill before submitting. Produce review drafts based on the brief; never fabricate facts. Require outline/storyboard approvals." } }],
  }; }
}

/** A deterministic SSE fixture exercises the REAL Pi Responses adapter and tool loop. */
async function provider(pressure = false) {
  const requests: Record<string, unknown>[] = [];
  let lastPrompt: Record<string, any>;
  let inspectedLargePage = false;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); requests.push(payload);
    assert.equal(payload.store, false);
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer test-only");
    const input = payload.input as Array<{ type?: string; role?: string; content?: Array<{ text?: string }>; name?: string }>;
    const compacting = !payload.tools?.length;
    if (compacting) {
      // Real SDK compaction uses the SAME Responses endpoint, without gateway-specific APIs.
      const text = `Confirmed brief: ${lastPrompt.brief.slice(0, 40)}; evidence source: user-brief. Continue ${lastPrompt.task}. Re-read test-skill before submit.`;
      const item = { type: "message", id: `msg_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const response = { id: `resp_${requests.length}`, object: "response", model: payload.model, status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }, { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end(); return;
    }
    const taskText = input.filter(item => item.role === "user").flatMap(item => item.content ?? []).find(item => item.text?.startsWith('{"task"'))?.text;
    if (taskText) lastPrompt = JSON.parse(taskText);
    const prompt = lastPrompt;
    assert.deepEqual(payload.tools.map((item: { name: string }) => item.name).sort(), prompt.human_feedback ? ["read", "read_previous_units", "read_units", "submit"] : ["read", "read_units", "submit"]);
    const hasRead = input.some(item => item.type === "function_call" && item.name === "read");
    let name = "read"; let args: unknown = { path: "/skills/test-skill/SKILL.md" };
    if (hasRead) {
      name = "submit";
      if (prompt.task === "plan") args = { skill_slug: "test-skill", summary: "Outline ready", target_units: prompt.target_units, sections: [{ title: "Project", start_unit: 1, end_unit: prompt.target_units, objective: "Review draft" }] };
      else if (["review", "final_review"].includes(prompt.task)) {
        const failed = prompt.task === "review" && prompt.existing_units[0].body === "first draft";
        args = { passed: !failed, summary: failed ? "Revise content" : "Consistent", issues: failed ? ["Needs revision"] : [] };
      } else args = { units: Array.from({ length: prompt.unit_range[1] - prompt.unit_range[0] + 1 }, (_, index) => ({ unit_index: prompt.unit_range[0] + index, title: `Unit ${prompt.unit_range[0] + index}`, body: prompt.task === "storyboard" ? "content plan" : prompt.task === "draft" && !prompt.previous_review ? "first draft" : "revised draft", evidence: ["user-brief"], missing_facts: [] })) };
    }
    if (pressure && hasRead && !inspectedLargePage) {
      name = "read_units"; args = { kind: "storyboard", offset: 0, limit: 1 }; inspectedLargePage = true;
    }
    if (prompt.human_feedback && hasRead && !input.some(item => item.type === "function_call" && item.name === "read_previous_units")) {
      name = "read_previous_units"; args = { kind: "draft", offset: 0, limit: 1 };
    }
    const argumentsText = JSON.stringify(args);
    const item = { type: "function_call", id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name, arguments: argumentsText, status: "completed" };
    const inputTokens = pressure && requests.length === 1 ? 26000 : 100;
    const response = { id: `resp_${requests.length}`, object: "response", model: payload.model, status: "completed", output: [item], usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 } };
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
    const prompts = endpoint.requests.flatMap(request => request.input as Array<{ role?: string; content?: Array<{ text?: string }> }>)
      .filter(item => item.role === "user").flatMap(item => item.content ?? []).filter(item => item.text?.startsWith('{"task"')).map(item => JSON.parse(item.text!));
    const storyboardPrompt = prompts.find(item => item.task === "storyboard");
    const draftPrompt = prompts.find(item => item.task === "draft");
    const reviewPrompt = prompts.find(item => item.task === "review");
    assert.match(storyboardPrompt.instructions, /INTERNAL PRODUCTION PLANS/);
    assert.match(draftPrompt.instructions, /FINISHED AUDIENCE-FACING CONTENT/);
    assert.equal(draftPrompt.storyboard_units[0].body, "content plan");
    assert.equal(reviewPrompt.storyboard_units[0].body, "content plan");
    assert.equal(reviewPrompt.existing_units[0].body, "first draft");
  } finally { await endpoint.close(); await rm(workDir, { recursive: true, force: true }); }
});

test("draft checkpoints reject copied planning text without rejecting matching titles", () => {
  const storyboard = [{ unit_index: 1, title: "Shared title", body: "页面目的：介绍项目背景", evidence: ["user-brief"], missing_facts: [] }];
  const copied = [{ ...storyboard[0], body: "页面目的：介绍 项目背景" }];
  assert.throws(() => assertDraftDistinct(storyboard, copied), /第 1 单元/);
  assert.doesNotThrow(() => assertDraftDistinct(storyboard, [{ ...copied[0], body: "项目立足区域产业需求，构建高效协同的空间体系。" }]));
  assert.doesNotThrow(() => assertDraftDistinct(storyboard, copied, [2]), "Unrelated units stay frozen during a scoped revision");
});

test("human feedback is phase- and location-bound in the real Pi request and can read the original", async () => {
  const endpoint = await provider(); const workDir = await mkdtemp(join(tmpdir(), "archflow-review-test-"));
  const api = new MemoryApi();
  const makeComment = (id: string, kind: "outline" | "storyboard" | "draft", unit_index: number, body: string) => ({ id, job_id: "original", kind, body, anchor: { unit_index, quote: "Original quote" }, created_at: "now" });
  api.job.stage = "generating";
  api.job.outline = { skill_slug: "test-skill", summary: "Approved", target_units: 8, sections: [{ title: "Project", start_unit: 1, end_unit: 8, objective: "Approved scope" }] };
  api.job.review_request = { parent_id: "original", kind: "draft", comments: [makeComment("a", "draft", 2, "Make this sentence clearer"), makeComment("b", "draft", 7, "For another batch"), makeComment("c", "storyboard", 2, "Only for storyboard")] };
  api.data.draft = [{ unit_index: 1, title: "Original", body: "Original quote", evidence: ["user-brief"], missing_facts: [] }];
  try {
    await runStep(api, await api.claimSnapshot(), { baseUrl: endpoint.baseUrl, apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir }, new AbortController().signal);
    const prompts = endpoint.requests.flatMap(request => request.input as Array<{ role?: string; content?: Array<{ text?: string }> }>)
      .filter(item => item.role === "user").flatMap(item => item.content ?? []).filter(item => item.text?.startsWith('{"task"')).map(item => JSON.parse(item.text!));
    assert.ok(prompts.length);
    assert.deepEqual(prompts[0].human_feedback.comments.map((comment: { id: string }) => comment.id), ["a"]);
    assert.equal(prompts[0].brief, api.job.goal);
    assert.equal(prompts[0].target_units, 8);
    assert.equal(prompts[0].human_feedback.comments[0].anchor.quote, "Original quote");
    assert.ok(endpoint.requests.some(request => JSON.stringify(request.input).includes("read_previous_units")));
  } finally { await endpoint.close(); await rm(workDir, { recursive: true, force: true }); }
});

test("model IDs resolve official caps; gateway overrides never exceed those caps", () => {
  assert.equal(modelLimits("gpt-5.5").contextWindow, 1_050_000);
  assert.equal(modelLimits("gpt-5.5-2026-04-23").contextWindow, 1_050_000);
  assert.equal(modelLimits("gpt-5.2").contextWindow, 400_000);
  assert.equal(modelLimits("gpt-4.1").contextWindow, 1_047_576);
  assert.equal(modelLimits("gpt-4o").reasoning, false);
  assert.equal(modelLimits("gpt-5.5", 128000).contextWindow, 128000);
  assert.equal(modelLimits("gpt-5.5", 2_000_000).contextWindow, 1_050_000);
  assert.equal(contextOverride("auto"), undefined);
  assert.throws(() => contextOverride("NaN"));
  assert.throws(() => modelLimits("gpt-unknown"), /Unknown model/);
  assert.throws(() => modelLimits("gpt-5.5-gateway"), /Unknown model/);
  assert.equal(modelLimits("private-alias", 128000).contextWindow, 128000);
});

test("configuration and budget failures are typed, not inferred from their wording", async () => {
  const api = new MemoryApi();
  const workDir = await mkdtemp(join(tmpdir(), "archflow-pi-config-"));
  try {
    await processJob(api, await api.claimSnapshot(), { baseUrl: "http://unused", apiKey: "test-only", maxOutputTokens: 4096, workDir }, new AbortController().signal);
    assert.equal(api.job.status, "failed");
    assert.equal(api.job.failure_kind, "configuration");
    assert.equal(api.job.model_calls, 0);
    api.job.status = "running"; api.job.max_model_calls = 0;
    await processJob(api, await api.claimSnapshot(), { baseUrl: "http://unused", apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir }, new AbortController().signal);
    assert.equal(api.job.failure_kind, "budget");
    assert.equal(api.job.model_calls, 0);
  } finally { await rm(workDir, { recursive: true, force: true }); }
});

test("worker API reads structured failure categories regardless of message language", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ detail: { code: "budget", message: "本次调用未获授权" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = new ApiClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "test-only");
  try {
    await assert.rejects(api.call("any-job", "any-lease", "reserve", { call_id: "any-call", model: "any-model", total_tokens: 0 }),
      error => error instanceof WorkflowError && error.kind === "budget");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const module of ["concept", "bid"] as const) test(`${module}: context pressure compacts, accounts every request, saves memory and continues to approval`, async () => {
  const endpoint = await provider(true); const workDir = await mkdtemp(join(tmpdir(), "archflow-pi-compact-")); const api = new MemoryApi();
  api.job.module = module;
  api.job.max_total_tokens = module === "concept" ? 100_000_000 : 100_000;
  const config = { baseUrl: endpoint.baseUrl, apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir };
  // A large removable tool result simulates accumulated project observations.
  api.data.storyboard = [{ unit_index: 1, title: "Pressure fixture", body: "x".repeat(100000), evidence: ["user-brief"], missing_facts: [] }];
  try {
    await processJob(api, await api.claimSnapshot(), config, new AbortController().signal);
    assert.equal(api.job.status, "waiting_outline", api.job.error ?? "compaction did not continue");
    assert.ok(api.steps.includes("compacting"));
    assert.ok(api.steps.includes("continuing"));
    assert.match(api.memory!.summary, /user-brief/);
    assert.match(api.memory!.summary, /明确的测试条件/);
    assert.equal(api.memory!.scope, "plan:1-5:0");
    assert.equal(api.job.model_calls, endpoint.requests.length);
    assert.equal(api.job.total_tokens, 25900 + endpoint.requests.length * 120);
    assert.ok(endpoint.requests.length < 10, "compaction must not loop indefinitely");
    assert.ok(endpoint.requests.some(request => !(request.tools as unknown[] | undefined)?.length));
    api.job.status = "running";
    await runStep(api, await api.claimSnapshot(), config, new AbortController().signal);
    assert.match(JSON.stringify(endpoint.requests.at(-1)), /continuation_memory/);
  } finally { await endpoint.close(); await rm(workDir, { recursive: true, force: true }); }
});

test("compaction cannot bypass a model-call budget", async () => {
  const endpoint = await provider(true); const workDir = await mkdtemp(join(tmpdir(), "archflow-pi-compact-budget-")); const api = new MemoryApi();
  api.job.max_model_calls = 3;
  api.data.storyboard = [{ unit_index: 1, title: "Pressure fixture", body: "x".repeat(100000), evidence: ["user-brief"], missing_facts: [] }];
  try {
    await processJob(api, await api.claimSnapshot(), { baseUrl: endpoint.baseUrl, apiKey: "test-only", contextWindow: 32768, maxOutputTokens: 4096, workDir }, new AbortController().signal);
    assert.equal(api.job.status, "failed");
    assert.equal(api.job.failure_kind, "budget");
    assert.ok(api.steps.includes("compacting"));
    assert.equal(endpoint.requests.length, 3);
    assert.equal(api.job.model_calls, 3);
    assert.equal(api.job.total_tokens, 26260);
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

for (const [module, target, batchSize] of [["concept", 100, 5], ["bid", 137, 7]] as const) test(`${module}: ${target} units travel through real FastAPI, SQLite, Pi and the Responses adapter`, async () => {
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
    const projectResponse = await fetch(`${apiUrl}/api/v1/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Independent ${module} project` }) });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json() as { id: string };
    const response = await fetch(`${apiUrl}/api/v1/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: project.id, module, goal: "已确认的测试资料", target_units: target, batch_size: batchSize, max_model_calls: 500 }) });
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
    assert.equal(detail.completed_units, target);
    assert.equal(detail.model_calls, endpoint.requests.length);
    assert.equal(detail.total_tokens, endpoint.requests.length * 120);
    assert.equal((await api.units(job.id, "draft", target - 2, 2)).at(-1)?.unit_index, target);
    const download = await (await fetch(`${apiUrl}/api/v1/jobs/${job.id}/download`)).json() as { units: ArtifactUnit[] };
    assert.equal(download.units.length, target);
  } finally {
    child.kill("SIGTERM"); await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
    await endpoint.close(); await rm(workDir, { recursive: true, force: true });
  }
});
