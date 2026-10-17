import assert from "node:assert/strict";
import test from "node:test";
import type { ControlObservation, InstallationSource } from "../../src/contexts/catalog/domain/catalog.js";
import { harnessEntry, productCommand } from "../../src/web/harness-entry.js";

function control(source: InstallationSource | null, command = true): ControlObservation {
  const candidate = source === null ? null : { path: "/private/entry", resolvedPath: "/private/entry", source, entries: [], channel: null, version: null, role: "product" as const };
  return { id: "fixture-control", protocol: "acp-v1", source: { repository: "fixture", revision: "r", upstreamId: "fixture", url: "https://example.invalid" },
    state: command ? "candidate" : "missing_dependency", command: command ? { executable: "/private/entry", args: [], env: {} } : null,
    installation: { candidates: candidate ? [candidate] : [], selected: candidate, defaultResolution: candidate ? "located" : "none", diagnostics: [], unofficial: [], unofficialDefault: null },
    missingDependencies: [], diagnostics: [], probe: "not_run" };
}

test("entry sources use the terms comparable products use and never carry the entry path", () => {
  assert.deepEqual(harnessEntry(control("path"), false), { source: "path" });
  for (const source of ["known-directory", "manager-directory", "configured-directory"] as const) assert.deepEqual(harnessEntry(control(source), false), { source: "standard-directory" });
  assert.deepEqual(harnessEntry(control("override"), false), { source: "custom-entry" });
  assert.deepEqual(harnessEntry(control("local-package"), false), { source: "package-root" });
  assert.deepEqual(harnessEntry(control("managed"), false), { source: "managed" });
  // A HarnessHub-managed binding wins over where an older system entry was seen.
  assert.deepEqual(harnessEntry(control("path"), true), { source: "managed" });
  // A package resolved from an explicit package root has a command but no located executable.
  assert.deepEqual(harnessEntry(control(null), false), { source: "package-root" });
  assert.equal(harnessEntry(control(null, false), false), null);
  for (const source of ["path", "override", "known-directory"] as const) assert.equal(JSON.stringify(harnessEntry(control(source), false)).includes("/private/entry"), false);
});

test("an adapter entry reports the product's own command, and a product entry reports none", () => {
  const product = { candidates: [{ path: "/bin/claude", resolvedPath: "/lib/claude-code/cli.js", source: "path" as const, entries: [{ path: "/bin/claude", source: "path" as const, name: "claude" }] },
    { path: "/bin/claude-agent-acp", resolvedPath: "/lib/claude-agent-acp/dist/index.js", source: "path" as const, entries: [{ path: "/bin/claude-agent-acp", source: "path" as const, name: "claude-agent-acp" }] }],
    selected: null, defaultResolution: "located" as const, diagnostics: [] };
  const adapter = { ...control("path"), command: { executable: "/bin/claude-agent-acp", args: [], env: { HOME: "/home" } },
    installation: { ...control("path").installation, selected: { path: "/bin/claude-agent-acp", resolvedPath: "/lib/claude-agent-acp/dist/index.js", source: "path" as const, entries: [], channel: null, version: null, role: "adapter" as const } } };
  assert.deepEqual(productCommand("claude", product, adapter), { executable: "/bin/claude", args: [], env: { HOME: "/home" } });
  // The entry is the product itself (Codex's app-server, Hermes's acp): its own version is the product version.
  const itself = { ...adapter, installation: { ...adapter.installation, selected: { path: "/bin/claude", resolvedPath: "/lib/claude-code/cli.js", source: "path" as const, entries: [], channel: null, version: null, role: "adapter" as const } } };
  assert.equal(productCommand("claude", product, itself), null);
  // A package entry run through Node names the product's file as its script.
  assert.equal(productCommand("claude", product, { ...adapter, installation: { ...adapter.installation, selected: null }, command: { executable: "/bin/node", args: ["/lib/claude-code/cli.js"], env: {} } }), null);
  assert.equal(productCommand("missing", product, adapter), null);
  assert.equal(productCommand(undefined, product, adapter), null);
});
