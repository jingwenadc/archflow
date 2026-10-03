import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/integer-input.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { parseIntegerInput, normalizeIntegerInput } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("numeric drafts may be empty; only valid bounded integers become payload values", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "1e2", "501", "9007199254740993"])
    assert.equal(parseIntegerInput(value, 1, 500), null, value);
  for (const value of ["1", "40", "040", "500"])
    assert.equal(parseIntegerInput(value, 1, 500), Number(value), value);
  assert.equal(parseIntegerInput("1000", 1000, 1000000000), 1000);
  assert.equal(parseIntegerInput("1000000000", 1000, 1000000000), 1000000000);
  assert.equal(parseIntegerInput("999", 1000, 1000000000), null);
  assert.equal(parseIntegerInput("1000000001", 1000, 1000000000), null);
});

test("blur normalization removes leading zeros without replacing empty or invalid drafts", () => {
  for (const [draft, expected] of [["", ""], ["0", "0"], ["000", "0"], ["040", "40"], ["00017", "17"], ["30000", "30000"], ["1.5", "1.5"], ["-", "-"]])
    assert.equal(normalizeIntegerInput(draft), expected);
});
