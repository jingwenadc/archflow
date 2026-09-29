import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/workflow.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { requirementBrief, conversationTimeline, orderedJobs, workflowState, workflowSteps, failureHelp } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("progress reflects the actual stage; context failures never suggest buying more budget", () => {
  const job = { module: "concept", stage: "planning", status: "running", completed_units: 0, storyboard_units: 0, target_units: 17, total_tokens: 3700, max_total_tokens: 10000, model_calls: 3, max_model_calls: 50, failure_kind: "context", error: "arbitrary diagnostic text" };
  assert.equal(workflowState(job).index, 0);
  assert.equal(workflowState({ ...job, progress: "正在整理资料记忆，随后继续" }).label, "正在整理资料记忆，随后继续");
  assert.equal(workflowState({ ...job, status: "waiting_outline" }).index, 1);
  assert.equal(workflowState({ ...job, stage: "storyboarding", status: "waiting_storyboard" }).index, 2);
  assert.equal(failureHelp(job).kind, "context");
  assert.equal(failureHelp({ ...job, total_tokens: 10001 }).kind, "budget");
  for (const kind of ["budget", "configuration", "provider", "context"]) {
    for (const error of ["", "quota context compaction", "任意错误文本"]) assert.equal(failureHelp({ ...job, failure_kind: kind, error }).kind, kind);
  }
  assert.equal(failureHelp({ ...job, failure_kind: null, error: "context authentication error" }).kind, "other");
  assert.equal(failureHelp({ ...job, failure_kind: "workflow", error: "budget warning" }).kind, "other");
  for (const module of ["concept", "bid"]) {
    assert.equal(workflowSteps(module)[2], module === "concept" ? "逐页策划" : "逐章策划");
    for (const [stage, status, index] of [["planning", "queued", 0], ["planning", "waiting_outline", 1], ["storyboarding", "running", 2], ["generating", "running", 3], ["final_review", "completed", 4]])
      assert.equal(workflowState({ ...job, module, stage, status }).index, index);
  }
});

test("paused progress preserves completed outline and distinguishes unsaved storyboard", () => {
  for (const module of ["concept", "bid"]) {
    const job = { module, stage: "storyboarding", status: "failed", target_units: 57, storyboard_units: 0 };
    assert.match(workflowState(job).label, /章节提纲已完成/);
    assert.equal(workflowState(job).saved, `${module === "concept" ? "逐页" : "逐章"}策划尚未保存`);
    assert.match(workflowState({ ...job, storyboard_units: 15 }).saved, /已保存 15 \/ 57/);
    assert.match(workflowState({ ...job, scope_mismatch: true }).label, /重新确认需求/);
    assert.equal(workflowState({ ...job, stage: "generating", status: "needs_review" }).index, 3, "Unresolved reviews must not appear completed");
    assert.equal(workflowState({ ...job, stage: "planning", status: "cancelled", outline: {} }).index, 1, "Saved outlines survive cancellation");
  }
});

test("work indicators follow running jobs, never queue, approval, failure or old scope conflicts", () => {
  for (const module of ["concept", "bid"]) {
    const job = { module, stage: "planning", progress: "正在应用设计技能", storyboard_units: 0, completed_units: 0, target_units: 17 };
    for (const status of ["queued", "running", "waiting_outline", "waiting_storyboard", "needs_review", "completed", "failed", "cancelled"])
      assert.equal(workflowState({ ...job, status }).working, status === "running", status);
    assert.equal(workflowState({ ...job, status: "running", scope_mismatch: true }).working, false);
    assert.equal(workflowState({ ...job, status: "running" }).label, job.progress);
    assert.doesNotMatch(workflowState({ ...job, status: "waiting_outline" }).label, /正在应用/);
  }
});

test("long requirements never silently discard the confirmed brief", () => {
  const confirmed = { goal: "保留此已确认约束", created_at: "2026-01-01T00:00:00Z" };
  const brief = requirementBrief([{ role: "user", content: "新增资料".repeat(6000), created_at: "2026-01-02T00:00:00Z" }], confirmed);
  assert.ok(brief.length > 20000);
  assert.ok(brief.startsWith(confirmed.goal));
});

test("confirmed requirements remain chronological, independent of preview selection", () => {
  const messages = [
    { id: "m1", role: "user", content: "制作10页", created_at: "2026-09-28T01:00:00Z" },
    { id: "m2", role: "user", content: "10页太少了，做40页ppt", created_at: "2026-09-28T03:00:00Z" },
  ];
  const v1 = { id: "v1", goal: "制作10页", target_units: 10, created_at: "2026-09-28T02:00:00Z" };
  const v2 = { id: "v2", goal: "制作40页", target_units: 40, created_at: "2026-09-28T04:00:00Z" };
  const jobs = [v2, v1];
  const snapshot = structuredClone({ messages, jobs });
  const timeline = conversationTimeline(messages, jobs);
  assert.deepEqual(timeline.map(entry => entry.type === "message" ? entry.message.id : `${entry.job.id}:V${entry.version}`), ["m1", "v1:V1", "m2", "v2:V2"]);
  assert.deepEqual(orderedJobs(jobs).map(job => job.target_units), [10, 40]);
  assert.deepEqual({ messages, jobs }, snapshot);
  assert.match(requirementBrief(messages), /以后续要求为准/);
  const edited = { ...v1, goal: "已确认的人工编辑：面向甲方，采用简约风格" };
  assert.match(requirementBrief(messages, edited), /已确认的人工编辑/);
  assert.match(requirementBrief(messages, edited), /做40页/);
  assert.doesNotMatch(requirementBrief(messages, edited), /制作10页/);
});
