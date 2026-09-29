// All APIs are mocked; this must never mutate the user's real project registry.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.ARCHFLOW_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const savedId of [null, "obsolete-project"]) {
    const context = await browser.newContext({ httpCredentials: {
      username: process.env.ARCHFLOW_TEST_USER ?? "archflow", password: process.env.ARCHFLOW_TEST_PASSWORD ?? "archflow-local-test-only",
    } });
    const projects = [];
    const unexpected = [], errors = [];
    await context.route(/\/api\/v1\//, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/v1/settings/run-limits" && request.method() === "GET") return route.fulfill({ json: { max_model_calls: 20000, max_total_tokens: 100000000 } });
      if (url.pathname === "/api/v1/projects") {
        if (request.method() === "POST") projects.push({ id: crypto.randomUUID(), name: request.postDataJSON().name });
        return route.fulfill({ json: request.method() === "POST" ? projects.at(-1) : projects });
      }
      if (request.method() === "GET" && ["/api/v1/files", "/api/v1/conversations"].includes(url.pathname)
        && projects.some(project => project.id === url.searchParams.get("project_id"))) return route.fulfill({ json: [] });
      unexpected.push(`${request.method()} ${url.pathname}?${url.searchParams}`);
      return route.fulfill({ status: 500, json: { detail: "Unexpected mock request" } });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    if (savedId) await page.addInitScript(id => localStorage.setItem("archflow.active-project", id), savedId);
    await page.goto(process.env.ARCHFLOW_TEST_URL ?? "http://127.0.0.1:18081");
    await page.getByText("先选择或新建项目", { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder("描述需求、补充条件或修改指定页…").isDisabled(), true);
    await page.getByRole("button", { name: "切换项目，当前项目：未选择", exact: true }).click();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称", { exact: true }).fill("独立学校项目");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("button", { name: "切换项目，当前项目：独立学校项目", exact: true }).waitFor();
    await page.getByText("你想完成什么？", { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder("描述需求、补充条件或修改指定页…").isDisabled(), false);
    assert.equal(projects.length, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem("archflow.active-project")), projects[0].id);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ emptyRegistry: true, staleSelection: true, explicitProjectCreation: true, realModelCalls: 0 }));
} finally { await browser.close(); }
