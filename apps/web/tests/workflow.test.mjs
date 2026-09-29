import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/workflow.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { requestedPageCount, requirementBrief, conversationTimeline, orderedJobs } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("latest requested length wins; page references and rejected lengths do not", () => {
  for (const [text, count] of [
    ["10页太少了，做40页ppt", 40], ["10页40页", 40], ["制作100页PPT", 100],
    ["做40页，修改第10页", 40], ["做40页，不要10页", 40], ["修改第 10 页", undefined],
    ["修改3-5页", undefined], ["第3至5页", undefined], ["强调设计风格", undefined], ["做600页", 500],
  ]) assert.equal(requestedPageCount(text), count, text);
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
