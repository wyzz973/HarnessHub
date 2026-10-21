import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import { capabilityReadTables } from "../../src/adapters/capability-reads.js";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";
import { VERIFIED_VERSIONS, nativeResume, versionConsistency, versionVerification, type VersionConsistencyInput, type VerifiedVersions } from "../../src/infrastructure/management/verified-versions.js";

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
  assert.equal(versionVerification("dsh", "0.2.0-rc.2", null)?.state, "unverified", "the official channel's prerelease, whose rules were read but no Turn verified");
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

/** The capability matrix's Harnesses as `plan/native-capabilities.json` records them. */
function matrixHarnesses(): { readonly id: string; readonly installation: string }[] {
  const value: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../../../plan/native-capabilities.json", import.meta.url)), "utf8"));
  assert.ok(value !== null && typeof value === "object" && "harnesses" in value && Array.isArray(value.harnesses), "the matrix lists its Harnesses");
  return value.harnesses.map((item: unknown) => {
    assert.ok(item !== null && typeof item === "object" && "id" in item && typeof item.id === "string" && "installation" in item && typeof item.installation === "string", "each with an installation");
    return { id: item.id, installation: item.installation };
  });
}
/**
 * The four places as the repository states them: the verified versions, the matrix, the read tables (resolved against
 * a home that is never read) and the version each Harness's own catalog package names. A product's own package is the one
 * its native control names; the registry snapshot's packages are adapters at the registry's versions.
 */
function repository(): VersionConsistencyInput {
  const home = "/fixture/home";
  const readTables = capabilityReadTables({ home, values: {} }, { hermesHome: home + "/.hermes", openclawWorkspace: home + "/.openclaw/workspace" })
    .map(table => ({ harnessId: table.harnessId, verified: table.verified }));
  const catalogPackages = loadBuiltinCatalog("darwin-aarch64").flatMap(definition => definition.controls
    .flatMap(control => control.id === definition.id + "-native" && control.package !== null ? [{ harnessId: definition.id, version: control.package.version }] : []));
  return { verified: VERIFIED_VERSIONS, matrix: matrixHarnesses(), readTables, catalogPackages };
}

test("the verified versions, the capability matrix, the read tables and the catalog's own packages agree (ADR-038, 2026-10-21)", () => {
  const input = repository();
  assert.deepEqual(versionConsistency(input), []);
  // The check covered real packages: Hermes's names the verified version, DeepSeek Harness's the official npm latest.
  assert.deepEqual([...input.catalogPackages].sort((a, b) => a.harnessId.localeCompare(b.harnessId)), [{ harnessId: "dsh", version: "0.2.0-rc.2" }, { harnessId: "hermes", version: "0.12.0" }]);
  // DeepSeek Harness's verified record is from a source build; its read range starts at the prerelease the official channel
  // carries and still covers that record, but only when prereleases are compared as the capability page compares them.
  const dsh = input.readTables.find(table => table.harnessId === "dsh")!.verified;
  assert.equal(dsh, ">=0.2.0-rc.2 <0.3.0"); assert.equal(VERIFIED_VERSIONS.dsh?.unofficial, true);
  assert.equal(satisfies("0.2.0-rc.2", dsh, { includePrerelease: true }), true);
  assert.equal(satisfies("0.2.1-alpha.1", dsh, { includePrerelease: true }), true);
  assert.equal(satisfies("0.2.1-alpha.1", dsh), false, "without prereleases the verified record would fall outside");
});

