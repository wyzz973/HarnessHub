import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagementError, type ManagementInstallContext } from "../../src/contracts/management.js";
import { runManagementProcess } from "../../src/infrastructure/management/process.js";

async function fixture(fn: (root: string, controller: AbortController, context: ManagementInstallContext) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-management-process-"))), controller = new AbortController();
  try { await fn(root, controller, { stage: root, signal: controller.signal, log: () => {}, assertOwned: () => {} }); } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
}
test("management process captures stdout independently from warning diagnostics", async () => fixture(async (root, _controller, context) => {
  const logs: string[] = [];
  const output = await runManagementProcess(process.execPath, ["-e", 'process.stderr.write("warning\\n");process.stdout.write(JSON.stringify({version:"1.0.0"}))'], root, { HOME: root }, { ...context, log: (stream, text) => logs.push(stream + ":" + text) });
  assert.deepEqual(JSON.parse(output), { version: "1.0.0" }); assert.ok(logs.includes("stderr:warning"));
}));
test("management process cancellation escalates a TERM-ignoring actual child and waits for exit", async () => fixture(async (root, controller, context) => {
  let pid = 0;
  const operation = runManagementProcess(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log("ready:"+process.pid);setInterval(()=>{},1000)'], root, { HOME: root },
    { ...context, log: (_stream, text) => { if (text.startsWith("ready:")) { pid = Number(text.slice(6)); controller.abort(); } } });
  await assert.rejects(operation, error => error instanceof ManagementError && error.code === "CANCELLED"); assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0));
}));
test("exit zero does not leave a same-group descendant writing the managed slot", async () => fixture(async (root, _controller, context) => {
  const script = 'const {spawn}=require("node:child_process");const fs=require("node:fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync("child.pid",String(c.pid));c.unref();console.log("finished")';
  await runManagementProcess(process.execPath, ["-e", script], root, { HOME: root }, context);
  const pid = Number(await readFile(join(root, "child.pid"), "utf8")); assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0));
}));
test("process output overflow and failed spawn reject without changing the completion contract", async () => fixture(async (root, _controller, context) => {
  await assert.rejects(runManagementProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000))'], root, { HOME: root }, context, 100), error => error instanceof ManagementError && error.code === "OUTPUT_LIMIT");
  await assert.rejects(runManagementProcess(join(root, "missing"), [], root, {}, context), error => error instanceof ManagementError && error.code === "PROCESS_START_FAILED");
}));
