import assert from "node:assert/strict";
import test from "node:test";
import { nativeResume } from "../../src/infrastructure/management/verified-versions.js";

test("continuing in the original program gives each product's commands for a plain identifier, whatever version is installed (ADR-039, ADR-053)", () => {
  // No version is passed and none is read: the same answer for every installed version of a product.
  const id = "ebe4c04a-20fb-49dd-93b7-d264a1187cb8", outside = { git: false }, repository = { git: true }, question = " \"你的问题\"";
  const both = (harnessId: string, reference: string, workspace: { git: boolean }, interactive: string, once: string) => {
    const view = nativeResume(harnessId, reference, workspace); assert.ok(view, harnessId);
    assert.deepEqual(view, { harnessId, nativeId: reference, interactive, once, ...(view.onceNote === undefined ? {} : { onceNote: view.onceNote }) }, harnessId);
    assert.ok(view.interactive && view.once, harnessId + " gives both forms");
  };
  both("claude", id, outside, "claude --resume " + id, "claude -p --resume " + id + question);
  assert.equal(nativeResume("claude", id, repository)?.once, "claude -p --resume " + id + question, "no other program depends on the workspace");
  // Codex's one-question form bypasses its Git repository check only where the workspace is no repository; its interactive form has no such flag.
  const thread = "01a12cdd-07cd-7541-97fc-c41b242c85e0";
  assert.deepEqual(nativeResume("codex", thread, outside), { harnessId: "codex", nativeId: thread, interactive: "codex resume " + thread,
    once: "codex exec --skip-git-repo-check resume " + thread + question, onceNote: "工作区不是 git 仓库，Codex 需要这个标志" });
  both("codex", thread, repository, "codex resume " + thread, "codex exec resume " + thread + question);
  both("opencode", "ses_ed322dcf7ffe892PKrBGRgoBKW", outside, "opencode -s ses_ed322dcf7ffe892PKrBGRgoBKW", "opencode run -s ses_ed322dcf7ffe892PKrBGRgoBKW" + question);
  both("hermes", id, outside, "hermes --resume " + id, "hermes chat --resume " + id + " -q" + question);
  // DeepSeek Harness ships no interactive profile to resume in (no tui): only its one-question form, with the credentials it depends on.
  const dsh = nativeResume("dsh", id, outside); assert.ok(dsh);
  assert.deepEqual(dsh, { harnessId: "dsh", nativeId: id, once: "dsh headless --session-id " + id + question, onceNote: dsh.onceNote });
  assert.equal("interactive" in dsh, false, "no interactive field, not even undefined");
  assert.match(dsh.onceNote ?? "", /^dsh headless 不读 DeepSeek Harness 界面里保存的密钥和账号登录.*DEEPSEEK_API_KEY.*~\/\.dsh\/\.env.*credentials、authorization、deepseek-account 三行设为 disabled）$/u);
  assert.equal(nativeResume("dsh", id, repository)?.onceNote, dsh.onceNote, "fixed: the workspace changes nothing for dsh");
  // A product without a continue command HarnessHub can give: the identifier alone, and why; no inherited key is a product.
  assert.deepEqual(nativeResume("cursor", id, outside), { harnessId: "cursor", nativeId: id, note: "no-command" });
  assert.deepEqual(nativeResume("constructor", id, outside), { harnessId: "constructor", nativeId: id, note: "no-command" });
  // Pi's reference is a private file path: only where Pi lists its sessions. OpenClaw: nothing.
  assert.deepEqual(nativeResume("pi", JSON.stringify({ path: "/Users/someone/.pi/sessions/a.jsonl", id: "a" }), outside), { harnessId: "pi", list: "见 Pi 自己的会话列表" });
  assert.equal(nativeResume("openclaw", id, outside), null);
  // A reference that is no plain identifier never reaches the page or a command, for a product with commands or without.
  const bad = ["abc; rm -rf ~", "a b", "$(id)", "\"quoted\"", "-r", "x".repeat(129), ""];
  assert.equal(bad.length, 7);
  for (const reference of bad) { assert.equal(nativeResume("claude", reference, outside), null, JSON.stringify(reference)); assert.equal(nativeResume("cursor", reference, outside), null, JSON.stringify(reference)); }
});