test("the consistency check rejects every kind of disagreement it names", () => {
  const base = repository();
  const kinds = (input: VersionConsistencyInput) => versionConsistency(input).map(item => [item.harnessId, item.kind]);
  const verified = (changes: Readonly<Record<string, VerifiedVersions>>): VersionConsistencyInput => ({ ...base, verified: { ...base.verified, ...changes } });
  const matrix = (id: string, installation: string, input = base): VersionConsistencyInput => ({ ...input, matrix: input.matrix.map(item => item.id === id ? { ...item, installation } : item) });
  const table = (id: string, range: string, input = base): VersionConsistencyInput => ({ ...input, readTables: input.readTables.map(item => item.harnessId === id ? { ...item, verified: range } : item) });
  const catalog = (id: string, version: string, input = base): VersionConsistencyInput => ({ ...input, catalogPackages: input.catalogPackages.map(item => item.harnessId === id ? { ...item, version } : item) });

  // (a) The same Harnesses in the verified versions, the matrix and the read tables, each once.
  assert.deepEqual(kinds({ ...base, matrix: base.matrix.filter(item => item.id !== "hermes") }), [["hermes", "ids"]]);
  assert.deepEqual(kinds({ ...base, readTables: [...base.readTables, { harnessId: "workbuddy", verified: ">=5.0.0 <6.0.0" }] }), [["workbuddy", "ids"], ["workbuddy", "ids"]], "missing from the verified versions and the matrix");
  assert.deepEqual(kinds({ ...base, matrix: [...base.matrix, base.matrix[0]!] }), [[base.matrix[0]!.id, "ids"]], "named twice");
  // (b) The matrix's installation names the verified version whole, and the adapter's.
  assert.deepEqual(kinds(matrix("claude", "Claude Code 2.1.300 + claude-agent-acp 0.89.1")), [["claude", "matrix"]]);
  assert.deepEqual(kinds(matrix("claude", "Claude Code 2.1.2960 + claude-agent-acp 0.89.1")), [["claude", "matrix"]], "a longer version is not the verified one");
  assert.deepEqual(kinds(matrix("claude", "Claude Code 2.1.296.1 + claude-agent-acp 0.89.1")), [["claude", "matrix"]], "nor one with another part");
  assert.deepEqual(kinds(matrix("claude", "Claude Code 2.1.296")), [["claude", "matrix"]], "the adapter is named too");
  assert.deepEqual(kinds(matrix("claude", "Claude Code v2.1.296, claude-agent-acp 0.89.1.")), [], "a v before it and a full stop after it still name it");
  // (c) The read range covers both ends of the verified range, and is a range.
  assert.deepEqual(kinds(table("claude", ">=2.1.297 <2.2.0")), [["claude", "read-range"]], "the lower end outside");
  const widened = matrix("codex", "Codex CLI 0.170.0", verified({ codex: { program: ["0.162.1", "0.170.0"] } }));
  assert.deepEqual(kinds(widened), [["codex", "read-range"]], "the upper end outside");
  assert.deepEqual(kinds(table("hermes", ">=0.12 <")), [["hermes", "read-range"]], "no range");
  // Prereleases: once the prerelease the official channel carries is verified for real, the earlier range misses it
  // (0.2.0-rc.2 comes before 0.2.0) and the range starting at it holds it. A range starting at 0.2.1 misses the
  // verified 0.2.1-alpha.1, and the catalog's 0.2.0-rc.2 with it.
  const reverified = matrix("dsh", "DeepSeek Harness 0.2.0-rc.2（npm 官网）", verified({ dsh: { program: ["0.2.0-rc.2", "0.2.0-rc.2"] } }));
  assert.deepEqual(kinds(table("dsh", ">=0.2.0 <0.3.0", reverified)), [["dsh", "read-range"]]);
  assert.deepEqual(kinds(reverified), []);
  assert.deepEqual(kinds(table("dsh", ">=0.2.1 <0.3.0")), [["dsh", "read-range"], ["dsh", "catalog-package"]]);
  // (d) A Harness's own catalog package names the verified version...
  assert.deepEqual(kinds(catalog("hermes", "0.12.1")), [["hermes", "catalog-package"]]);
  assert.deepEqual(kinds(verified({ dsh: { program: ["0.2.1-alpha.1", "0.2.1-alpha.1"] } })), [["dsh", "catalog-package"]], "without the unofficial mark, today's DeepSeek Harness disagrees");
  // ...or, for a record from an unofficial installation, a version its read rules were checked on.
  assert.deepEqual(kinds(catalog("dsh", "0.3.0")), [["dsh", "catalog-package"]]);
  assert.deepEqual(kinds(catalog("dsh", "0.2.0-rc.1")), [["dsh", "catalog-package"]]);
  assert.deepEqual(kinds({ ...base, catalogPackages: [...base.catalogPackages, { harnessId: "workbuddy", version: "2.115.0" }] }), [["workbuddy", "catalog-package"]], "nothing verified to compare with");
  assert.deepEqual(kinds({ ...base, catalogPackages: [...base.catalogPackages, { harnessId: "hermes", version: "0.12.0" }] }), [["hermes", "catalog-package"]], "a second package of its own");
  // Each finding says what disagrees.
  assert.deepEqual(versionConsistency(catalog("hermes", "0.12.1")), [{ harnessId: "hermes", kind: "catalog-package", detail: "the catalog names 0.12.1, the verified upper end is 0.12.0" }]);
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
