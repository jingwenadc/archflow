// Opt-in UI regression against a running preview; all API responses are mocked.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.ARCHFLOW_PLAYWRIGHT_MODULE ?? "playwright");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 },
  httpCredentials: { username: process.env.ARCHFLOW_TEST_USER ?? "archflow", password: process.env.ARCHFLOW_TEST_PASSWORD ?? "archflow-local-test-only" } });
const project = { id: "live-output-project", name: "实时预览（虚构）" };
const conversation = { id: "live-output-thread", project_id: project.id, module: "concept", title: "方案设计" };
const messages = [{ id: "m1", conversation_id: conversation.id, role: "user", content: "制作40页概念方案", created_at: "2026-09-29T01:00:00Z" }];
const outline = { target_units: 40, skill_slug: "mock", summary: "概念方案提纲", sections: [{ title: "场地与功能", start_unit: 1, end_unit: 40, objective: "梳理设计策略" }] };
const common = { project_id: project.id, conversation_id: conversation.id, module: "concept", goal: messages[0].content, target_units: 40, batch_size: 5, max_revision_rounds: 2,
  completed_units: 0, model_calls: 0, total_tokens: 0, max_model_calls: 20000, max_total_tokens: 100000000, model: "mock", review_model: "mock", batches: [], error: null, outline };
const jobs = [
  { ...common, id: "v1", status: "completed", stage: "final_review", storyboard_units: 40, completed_units: 40, created_at: "2026-09-29T01:01:00Z", updated_at: "2026-09-29T01:02:00Z" },
  { ...common, id: "v2", status: "running", stage: "storyboarding", storyboard_units: 5, created_at: "2026-09-29T01:03:00Z", updated_at: "2026-09-29T01:04:00Z" },
];
const units = Array.from({ length: 40 }, (_, index) => ({ unit_index: index + 1, title: `策划页 ${index + 1}`, body: `第 ${index + 1} 页的内容目标`,
  slide_copy: [`拟展示的第 ${index + 1} 页文字`], visual_plan: `图表 ${index + 1}：说明场地关系`, evidence: ["user-brief"], missing_facts: index === 0 ? ["关键尺寸尚待核验"] : [] }));
const drafts = Array.from({ length: 5 }, (_, index) => ({ unit_index: index + 1, title: `策划页 ${index + 1}`, body: `供读者阅读的第 ${index + 1} 页正文`, evidence: ["user-brief"], missing_facts: [] }));
const unexpected = [];
let exportState = { status: "not_requested", requested: false, result: null, error: null };
await context.route(/\/api\/v1\//, async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname;
  const reply = json => route.fulfill({ json });
  if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return route.fulfill({ status: 500 }); }
  if (path === "/api/v1/projects") return reply([project]);
  if (path === "/api/v1/conversations") return reply([conversation]);
  if (path.endsWith("/messages")) return reply(messages);
  if (path === "/api/v1/files") return reply([]);
  if (path === "/api/v1/capabilities") return reply({ generation: true });
  if (path === "/api/v1/settings/run-limits") return reply({ max_model_calls: 20000, max_total_tokens: 100000000 });
  if (path === "/api/v1/jobs") return reply([...jobs].reverse());
  if (path.endsWith("/source-citations") || path.endsWith("/comments")) return reply([]);
  const id = /\/jobs\/(v\d+)/.exec(path)?.[1];
  if (path.endsWith("/units")) {
    const source = id === "v2" && url.searchParams.get("kind") === "storyboard" ? units.slice(0, jobs[1].storyboard_units) : id === "v2" && url.searchParams.get("kind") === "draft" ? drafts.slice(0, jobs[1].batches.some(batch => batch.draft_count > 0) ? 5 : jobs[1].completed_units) : [];
    return reply(source.slice(Number(url.searchParams.get("offset")), Number(url.searchParams.get("offset")) + 5));
  }
  if (path.endsWith("/export")) return reply(exportState);
  if (/\/jobs\/v\d+$/.test(path)) return reply(jobs.find(job => job.id === id));
  unexpected.push(`GET ${path}`); return route.fulfill({ status: 500 });
});

const page = await context.newPage(), errors = [];
page.setDefaultTimeout(15000);
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(({ projectId, key }) => { localStorage.setItem("archflow.active-project", projectId); localStorage.setItem(key, "v1"); },
  { projectId: project.id, key: `archflow.preview:${project.id}:concept:${conversation.id}` });
