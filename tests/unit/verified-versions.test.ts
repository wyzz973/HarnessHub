import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFIED_VERSIONS, nativeResume, versionVerification } from "../../src/infrastructure/management/verified-versions.js";

test("a version is verified only where HarnessHub ran it for real; unknown versions and Harnesses claim nothing", () => {
  assert.deepEqual(versionVerification("claude", "2.1.296", "0.89.1"), { state: "verified", program: "2.1.296", adapter: "0.89.1" });
  assert.equal(versionVerification("claude", "2.1.300", "0.89.1")?.state, "unverified", "a newer product");
  assert.equal(versionVerification("claude", "2.1.296", "0.90.0")?.state, "unverified", "a newer adapter in front of a verified product");
  assert.equal(versionVerification("claude", "2.1.296", "2.1.296")?.state, "verified", "an entry without its own version");
  assert.deepEqual(versionVerification("codex", "0.162.1", "0.162.1"), { state: "verified", program: "0.162.1" });
  assert.equal(versionVerification("codex", "0.163.0", "0.163.0")?.state, "unverified");
  assert.equal(versionVerification("codex", "0.162.1-alpha.2", "0.162.1-alpha.2")?.state, "unverified", "a prerelease of the verified version");
  assert.equal(versionVerification("cursor", "2026.10.01-e373342", null)?.state, "verified", "a version that is not semver matches exactly");
  assert.equal(versionVerification("cursor", "2026.10.02-a1b2c3d", null)?.state, "unverified");
  assert.equal(versionVerification("dsh", "0.2.1-alpha.1", null)?.state, "verified");
  assert.equal(versionVerification("dsh", "0.2.1", null)?.state, "unverified", "the release after the verified prerelease");
  assert.equal(versionVerification("gemini", null, "0.62.0"), null, "no product version, no claim");
  assert.equal(versionVerification("autohand", "1.0.0", "1.0.0"), null, "a Harness never verified");
  assert.equal(versionVerification("constructor", "1.0.0", null), null, "no inherited key counts as a Harness");
});

test("the verified versions are the installations the capability matrix records for its real checks", () => {
  const matrix = JSON.parse(readFileSync(fileURLToPath(new URL("../../../plan/native-capabilities.json", import.meta.url)), "utf8")) as { harnesses: { id: string; installation: string }[] };
  const installations = new Map(matrix.harnesses.map(harness => [harness.id, harness.installation]));
  assert.deepEqual([...Object.keys(VERIFIED_VERSIONS)].sort(), [...installations.keys()].sort(), "every Harness of the matrix, and no other");
  for (const [id, verified] of Object.entries(VERIFIED_VERSIONS)) {
    const installation = installations.get(id)!;
    assert.ok(installation.includes(verified.program[1]), `${id}: the matrix was checked on ${verified.program[1]}: ${installation}`);
    if (verified.adapter) assert.ok(installation.includes(verified.adapter[1]), `${id}: the matrix names adapter ${verified.adapter[1]}`);
  }
});

test("continuing in the original program gives the verified commands only for a verified version and a plain identifier", () => {
  const verified = { state: "verified" as const, program: "2.1.296", adapter: "0.89.1" }, unverified = { state: "unverified" as const, program: "2.1.296" };
  const id = "ebe4c04a-20fb-49dd-93b7-d264a1187cb8", outside = { git: false }, repository = { git: true };
  assert.deepEqual(nativeResume("claude", id, verified, outside), { harnessId: "claude", nativeId: id, interactive: "claude --resume " + id, once: "claude -p --resume " + id + " \"你的问题\"" });
  // Codex's one-question form bypasses its Git repository check only where the workspace is no repository; its interactive form has no such flag.
  const thread = "01a12cdd-07cd-7541-97fc-c41b242c85e0", codex = { state: "verified" as const, program: "0.162.1" };
  assert.deepEqual(nativeResume("codex", thread, codex, outside), { harnessId: "codex", nativeId: thread, interactive: "codex resume " + thread,
    once: "codex exec --skip-git-repo-check resume " + thread + " \"你的问题\"", onceNote: "工作区不是 git 仓库，Codex 需要这个标志" });
  assert.deepEqual(nativeResume("codex", thread, codex, repository), { harnessId: "codex", nativeId: thread, interactive: "codex resume " + thread, once: "codex exec resume " + thread + " \"你的问题\"" });
  assert.equal(nativeResume("claude", id, verified, repository)?.once, "claude -p --resume " + id + " \"你的问题\"", "no other program depends on it");
  assert.equal(nativeResume("opencode", "ses_ed322dcf7ffe892PKrBGRgoBKW", { state: "verified", program: "1.18.35" }, outside)?.interactive, "opencode -s ses_ed322dcf7ffe892PKrBGRgoBKW");
  assert.equal(nativeResume("hermes", id, { state: "verified", program: "0.12.0" }, outside)?.once, "hermes chat --resume " + id + " -q \"你的问题\"");
  assert.equal(nativeResume("dsh", id, { state: "verified", program: "0.2.1-alpha.1" }, outside)?.interactive, "dsh tui --resume " + id);
  // Another version, a version not known, or a program whose resume was never verified: the identifier alone, and why.
  assert.deepEqual(nativeResume("claude", id, unverified, outside), { harnessId: "claude", nativeId: id, note: "version-unverified" });
  assert.deepEqual(nativeResume("claude", id, null, outside), { harnessId: "claude", nativeId: id, note: "version-unverified" });
  assert.deepEqual(nativeResume("cursor", id, { state: "verified", program: "2026.10.01-e373342" }, outside), { harnessId: "cursor", nativeId: id, note: "not-verified" });
  // Pi's reference is a private file path: only where Pi lists its sessions. OpenClaw: nothing.
  assert.deepEqual(nativeResume("pi", JSON.stringify({ path: "/Users/someone/.pi/sessions/a.jsonl", id: "a" }), { state: "verified", program: "0.85.1" }, outside), { harnessId: "pi", list: "见 Pi 自己的会话列表" });
  assert.equal(nativeResume("openclaw", id, { state: "verified", program: "2026.3.23-2" }, outside), null);
  // A reference that is no plain identifier never reaches the page or a command.
  for (const reference of ["abc; rm -rf ~", "a b", "$(id)", "\"quoted\"", "-r", "x".repeat(129), ""]) assert.equal(nativeResume("claude", reference, verified, outside), null, JSON.stringify(reference));
  assert.equal(nativeResume("constructor", id, verified, outside)?.note, "not-verified", "no inherited key is a program's command");
});
