// All APIs are mocked. No provider calls or project-data writes occur.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.ARCHFLOW_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1536, height: 1050 }, httpCredentials: { username: "archflow", password: "archflow-local-test-only" } });
const base = process.env.ARCHFLOW_TEST_URL ?? "http://127.0.0.1:18081";
const project = { id: "review-project", name: "审阅交互（虚构）" };
const conversation = { id: "review-thread", project_id: project.id, module: "concept", title: "审阅交互" };
let tick = 1;
const timestamp = () => new Date(Date.UTC(2026, 8, 29, 1, 0, tick++)).toISOString();
const messages = [{ id: "m1", conversation_id: conversation.id, role: "user", content: "制作学校改造汇报", created_at: timestamp() }];
function makeJob(id, status, stage) {
  const date = timestamp();
  return { id, project_id: project.id, conversation_id: conversation.id, module: "concept", goal: messages[0].content, target_units: 8, batch_size: 5, max_revision_rounds: 2,
    status, stage, completed_units: status === "completed" ? 8 : 0, storyboard_units: status === "completed" ? 8 : 0, max_model_calls: 20000, max_total_tokens: 100000000,
    model_calls: 0, total_tokens: 0, model: "mock", review_model: "mock", created_at: date, updated_at: date, batches: [], error: null,
    outline: { target_units: 8, skill_slug: "mock", summary: "项目设计摘要", sections: [{ title: "校园功能与流线", start_unit: 1, end_unit: 4, objective: "保留这段场地分析，强调学生与后勤流线分离。" }, { title: "实施策略", start_unit: 5, end_unit: 8, objective: "分期实施，保留其他内容。" }] } };
}
const jobs = [makeJob("v1", "completed", "final_review"), makeJob("v2", "waiting_outline", "planning")];
const comments = { v1: [], v2: [] };
const writes = [], unexpected = [];
const units = Array.from({ length: 8 }, (_, i) => ({ unit_index: i + 1, title: `校园设计 ${i + 1}`, body: `第${i + 1}页的空间策略，保留原始成果。`, evidence: ["user-brief"], missing_facts: [] }));
await context.route(/\/api\/v1\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
  const reply = json => route.fulfill({ json });
  const id = /\/jobs\/(v\d+)/.exec(path)?.[1];
  if (method === "GET") {
    if (path === "/api/v1/projects") return reply([project]);
    if (path === "/api/v1/conversations") return reply([conversation]);
    if (path.endsWith("/messages")) return reply(messages);
    if (path === "/api/v1/files") return reply([]);
    if (path === "/api/v1/capabilities") return reply({ generation: true });
    if (path === "/api/v1/settings/run-limits") return reply({ max_model_calls: 20000, max_total_tokens: 100000000 });
    if (path === "/api/v1/jobs") return reply([...jobs].reverse());
    if (path.endsWith("/comments")) return reply(comments[id] ?? []);
    if (path.endsWith("/units")) return reply(id === "v1" ? units.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + 5) : []);
    if (path.endsWith("/export")) return reply(id === "v1" ? { status: "ready", requested: true, result: { page_count: 8, format: "pptx", missing_facts: 0 } } : { status: "not_requested", requested: false, result: null });
    if (path.includes("/preview/")) return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64") });
    if (/\/jobs\/v\d+$/.test(path)) return reply(jobs.find(job => job.id === id));
  }
  if (method === "POST") {
    const body = request.postDataJSON(); writes.push({ path, body });
    if (path.endsWith("/comments")) {
      const comment = { ...body, id: `c${comments[id].length + 1}`, job_id: id, created_at: timestamp(), submitted_job_id: null };
      comments[id].push(comment); return reply(comment);
    }
    if (path.endsWith("/feedback")) {
      const job = { ...makeJob(`v${jobs.length + 1}`, body.kind === "draft" ? "waiting_review" : "waiting_outline", body.kind === "draft" ? "final_review" : "planning"), parent_id: id, feedback_kind: body.kind };
      if (body.kind === "draft") job.storyboard_units = job.completed_units = 8;
      for (const comment of comments[id]) if (body.comment_ids.includes(comment.id)) comment.submitted_job_id = job.id;
      if (body.overall) comments[id].push({ id: `o${tick}`, job_id: id, kind: body.kind, body: body.overall, anchor: null, submitted_job_id: job.id, created_at: timestamp() });
      comments[job.id] = []; jobs.push(job); return reply(job);
    }
    if (path.endsWith("/approve")) { const job = jobs.find(job => job.id === id); job.status = "completed"; job.updated_at = timestamp(); return reply(job); }
  }
  if (method === "DELETE" && path.includes("/comments/")) { const index = comments[id].findIndex(item => path.endsWith(item.id)); comments[id].splice(index, 1); return route.fulfill({ status: 204 }); }
  unexpected.push(`${method} ${path}`); return route.fulfill({ status: 500, json: { detail: "Unexpected mocked request" } });
});
const page = await context.newPage(); const errors = [];
page.setDefaultTimeout(15000);
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(({ project, key }) => { localStorage.setItem("archflow.active-project", project); localStorage.setItem(key, "v2"); }, { project: project.id, key: `archflow.preview:${project.id}:concept:${conversation.id}` });
async function selectText(selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.evaluate(selector => {
    const element = document.querySelector(selector), range = document.createRange();
    range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, selector);
  await page.getByRole("button", { name: "批注所选文字", exact: true }).click();
}
try {
  await page.goto(base);
  console.log("Review preview loaded");
  await page.locator('[data-review-kind="outline"][data-review-index="1"] p').waitFor();
  await selectText('[data-review-kind="outline"][data-review-index="1"] p');
  await page.getByRole("textbox", { name: "批注意见", exact: true }).fill("用两种颜色区分学生与后勤流线。");
  assert.equal(await page.locator("#output-version").isDisabled(), true);
  await page.getByRole("button", { name: "加入本次反馈", exact: true }).click();
  const card = page.locator('[data-job-id="v2"]');
  await card.getByText("用两种颜色区分学生与后勤流线。", { exact: true }).waitFor();
  console.log("Inline draft saved without generation");
  assert.equal(writes.filter(item => item.path.endsWith("/feedback")).length, 0, "Saving inline feedback must not schedule work");
  await card.getByRole("textbox", { name: "V2 整体意见", exact: true }).fill("整体减少背景介绍，保留实施策略。");
  assert.equal(await page.locator(".output-panel").getByRole("button", { name: "提交反馈，生成修订稿", exact: true }).count(), 0, "The preview must not have a second submit entry");
  await card.getByRole("button", { name: "提交反馈，生成修订稿", exact: true }).click();
  await page.locator('[data-job-id="v3"]').waitFor();
  console.log("Combined feedback submitted");
  const request = writes.find(item => item.path.endsWith("/feedback"));
  assert.equal(request.path, "/api/v1/jobs/v2/feedback");
  assert.equal(request.body.overall, "整体减少背景介绍，保留实施策略。");
  assert.deepEqual(request.body.comment_ids, ["c1"]);
  assert.equal(comments.v2[0].anchor.unit_index, 1);
  assert.equal(comments.v2[0].anchor.quote, "保留这段场地分析，强调学生与后勤流线分离。");
  assert.equal(await page.locator("#output-version").inputValue(), "v2", "A revision must preserve the original preview");
  await page.reload();
  await page.locator('[data-job-id="v2"]').getByText("已提交反馈 · 2 条").waitFor();
  const before = writes.length;
  await page.locator("#output-version").selectOption("v1");
  await page.getByRole("button", { name: "文字审阅与批注", exact: true }).click();
  await selectText('[data-review-kind="draft"][data-review-index="2"] .generation-body');
  await page.getByRole("textbox", { name: "批注意见", exact: true }).fill("此页补充功能关系说明。");
  await page.getByRole("button", { name: "加入本次反馈", exact: true }).click();
  const firstCard = page.locator('[data-job-id="v1"]');
  await firstCard.getByText("此页补充功能关系说明。", { exact: true }).waitFor();
  assert.equal(writes.length, before + 1, "Switching versions/reading text only saves the explicitly added comment");
  await firstCard.getByRole("button", { name: "提交反馈，生成修订稿", exact: true }).click();
  await page.locator('[data-job-id="v4"]').waitFor();
  const draftFeedback = writes.filter(item => item.path.endsWith("/feedback")).at(-1);
  assert.equal(draftFeedback.body.kind, "draft");
  assert.equal(draftFeedback.body.overall, "");
  await page.getByRole("button", { name: "确认修订稿", exact: true }).click();
  assert.equal(jobs.at(-1).status, "completed");
  assert.equal(await page.locator("[data-job-id]").count(), 4);
  assert.equal(messages.length, 1, "Preview/review cannot rewrite the chat");
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  if (process.env.ARCHFLOW_TEST_SCREENSHOT) {
    await page.locator('[data-job-id="v4"]').scrollIntoViewIfNeeded();
    await page.locator("#output-version").selectOption("v2");
    await selectText('[data-review-kind="outline"][data-review-index="2"] p');
    await page.getByRole("textbox", { name: "批注意见", exact: true }).fill("这里可以填写针对这段的修改意见。");
    await page.screenshot({ path: process.env.ARCHFLOW_TEST_SCREENSHOT });
  }
  console.log("PASS: anchored drafts, one combined submission, persistence, version isolation, text review and reapproval");
} catch (error) {
  console.error("Browser diagnostics", errors, unexpected);
  await page.screenshot({ path: "/tmp/archflow-review-failure.png" });
  throw error;
} finally { await browser.close(); }