try {
  await page.goto(process.env.ARCHFLOW_TEST_URL ?? "http://127.0.0.1:3000");
  assert.equal(await page.locator('link[rel="icon"]').getAttribute("href"), "/favicon.svg?v=2");
  const output = page.locator(".output-panel");
  assert.equal(await output.getByLabel("成果版本", { exact: true }).inputValue(), "v1");
  await output.getByRole("button", { name: "查看实时草稿" }).click();
  await output.getByText("策划页 5", { exact: true }).waitFor();
  assert.match(await output.innerText(), /已保存 5 \/ 40 页/);
  assert.equal(await output.getByText("关键尺寸尚待核验").isVisible(), false, "Optional verification stays collapsed");
  jobs[1].storyboard_units = 10; jobs[1].updated_at = "2026-09-29T01:05:00Z";
  await output.getByText("策划页 10", { exact: true }).waitFor();
  assert.equal(await output.locator(".generation-unit").first().getByRole("heading").innerText(), "策划页 6");
  await output.getByRole("button", { name: "上一组" }).click();
  await output.getByText("策划页 1", { exact: true }).waitFor();
  jobs[1].storyboard_units = 15; jobs[1].updated_at = "2026-09-29T01:06:00Z";
  await output.getByText(/已保存 15 \/ 40 页/).waitFor();
  assert.equal(await output.locator(".generation-unit").first().getByRole("heading").innerText(), "策划页 1", "Manual reading must pause following");
  await output.getByRole("button", { name: "跟随最新" }).click();
  await output.getByText("策划页 15", { exact: true }).waitFor();
  assert.equal(await output.locator(".generation-unit").first().getByRole("heading").innerText(), "策划页 11");
  const phases = output.getByRole("navigation", { name: "成果制作步骤" });
  assert.equal(await phases.getByRole("button", { name: "4 生成与审校" }).isDisabled(), true);
  assert.equal(await phases.getByRole("button", { name: "5 排版与下载" }).isDisabled(), true);
  await output.getByText("拟展示的第 11 页文字").waitFor();
  await output.getByText("图表 11：说明场地关系").waitFor();
  jobs[1].stage = "generating"; jobs[1].storyboard_units = 40; jobs[1].batches = [{ batch_index: 0, start_unit: 1, end_unit: 5, status: "draft", draft_count: 1 }]; jobs[1].updated_at = "2026-09-29T01:07:00Z";
  await phases.getByRole("button", { name: "4 生成与审校" }).waitFor();
  await output.getByText("供读者阅读的第 1 页正文").waitFor();
  await output.getByText(/已保存 5 \/ 40 页/).waitFor();
  await phases.getByRole("button", { name: "3 逐页策划" }).click();
  await output.getByText("第 1 页的内容目标").waitFor();
  await phases.getByRole("button", { name: "4 生成与审校" }).click();
  await output.getByText("供读者阅读的第 1 页正文").waitFor();
  assert.equal(await phases.getByRole("button", { name: "5 排版与下载" }).isDisabled(), true);
  jobs[1].status = "needs_review";
  jobs[1].completed_units = 5;
  jobs[1].batches[0].review = { passed: false, summary: "详细审校记录：" + "证据链需要重新核对。".repeat(100), issues: ["第 3 页来源不匹配。"] };
  jobs[1].updated_at = "2026-09-29T01:08:00Z";
  const notice = page.getByRole("status", { name: "自动审校结果" });
  await notice.getByText("自动审校尚未通过，当前版本已暂停").waitFor();
  assert.equal(await notice.getByText(/详细审校记录/).isVisible(), false, "Detailed AI diagnostics stay collapsed by default");
  await notice.getByText(/查看审校详情/).click();
  await notice.getByText(/详细审校记录/).waitFor();
  jobs[1].status = "completed"; jobs[1].completed_units = 40; jobs[1].updated_at = "2026-09-29T01:09:00Z";
  exportState = { status: "failed", requested: true, result: null, error: "排版服务暂时失败。" };
  await page.reload();
  await phases.getByRole("button", { name: "5 排版与下载" }).click();
  await output.getByRole("button", { name: "重试排版" }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  if (process.env.ARCHFLOW_TEST_SCREENSHOT) await page.screenshot({ path: process.env.ARCHFLOW_TEST_SCREENSHOT });
  console.log("PASS: live checkpoints, preserved old version, manual reading, stage order and distinct planning/draft views");
} catch (error) {
  console.error("Browser diagnostics", errors, unexpected);
  await page.screenshot({ path: "/tmp/archflow-live-output-failure.png" });
  throw error;
} finally { await browser.close(); }
