import assert from "node:assert/strict";
import test from "node:test";
import type { PublicTool } from "../../src/contracts/session.js";
import { workspacePath } from "../../web/src/lib/format.js";
import { parseUnifiedDiff, toolSummary } from "../../web/src/lib/turn.js";

test("G054-FR7 a unified diff splits into files with numbered lines and counts, and text without headers keeps the given name", () => {
  const files = parseUnifiedDiff([
    "diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ export function a() {", " const x = 1;", "-const y = 2;", "+const y = 3;", "+const z = 4;", " return x;",
    "--- a/docs/b.md", "+++ b/docs/b.md", "@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file",
  ].join("\n"), "fallback");
  assert.deepEqual(files.map(file => [file.path, file.add, file.del]), [["src/a.ts", 2, 1], ["docs/b.md", 1, 1]]);
  const lines = files[0]!.lines.filter(line => line.kind !== "file" && line.kind !== "meta");
  assert.deepEqual(lines.map(line => [line.kind, line.oldNo ?? null, line.newNo ?? null, line.text]), [
    ["hunk", null, null, "@@ -10,3 +10,4 @@ export function a() {"], ["context", 10, 10, "const x = 1;"], ["remove", 11, null, "const y = 2;"],
    ["add", null, 11, "const y = 3;"], ["add", null, 12, "const z = 4;"], ["context", 12, 13, "return x;"],
  ]);
  assert.equal(files[1]!.lines.at(-1)?.kind, "meta", "the no-newline marker is shown, never counted");
  // A program that reports only hunks still gets a file named after where it said it edited.
  const bare = parseUnifiedDiff("@@ -1,2 +1,2 @@\n-a\n+b\n c\n", "README.md");
  assert.deepEqual(bare.map(file => [file.path, file.add, file.del]), [["README.md", 1, 1]]);
  // A new file names its target, a deleted one its source.
  assert.equal(parseUnifiedDiff("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+x", "?")[0]!.path, "new.txt");
  assert.equal(parseUnifiedDiff("--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x", "?")[0]!.path, "gone.txt");
});

test("G054-FR7 the folded process line counts each kind of tool and always says what failed or never finished", () => {
  const tool = (id: string, kind: string, status: string, parentId?: string): PublicTool => ({ id, title: id, kind, status, ...(parentId ? { parentId } : {}) });
  const tools = [tool("r1", "read", "completed"), tool("r2", "read", "completed"), tool("s", "search", "completed"), tool("x1", "execute", "failed"),
    tool("e", "edit", "completed"), tool("agent", "other", "completed"), tool("child", "execute", "completed", "agent"), tool("x2", "execute", "pending")];
  const ended = toolSummary(tools, false);
  assert.equal(ended.text, "读取 2 个文件，搜索 1 次，执行 2 条命令，改动 1 个文件，子 Agent 1 个，1 项失败，1 项未完成");
  assert.deepEqual([ended.failed, ended.unfinished, ended.running], [1, 1, null]);
  // While the Turn runs, a pending tool is the one running now, not an unfinished one.
  const running = toolSummary(tools, true);
  assert.equal(running.unfinished, 0); assert.equal(running.running?.id, "x2");
  assert.equal(running.text, "读取 2 个文件，搜索 1 次，执行 2 条命令，改动 1 个文件，子 Agent 1 个，1 项失败");
  assert.equal(toolSummary([tool("d", "declined-kind", "declined")], false).text, "其他工具 1 个，1 项失败");
});

test("G054-FR3 a changed file is named relative to the conversation's workspace, also when the diff dropped its leading slash", () => {
  const workspace = "/private/tmp/hub/dev-ws";
  assert.equal(workspacePath("private/tmp/hub/dev-ws/src/a.ts", workspace), "src/a.ts");
  assert.equal(workspacePath("/tmp/hub/dev-ws/b.md", workspace), "b.md", "macOS reports /tmp and /private/tmp for the same directory");
  assert.equal(workspacePath("/Users/someone/elsewhere/c.ts", workspace), "~/elsewhere/c.ts");
  assert.equal(workspacePath("src/relative.ts", workspace), "src/relative.ts");
});
