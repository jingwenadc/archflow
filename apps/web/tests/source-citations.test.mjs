import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/source-citations.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { displayCitations } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("frozen source IDs display as filename and page, including grouped page references", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const sources = [{ file_id: id, name: "设计任务书.pdf", page_count: 9 }];
  assert.equal(displayCitations(`证据：${id}:page1、page3、page6。`, sources), "证据：《设计任务书.pdf》第 1、3、6 页。");
  assert.equal(displayCitations(`依据${id}:p3–p4和${id}:p8。`, sources), "依据《设计任务书.pdf》第 3–4 页和《设计任务书.pdf》第 8 页。");
  assert.equal(displayCitations("unknown-id:p1；user-brief", sources), "unknown-id:p1；user-brief");
  assert.equal(displayCitations(`${id}:p1`, []), `${id}:p1`);
  assert.equal(displayCitations("source.v1:p2", [{ file_id: "source.v1", name: "平面图.png", page_count: 2 }]), "《平面图.png》第 2 页");
});
