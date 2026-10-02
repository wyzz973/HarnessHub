import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRelativeFilePath,
  validateFileOutputs,
} from "../../src/domain/files.js";
import { validateFixtures } from "../../src/benchmark/workspace.js";

void test("portable output and fixture paths reject Windows aliases and accept Chinese/spaces", () => {
  for (const path of [
    "报告 文件/结果.txt",
    "folder/COM10.txt",
    "auxiliary.txt",
    "a".repeat(255),
  ]) {
    assert.equal(isRelativeFilePath(path), true, path);
  }
  for (const path of [
    "C:relative",
    "C:/absolute",
    "\\\\server\\share\\file",
    "//server/share/file",
    "\\\\?\\C:\\file",
    "output.txt:stream",
    "CON",
    "NUL.json",
    "com¹.txt",
    "LPT²",
    "com³",
    "CONIN$",
    "CONOUT$.txt",
    "trailing. ",
    "a/../b",
    "a//b",
    "a".repeat(256),
  ]) {
    assert.equal(isRelativeFilePath(path), false, path);
    assert.throws(
      () => validateFileOutputs([{ path, name: "result.txt" }]),
      /portable relative/,
    );
    assert.throws(
      () =>
        validateFixtures({
          id: "invalid",
          version: "1",
          input: { text: "task", timeoutMs: 1000 },
          evaluator: { id: "text-exact", version: "1", expected: "ok" },
          fixtureFiles: [{ path, text: "invalid" }],
        }),
      /safe portable/,
    );
  }
  assert.throws(
    () =>
      validateFileOutputs([
        { path: "RESULT.txt", name: "one" },
        { path: "result.txt", name: "two" },
      ]),
    /unique/,
  );
});
