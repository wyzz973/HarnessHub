import assert from "node:assert/strict";
import test from "node:test";
import type { ControlObservation, InstallationSource } from "../../src/contexts/catalog/domain/catalog.js";
import { harnessEntry } from "../../src/web/harness-entry.js";

function control(source: InstallationSource | null, command = true): ControlObservation {
  const candidate = source === null ? null : { path: "/private/entry", resolvedPath: "/private/entry", source, entries: [] };
  return { id: "fixture-control", protocol: "acp-v1", source: { repository: "fixture", revision: "r", upstreamId: "fixture", url: "https://example.invalid" },
    state: command ? "candidate" : "missing_dependency", command: command ? { executable: "/private/entry", args: [], env: {} } : null,
    installation: { candidates: candidate ? [candidate] : [], selected: candidate, defaultResolution: candidate ? "located" : "none", diagnostics: [] },
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
