import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import snapshot from "../../src/infrastructure/catalog/acp-registry.json" with { type: "json" };
import { importRegistry } from "../../src/infrastructure/catalog/registry.js";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";

function changedAgent(index: number, change: (agent: Record<string, unknown>) => void): unknown {
  const modified = structuredClone(snapshot);
  const entry = modified.entries[index];
  assert.ok(entry);
  change(entry.agent as Record<string, unknown>);
  entry.sha256 = createHash("sha256").update(JSON.stringify(entry.agent)).digest("hex");
  return modified;
}

test("42 fixed stable ACP records preserve revision, metadata integrity, licenses and product identities", () => {
  const definitions = importRegistry(snapshot, "darwin-aarch64");
  assert.equal(definitions.length, 42);
  assert.equal(snapshot.entries.length, 42);
  assert.equal(snapshot.license, "Apache-2.0");
  assert.ok(snapshot.entries.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sourceSha256)));
  assert.ok(definitions.flatMap((definition) => definition.controls).every((control) => control.source.revision === snapshot.revision));
  assert.ok(snapshot.entries.every((entry) => typeof entry.agent.license === "string"));
  assert.equal(definitions.find((definition) => definition.id === "qwen")?.controls[0]?.source.upstreamId, "qwen-code");
});

test("separate distributions remain separate controls and same-name Copilot products remain distinct", () => {
  const definitions = importRegistry(snapshot, "darwin-aarch64");
  assert.equal(definitions.flatMap((definition) => definition.controls).length, 44);
  assert.deepEqual(definitions.find((definition) => definition.id === "kilo")?.controls.map((control) => control.id), ["kilo-binary", "kilo-npm"]);
  const cli = definitions.find((definition) => definition.id === "github-copilot-cli");
  const server = definitions.find((definition) => definition.id === "github-copilot");
  assert.ok(cli); assert.ok(server); assert.equal(cli.name, server.name);
  assert.equal(cli.controls[0]?.package?.name, "@github/copilot");
  assert.equal(server.controls[0]?.package?.name, "@github/copilot-language-server");
  assert.deepEqual(server.controls[0]?.executableNames, []);
});

test("reviewed wrappers and package commands preserve dependency separation without npx or uvx launch", () => {
  const definitions = importRegistry(snapshot, "darwin-aarch64");
  const controls = definitions.flatMap((definition) => definition.controls);
  assert.ok(controls.every((control) => !control.executableNames.includes("npx") && !control.executableNames.includes("uvx")));
  assert.deepEqual(definitions.find((definition) => definition.id === "pi")?.controls[0]?.requiredExecutables, ["pi"]);
  assert.deepEqual(definitions.find((definition) => definition.id === "claude")?.controls[0]?.requiredExecutables, []);
  assert.deepEqual(definitions.find((definition) => definition.id === "codex")?.controls[0]?.requiredExecutables, []);
  assert.deepEqual(definitions.find((definition) => definition.id === "deepagents")?.controls[0]?.package?.binNames, []);
  assert.equal(definitions.find((definition) => definition.id === "minion-code")?.controls[0]?.package?.name, "minion-code");
  assert.equal(definitions.find((definition) => definition.id === "fast-agent")?.controls[0]?.package?.version, "0.10.1");
});

