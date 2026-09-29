// Opt-in UI regression against a running preview. Every API is mocked: no model calls or user-data writes.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.ARCHFLOW_PLAYWRIGHT_MODULE ?? "playwright");

const base = process.env.ARCHFLOW_TEST_URL ?? "http://127.0.0.1:18081";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1536, height: 1000 },
  httpCredentials: { username: process.env.ARCHFLOW_TEST_USER ?? "archflow", password: process.env.ARCHFLOW_TEST_PASSWORD ?? "archflow-local-test-only" },
});
const project = { id: "workflow-fixture", name: "版本与需求回归（虚构）" };
const conversation = { id: "conversation-fixture", project_id: project.id, module: "concept", title: "方案需求验收" };
let tick = 0;
const timestamp = () => new Date(Date.UTC(2026, 8, 28, 1, 0, tick++)).toISOString();
const initialGoal = "制作学校改造项目汇报，参考上传资料";
const messages = [{ id: "m1", conversation_id: conversation.id, role: "user", content: initialGoal, created_at: timestamp() }];
const jobs = [];
const writes = [];
let unexpected = [];
let limits = { max_model_calls: 20000, max_total_tokens: 100000000 };

function makeJob(body) {
  const date = timestamp();
  return { ...body, id: `v${jobs.length + 1}`, status: jobs.length ? "running" : "waiting_outline", stage: "planning",
    completed_units: 0, storyboard_units: 0, model_calls: 0, total_tokens: 0, model: "mock", review_model: "mock",
    created_at: date, updated_at: date, batches: [], final_review: null, error: null,
    outline: jobs.length ? null : { summary: "第一版素材预览", sections: [{ title: "项目分析", start_unit: 1, end_unit: 10, objective: "V1 原有提纲" }] },
  };
}

await context.route(/\/api\/v1\//, async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  const reply = json => route.fulfill({ json });
  if (method === "GET") {
    if (path === "/api/v1/projects") return reply([project]);
    if (path === "/api/v1/conversations") return reply([conversation]);
    if (path.endsWith("/messages")) return reply(messages);
    if (path === "/api/v1/files") return reply([]);
    if (path === "/api/v1/capabilities") return reply({ generation: true });
    if (path === "/api/v1/settings/run-limits") return reply(limits);
    if (path === "/api/v1/jobs") return reply([...jobs].reverse());
    if (path.endsWith("/units")) return reply([]);
    if (path.endsWith("/export")) return reply({ status: "not_requested", requested: false, result: null, error: null });
    const match = /\/jobs\/(v\d+)$/.exec(path);
    if (match) return reply(jobs.find(job => job.id === match[1]));
  }
  if (method === "POST") {
    if (path === "/api/v1/requirements/resolve") {
      const body = request.postDataJSON();
      const additions = body.base_goal && body.goal.startsWith(body.base_goal) ? body.goal.slice(body.base_goal.length) : body.goal;
      const count = text => [...text.matchAll(/(?<!第)(\d+)页/gu)].at(-1)?.[1];
      const target = Number(count(additions) ?? body.fallback_units);
      const requested = count(body.goal) === undefined ? null : Number(count(body.goal));
      return reply({ target_units: target, requested_units: requested, count_override: requested !== null && requested !== target });
    }
    if (path === "/api/v1/settings/run-limits") { limits = request.postDataJSON(); return reply(limits); }
    writes.push(path);
    if (path.endsWith("/messages")) {
      const content = request.postDataJSON().content;
      const message = { id: `m${messages.length + 1}`, conversation_id: conversation.id, role: "user", content, created_at: timestamp() };
      messages.push(message, { id: `a${messages.length + 1}`, conversation_id: conversation.id, role: "assistant", content: "已收到新要求，请确认新版本。", created_at: timestamp() });
      return reply(message);
    }
    if (path.endsWith("/cancel")) {
      const job = jobs.find(job => path.includes(`/${job.id}/`));
      job.status = "cancelled"; job.updated_at = timestamp();
      return reply(job);
    }
    if (path === "/api/v1/jobs") { const job = makeJob(request.postDataJSON()); jobs.push(job); return reply(job); }
  }
  unexpected.push(`${method} ${path}`);
  return route.fulfill({ status: 500, json: { detail: "Unexpected mocked API request" } });
});

