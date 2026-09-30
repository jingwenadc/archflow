// Every API is mocked: exercise both workstreams without model calls or project writes.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.ARCHFLOW_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const base = process.env.ARCHFLOW_TEST_URL ?? "http://127.0.0.1:18081";
const phases = [
  { kind: "outline", status: "waiting_outline", stage: "planning", approve: "批准提纲" },
  { kind: "storyboard", status: "waiting_storyboard", stage: "storyboarding", approve: "批准策划" },
  { kind: "draft", status: "waiting_review", stage: "final_review", approve: "确认修订稿" },
];
try {
  for (const module of ["concept", "bid"]) for (const phase of phases) {
    const context = await browser.newContext({ viewport: { width: 1536, height: 1050 }, httpCredentials: { username: "archflow", password: "archflow-local-test-only" } });
    try {
      const project = { id: "phases-project", name: "各阶段审阅（虚构）" };
      const conversation = { id: "phases-thread", project_id: project.id, module, title: "阶段审阅" };
      let tick = 1;
      const timestamp = () => new Date(Date.UTC(2026, 8, 29, 1, 0, tick++)).toISOString();
      const messages = [{ id: "m1", conversation_id: conversation.id, role: "user", content: "准备学校改造项目文件", created_at: timestamp() }];
      const makeJob = (id, status) => ({ id, project_id: project.id, conversation_id: conversation.id, module, goal: messages[0].content,
        target_units: 6, batch_size: 5, max_revision_rounds: 2, status, stage: phase.stage, completed_units: phase.kind === "draft" ? 6 : 0,
        storyboard_units: phase.kind === "outline" ? 0 : 6, max_model_calls: 20000, max_total_tokens: 100000000, model_calls: 0, total_tokens: 0,
        model: "mock", review_model: "mock", created_at: timestamp(), updated_at: timestamp(), batches: [], error: null,
        outline: { target_units: 6, summary: "学校改造总体策略", sections: [{ title: "设计策略", start_unit: 1, end_unit: 6, objective: "保留场地关系和分期实施策略。" }] } });
      const jobs = [makeJob("v1", "cancelled"), makeJob("v2", "running")];
      const writes = [], errors = [], unexpected = [], comments = { v1: [], v2: [] };
      const units = Array.from({ length: 6 }, (_, index) => ({ unit_index: index + 1, title: `设计内容 ${index + 1}`, body: "保留场地关系和分期实施策略。", evidence: ["user-brief"], missing_facts: [] }));
      await context.route(/\/api\/v1\//, async route => {
        const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
        const id = /\/jobs\/(v\d+)/.exec(path)?.[1];
        const reply = json => route.fulfill({ json });
        if (method === "GET") {
          if (path === "/api/v1/projects") return reply([project]);
          if (path === "/api/v1/conversations") return reply([conversation]);
          if (path.endsWith("/messages")) return reply(messages);
          if (path === "/api/v1/files") return reply([]);
          if (path === "/api/v1/capabilities") return reply({ generation: true });
          if (path === "/api/v1/settings/run-limits") return reply({ max_model_calls: 20000, max_total_tokens: 100000000 });
          if (path === "/api/v1/jobs") return reply([...jobs].reverse());
          if (path.endsWith("/source-citations")) return reply([]);
          if (path.endsWith("/comments")) return reply(comments[id] ?? []);
          if (path.endsWith("/units")) return reply(phase.kind === "outline" ? [] : units.slice(0, 5));
          if (path.endsWith("/export")) return reply({ status: "not_requested", requested: false, result: null });
          if (/\/jobs\/v\d+$/.test(path)) return reply(jobs.find(job => job.id === id));
        }
        if (method === "POST" && path.endsWith("/comments")) {
          const body = request.postDataJSON(); writes.push({ path, body });
          const comment = { ...body, id: "c1", job_id: id, created_at: timestamp(), submitted_job_id: null };
          comments[id].push(comment); return reply(comment);
        }
        if (method === "POST" && path.endsWith("/feedback")) {
          const body = request.postDataJSON(); writes.push({ path, body });
          const revision = { ...makeJob(`v${jobs.length + 1}`, "running"), parent_id: id, feedback_kind: body.kind };
          for (const comment of comments[id]) comment.submitted_job_id = revision.id;
          comments[revision.id] = []; jobs.push(revision); return reply(revision);
        }
        unexpected.push(`${method} ${path}`); return route.fulfill({ status: 500, json: { detail: "Unexpected mocked request" } });
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(id => localStorage.setItem("archflow.active-project", id), project.id);
      await page.goto(`${base}${module === "bid" ? "/bids" : "/"}`);
      const historical = page.locator('[data-job-id="v1"]'), card = page.locator('[data-job-id="v2"]');
      const editor = card.getByRole("textbox", { name: "V2 整体意见", exact: true });
      await card.locator(".loading-icon").waitFor();
      assert.equal(await historical.locator(".review-draft").count(), 0, "Empty historical editors stay collapsed");
      assert.equal(await card.locator(".review-draft").count(), 0, "No automatic review while generation is running");
      jobs[1].status = phase.status; jobs[1].updated_at = timestamp();
      await editor.waitFor();
      assert.equal(await card.getByRole("combobox", { name: "V2 反馈阶段", exact: true }).inputValue(), phase.kind);
      const actions = card.getByRole("group", { name: "V2 审阅操作", exact: true });
      const approveLabel = phase.kind === "storyboard" ? `批准策划并生成全部 6 ${module === "concept" ? "页" : "章"}` : phase.approve;
      assert.deepEqual(await actions.getByRole("button").allTextContents(), [approveLabel, "修改意见", "取消任务"]);
      for (const width of [1536, 1024]) {
        await page.setViewportSize({ width, height: 1050 });
        const boxes = await actions.getByRole("button").evaluateAll(buttons => buttons.map(button => {
          const rect = button.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right };
        }));
        assert.ok(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1), "All three controls must share one row");
        assert.ok(boxes.every((box, i) => !i || box.x >= boxes[i - 1].right), "Controls must not overlap");
        assert.ok(await actions.evaluate(element => element.scrollWidth <= element.clientWidth), "Controls must fit the card");
      }
      await page.setViewportSize({ width: 1536, height: 1050 });
      await actions.getByRole("button", { name: "修改意见", exact: true }).click();
      assert.equal(await card.locator(".review-draft").count(), 0, "The automatically opened editor remains collapsible");
      await actions.getByRole("button", { name: "修改意见", exact: true }).click();
      await editor.fill("突出空间组织，保留其他章节。");
      assert.equal(writes.length, 0, "Editing feedback must not start a task or cancel anything");
      const selector = `[data-review-kind="${phase.kind}"][data-review-index="1"] ${phase.kind === "outline" ? "p" : ".generation-body"}`;
      await page.locator(selector).waitFor();
      await page.evaluate(selector => {
        const element = document.querySelector(selector), range = document.createRange();
        range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      }, selector);
      await page.getByRole("button", { name: "批注所选文字", exact: true }).click();
      await page.getByRole("textbox", { name: "批注意见", exact: true }).fill("这段强调分期实施。");
      await page.getByRole("button", { name: "加入本次反馈", exact: true }).click();
      await card.getByText("这段强调分期实施。", { exact: true }).waitFor();
      assert.equal(writes.length, 1, "Adding an annotation only saves the comment");
      assert.equal(writes[0].body.kind, phase.kind);
      await card.getByRole("button", { name: "提交反馈，生成修订稿", exact: true }).click();
      const revised = page.locator('[data-job-id="v3"]');
      await revised.locator(".loading-icon").waitFor();
      assert.equal(writes.length, 2);
      assert.equal(writes[1].path, "/api/v1/jobs/v2/feedback");
      assert.deepEqual({ kind: writes[1].body.kind, overall: writes[1].body.overall, comment_ids: writes[1].body.comment_ids },
        { kind: phase.kind, overall: "突出空间组织，保留其他章节。", comment_ids: ["c1"] });
      assert.equal(await page.locator("#output-version").inputValue(), "v2", "Regenerating retains the old artifact preview");
      jobs[2].status = phase.status; jobs[2].updated_at = timestamp();
      await revised.getByRole("textbox", { name: "V3 整体意见", exact: true }).waitFor();
      assert.equal(await revised.getByRole("combobox", { name: "V3 反馈阶段", exact: true }).inputValue(), phase.kind);
      assert.deepEqual(await revised.locator(".review-actions button").allTextContents(), [approveLabel, "修改意见", "取消任务"]);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      if (process.env.ARCHFLOW_PHASE_SCREENSHOT && module === "concept" && phase.kind === "outline") {
        await revised.scrollIntoViewIfNeeded();
        await page.screenshot({ path: process.env.ARCHFLOW_PHASE_SCREENSHOT });
      }
      console.log(`PASS: ${module}/${phase.kind} — shared action row, automatic feedback, combined submission and reapproval`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