test("archive-relative paths and product-specific argv/env remain authoritative metadata", () => {
  const definitions = importRegistry(snapshot, "darwin-aarch64");
  const first = (id: string) => definitions.find((definition) => definition.id === id)?.controls[0];
  assert.equal(first("cortex-code")?.distribution?.relativeExecutable, "./coco-1.0.73+180523.e6179a031de9-darwin-arm64/cortex");
  assert.equal(first("cursor")?.distribution?.relativeExecutable, "./dist-package/cursor-agent");
  assert.equal(first("junie")?.distribution?.relativeExecutable, "./Applications/junie.app/Contents/MacOS/junie");
  assert.deepEqual(first("grok-build")?.args, ["agent", "stdio"]);
  assert.deepEqual(first("factory-droid")?.args, ["exec", "--output-format", "acp-daemon"]);
  assert.deepEqual(first("qwen")?.args, ["--acp", "--experimental-skills"]);
  assert.deepEqual(first("vtcode")?.env, { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" });
});

test("stable import excludes preview and can represent a missing host distribution without dropping product", () => {
  const darwin = importRegistry(snapshot, "darwin-aarch64");
  const linux = importRegistry(snapshot, "linux-aarch64");
  assert.equal(linux.length, 42);
  assert.equal(linux.find((definition) => definition.id === "vtcode")?.controls.length, 0);
  assert.equal(darwin.find((definition) => definition.id === "claude")?.controls[0]?.package?.version, "0.88.0");
  assert.ok(!darwin.flatMap((definition) => definition.controls).some((control) => control.package?.version.includes("preview")));
});

test("builtin catalog explicitly combines native and ACP controls while retaining source identities", () => {
  const definitions = loadBuiltinCatalog("darwin-aarch64");
  assert.equal(definitions.length, 43);
  assert.equal(definitions.flatMap((definition) => definition.controls).length, 47);
  assert.deepEqual(definitions.find((definition) => definition.id === "codex")?.controls.map((control) => control.protocol), ["codex-app-server", "acp-v1"]);
  assert.deepEqual(definitions.find((definition) => definition.id === "pi")?.controls.map((control) => control.protocol), ["pi-rpc", "acp-v1"]);
  assert.deepEqual(definitions.find((definition) => definition.id === "openclaw")?.controls[0]?.args, ["acp"]);
  assert.equal(definitions.filter((definition) => definition.id === "cursor").length, 1);
  assert.deepEqual(definitions.find((definition) => definition.id === "claude")?.aliases, ["claude-acp"]);
});

test("malformed envelope, unknown fields, hash corruption and duplicate upstream IDs reject", () => {
  const duplicate = structuredClone(snapshot); duplicate.entries.push(duplicate.entries[0]!);
  const corrupted = structuredClone(snapshot); corrupted.entries[0]!.agent.name = "Changed";
  for (const value of [null, [], { ...snapshot, schemaVersion: 2 }, { ...snapshot, unknown: true }, { ...snapshot, entries: null },
    { ...snapshot, revision: "main" }, duplicate, corrupted, { ...snapshot, entries: Array(129).fill(snapshot.entries[0]) }])
    assert.throws(() => importRegistry(value, "darwin-aarch64"));
  assert.throws(() => importRegistry(snapshot, "unknown-host"), /unsupported registry platform/);
});

test("registry rejects malicious archive paths and invalid package/environment fields even with a valid metadata hash", () => {
  const binaryIndex = snapshot.entries.findIndex((entry) => entry.agent.id === "cursor");
  const npmIndex = snapshot.entries.findIndex((entry) => entry.agent.id === "gemini");
  const archive = changedAgent(binaryIndex, (agent) => { agent.distribution = { binary: { "darwin-aarch64": { archive: "https://example.com/archive", cmd: "../escape" } } }; });
  const shell = changedAgent(binaryIndex, (agent) => { agent.distribution = { binary: { "darwin-aarch64": { archive: "https://example.com/archive", cmd: "./bad command" } } }; });
  const packageName = changedAgent(npmIndex, (agent) => { agent.distribution = { npx: { package: "../escape@1.0.0" } }; });
  const unknown = changedAgent(npmIndex, (agent) => { agent.distribution = { npx: { package: "@google/gemini-cli@1", shell: "exec" } }; });
  const env = changedAgent(npmIndex, (agent) => { agent.distribution = { npx: { package: "@google/gemini-cli@1", env: { "BAD-KEY": "x" } } }; });
  for (const value of [archive, shell, packageName, unknown, env]) assert.throws(() => importRegistry(value, "darwin-aarch64"));
});