try {
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(id => localStorage.setItem("archflow.active-project", id), project.id);
await page.goto(base);
const thread = page.locator(".chat-thread");
const pending = page.getByRole("region", { name: "需求确认", exact: true });
await pending.waitFor();
await page.getByRole("button", { name: "运行设置", exact: true }).click();
const settingsDialog = page.getByRole("dialog", { name: "运行设置", exact: true });
assert.equal(await settingsDialog.getByRole("spinbutton", { name: "每个任务的累计 token 上限", exact: true }).inputValue(), "100000000");
await settingsDialog.getByRole("spinbutton", { name: "每个任务的累计 token 上限", exact: true }).fill("200000000");
await settingsDialog.getByRole("spinbutton", { name: "每个任务的模型调用上限", exact: true }).fill("30000");
await settingsDialog.getByRole("button", { name: "保存设置", exact: true }).click();
await settingsDialog.waitFor({ state: "hidden" });
assert.equal(jobs.length, 0, "Settings must never start a task");
assert.equal(await pending.getByText("运行上限与费用控制", { exact: true }).count(), 0);
await pending.getByRole("textbox", { name: "需求摘要", exact: true }).fill("第一版：面向甲方，简约风格，10页。");
await pending.getByRole("textbox", { name: "需求摘要", exact: true }).fill("第一版：面向甲方，简约风格，47页。");
await page.waitForFunction(() => document.querySelector('.pending-requirement input[type="number"]')?.value === "47");
await pending.getByRole("spinbutton", { name: "预计页数", exact: true }).fill("23");
assert.match(await pending.innerText(), /本次以此处确认的 23 页为准/);
await pending.getByRole("textbox", { name: "需求摘要", exact: true }).fill("第一版：面向甲方，简约风格，10页。");
const textarea = pending.getByRole("textbox", { name: "需求摘要", exact: true });
assert.equal(await textarea.evaluate(element => getComputedStyle(element).resize), "vertical");
const beforeWidth = await textarea.evaluate(element => element.getBoundingClientRect().width);
await textarea.evaluate(element => { element.style.height = "240px"; });
assert.equal(await textarea.evaluate(element => element.getBoundingClientRect().width), beforeWidth);
await page.waitForFunction(() => !document.querySelector(".pending-requirement > button:last-of-type")?.disabled);
await pending.getByRole("button", { name: "确认需求，整理提纲", exact: true }).click();
const v1Card = page.getByRole("region", { name: "已确认需求 V1", exact: true });
await v1Card.waitFor();
await page.locator(".output-panel").getByText("第一版素材预览", { exact: true }).waitFor();
await pending.waitFor({ state: "detached" });
assert.match(await v1Card.innerText(), /面向甲方/);
// A legacy conversation with no saved preview preference also keeps V1 when V2 starts.
await page.evaluate(() => localStorage.removeItem("archflow.preview:workflow-fixture:concept:conversation-fixture"));
await page.reload();
await v1Card.waitFor();
await page.locator(".output-panel").getByText("第一版素材预览", { exact: true }).waitFor();
await page.getByPlaceholder("描述需求、补充条件或修改指定页…").fill("10页太少了，做40页ppt");
await page.getByRole("button", { name: "发送消息", exact: true }).click();
await pending.waitFor();
await page.waitForFunction(() => document.querySelector('.pending-requirement input[type="number"]')?.value === "40");
assert.equal(await pending.getByRole("spinbutton", { name: "预计页数", exact: true }).inputValue(), "40");
assert.match(await textarea.inputValue(), /面向甲方/);
assert.equal(await v1Card.getByRole("button", { name: /批准.*提纲/ }).count(), 0);
assert.equal(await thread.getByLabel("成果版本", { exact: true }).count(), 0);
const order = await thread.locator(".user-message, .confirmed-requirement").evaluateAll(elements => elements.map(element => element.classList.contains("confirmed-requirement") ? element.dataset.jobId : element.querySelector(".message-bubble").innerText));
assert.deepEqual(order, [initialGoal, "v1", "10页太少了，做40页ppt"]);
await pending.getByRole("button", { name: "确认 40 页需求，生成新版本提纲", exact: true }).click();
const v2Card = page.getByRole("region", { name: "已确认需求 V2", exact: true });
await v2Card.waitFor();
assert.equal(jobs[1].target_units, 40);
assert.equal(jobs[1].max_total_tokens, 200000000);
assert.equal(jobs[1].max_model_calls, 30000);
assert.match(jobs[1].goal, /面向甲方/);
const selector = page.locator(".output-panel").getByLabel("成果版本", { exact: true });
assert.equal(await selector.inputValue(), "v1");
await page.locator(".output-panel").getByText("第一版素材预览", { exact: true }).waitFor();
const historyBefore = await thread.innerText();
const writesBefore = writes.length;
await selector.selectOption("v2");
await page.locator(".output-panel").getByText("提纲准备好后会显示在这里，确认操作在对话中。", { exact: true }).waitFor();
assert.equal(await v2Card.getByLabel("文档制作步骤").count(), 1);
assert.equal(await v2Card.getByRole("group", { name: "批准运行额度后继续" }).count(), 0);
assert.equal(await thread.innerText(), historyBefore);
await selector.selectOption("v1");
await page.locator(".output-panel").getByText("第一版素材预览", { exact: true }).waitFor();
assert.equal(await thread.innerText(), historyBefore);
assert.equal(writes.length, writesBefore);
await page.getByRole("button", { name: "收起成果预览", exact: true }).click();
assert.equal(await selector.isVisible(), false);
await page.getByRole("button", { name: "展开成果预览", exact: true }).click();
assert.equal(await selector.inputValue(), "v1");
await page.locator(".output-panel").getByText("第一版素材预览", { exact: true }).waitFor();
await page.reload();
await v2Card.waitFor();
await v1Card.waitFor();
assert.equal(await selector.inputValue(), "v1");
assert.match(await v1Card.innerText(), /面向甲方/);
assert.match(await v2Card.innerText(), /40 页/);
await page.getByPlaceholder("描述需求、补充条件或修改指定页…").fill("修改第3页的配色");
await page.getByRole("button", { name: "发送消息", exact: true }).click();
await pending.waitFor();
await page.waitForFunction(() => document.querySelector('.pending-requirement input[type="number"]')?.value === "40");
assert.equal(await pending.getByRole("spinbutton", { name: "预计页数", exact: true }).inputValue(), "40");
assert.equal(await pending.getByRole("button", { name: "确认 40 页需求，生成新版本提纲", exact: true }).isDisabled(), true);
// Recovery follows the structured failure category, never words in diagnostic text.
jobs[1].status = "failed"; jobs[1].stage = "storyboarding"; jobs[1].outline = { summary: "第二版提纲", sections: [] }; jobs[1].failure_kind = "context"; jobs[1].error = "Opaque provider diagnostic"; jobs[1].updated_at = timestamp();
await v2Card.getByText("当前上下文未能整理完成。可以从检查点继续；若重复失败，需要检查模型窗口或减少单次输入，而不是提高累计预算。", { exact: true }).waitFor();
assert.equal(await v2Card.getByText("Opaque provider diagnostic", { exact: true }).isVisible(), false);
assert.equal(await v2Card.getByRole("button", { name: "批准新上限并继续", exact: true }).count(), 0);
await v2Card.getByText("章节提纲已完成；逐页策划已暂停", { exact: true }).waitFor();
assert.equal(await v2Card.getByText("逐页策划尚未保存", { exact: true }).count(), 1);
// Scope conflicts in old records require explicit reconfirmation, never a silent rewrite.
jobs[1].target_units = 10; jobs[1].scope_mismatch = true; jobs[1].updated_at = timestamp();
await page.reload();
await pending.waitFor();
await page.waitForFunction(() => document.querySelector('.pending-requirement input[type="number"]')?.value === "40");
assert.equal(await v2Card.getByRole("button", { name: "按顶部运行设置继续", exact: true }).count(), 0);
assert.equal(jobs[1].target_units, 10);
await page.getByRole("button", { name: "运行设置", exact: true }).click();
assert.equal(await settingsDialog.getByRole("spinbutton", { name: "每个任务的累计 token 上限", exact: true }).inputValue(), "200000000");
await page.keyboard.press("Escape");
await settingsDialog.waitFor({ state: "hidden" });
await page.screenshot({ path: process.env.ARCHFLOW_TEST_SCREENSHOT ?? "/tmp/archflow-workflow-history.png", fullPage: true });
assert.deepEqual(unexpected, []);
assert.deepEqual(errors, []);
console.log(JSON.stringify({ persistentCards: true, chronologicalHistory: true, editedBriefPreserved: true, pageCount40: true, independentPreview: true, previousPreviewDuringGeneration: true, refreshedHistory: true, defaultExpandedResizableEditor: true, mockedWrites: writes, realModelCalls: 0, errors }));
} finally { await browser.close(); }
