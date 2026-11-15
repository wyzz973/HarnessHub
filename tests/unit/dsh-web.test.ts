import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { declaredEndpoints, patchText, preflight } from "../../src/adapters/control/dsh-web/preflight.js";
import { catalogOf, modelId, routeOf, turnResult } from "../../src/adapters/control/dsh-web/mapping.js";
import { dshReading } from "../../src/adapters/control/dsh-web/control.js";

const CONTRACTS = ["dsh-api-session-controller", "dsh-commands", "dsh-client-file-upload"];
async function stand(t: { after: (fn: () => Promise<void>) => void }, version: string, edit?: (pkg: string, text: string) => string): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "dsh-preflight-")), "dsh");
  t.after(() => rm(join(root, ".."), { recursive: true, force: true }));
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version }));
  await copyFile(resolve("tests/fixtures/dsh-web/bin.mjs"), join(root, "lib", "bin.js")); await chmod(join(root, "lib", "bin.js"), 0o755);
  for (const pkg of CONTRACTS) {
    await mkdir(join(root, "node_modules", "@deepseek-ai", pkg, "lib"), { recursive: true });
    const text = await readFile(resolve("tests/fixtures/dsh-web/contracts", pkg + ".txt"), "utf8");
    await writeFile(join(root, "node_modules", "@deepseek-ai", pkg, "lib", "typert.remote-client.d.ts"), edit ? edit(pkg, text) : text);
  }
  return join(root, "lib", "bin.js");
}

test("dsh Web host preflight: the generated contracts are read for every endpoint and its argument names", async () => {
  const declared = declaredEndpoints(await readFile(resolve("tests/fixtures/dsh-web/contracts/dsh-api-session-controller.txt"), "utf8"));
  assert.deepEqual(declared.get("session/prompt"), ["request"]);
  assert.deepEqual(declared.get("session/list"), ["_request"]);
  assert.deepEqual(declared.get("session/modelCatalog"), []);
  assert.deepEqual(declaredEndpoints(await readFile(resolve("tests/fixtures/dsh-web/contracts/dsh-commands.txt"), "utf8")).get("commands/execute"), ["agentId", "line", "submittedAttachments"]);
});

test("dsh Web host preflight: the version it was probed on passes, an older one or a renamed argument does not, and a missing optional endpoint only turns its feature off", async t => {
  const ok = await preflight(await stand(t, "0.2.2-rc.1"));
  assert.equal(ok.ok, true);
  assert.ok(ok.ok && ok.features.has("fork") && ok.features.has("title") && ok.features.has("files"));
  assert.equal((await preflight(await stand(t, "0.3.0"))).ok, true, "a later version passes when its contracts still match");
  const old = await preflight(await stand(t, "0.2.1-rc.5"));
  assert.ok(!old.ok && /0\.2\.1-rc\.5/u.test(old.reason));
  const renamed = await preflight(await stand(t, "0.2.2-rc.2", (pkg, text) => pkg === "dsh-commands" ? text.replace("'line'", "'commandLine'") : text));
  assert.ok(!renamed.ok && /commands\/execute/u.test(renamed.reason));
  const noFork = await preflight(await stand(t, "0.2.2-rc.2", (pkg, text) => pkg === "dsh-api-session-controller" ? text.split("\n").filter(line => !line.includes("'session/fork'")).join("\n") : text));
  assert.ok(noFork.ok && !noFork.features.has("fork"));
  assert.equal((await preflight(process.execPath)).ok, false, "a program that is not the npm dsh");
});

test("dsh Web host overlay: config writes off, the model a new session starts on, the Hub's tool server with the table read from dsh's own environment", () => {
  const text = patchText({ model: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "low" },
    tools: { name: "harnesshub", command: "/usr/local/bin/node", args: ["/opt/hub/hub-tools.js", "mcp"], env: { HARNESSHUB_PROGRESS: "off", HARNESSHUB_INSTRUCTIONS: "第一行\n\"第二行\"" }, fromProcess: ["HARNESSHUB_URL", "HARNESSHUB_SESSION"] } });
  assert.match(text, /^- id: config-editor\n {2}disabled: true$/mu);
  assert.match(text, /- id: agent-default-model\n {2}config:\n {4}provider: "deepseek-official"\n {4}model: "deepseek-v4-flash"\n {4}reasoningEffort: "low"/u);
  assert.match(text, /HARNESSHUB_SESSION: !!js process\.env\.HARNESSHUB_SESSION/u, "the token is read by dsh, never written");
  assert.match(text, /HARNESSHUB_INSTRUCTIONS: "第一行\\n\\"第二行\\""/u);
  assert.match(text, /serverName: "harnesshub"\n {8}transport: stdio/u);
  assert.doesNotMatch(patchText({ model: null, tools: null }), /agent-default-model|harnesshub/u);
});

test("dsh Web host mapping: model ids are its ACP's, the last turn's end is the Turn's result, and its catalog keeps a route it does not list", () => {
  assert.equal(modelId("deepseek-official", "deepseek-v4-flash"), "[\"deepseek-official\",\"deepseek-v4-flash\"]");
  assert.deepEqual(routeOf(modelId("a", "b")), { provider: "a", model: "b" });
  assert.equal(routeOf("deepseek-v4-flash"), null);
  assert.deepEqual(turnResult("completed", null, false), { status: "completed", reason: "end_turn" });
  assert.deepEqual(turnResult("aborted", null, true), { status: "cancelled", reason: "cancelled" });
  assert.equal(turnResult("aborted", null, false).status, "failed", "a stop the Hub did not ask for is not the Hub's cancel");
  assert.equal(turnResult("error", "RATE_LIMIT", false).error?.code, "NATIVE_RATE_LIMITED");
  assert.equal(turnResult("error", "SERVER", false).error?.code, "MODEL_REQUEST_FAILED");
  assert.equal(turnResult("blocked", null, false).error?.code, "NATIVE_TURN_BLOCKED");
  const catalog = catalogOf({ default: { provider: "p", model: "own" }, groups: [{ id: "p", models: [{ id: "m", name: "M", reasoning: { efforts: [{ id: "off" }, { id: "high" }], defaultEffort: "high" } }] }] }, []);
  assert.deepEqual(catalog.models.map(model => model.id), [modelId("p", "m"), modelId("p", "own")]);
  assert.equal(catalog.defaultModel, modelId("p", "own"));
  assert.deepEqual(catalog.models[0]!.options?.[0]?.values.map(value => value.value), ["off", "high"]);
});

test("dsh reading: the Hub's clear alone, the commands its catalog lists, every other input as text", () => {
  const lookup = (name: string) => name === "compact" ? { effect: "compact" as const } : undefined;
  assert.equal(dshReading("/clear", lookup).kind, "command");
  assert.deepEqual(dshReading("/compact", lookup), { kind: "command", name: "compact", args: "", effect: "compact" });
  assert.deepEqual(dshReading("/permission read-only", lookup), { kind: "content" }, "the Hub's levels are the Hub's");
  assert.deepEqual(dshReading("/compact", () => undefined), { kind: "content" }, "dsh's ACP lists no commands");
  assert.equal(dshReading("/compact", null).kind, "possible_command");
});
