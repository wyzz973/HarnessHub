import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagementError, type ManagementInstallContext } from "../../src/contracts/management.js";
import { homebrewCache, homebrewEnvironment, homebrewSandboxIdentity, runHomebrewProtected } from "../../src/infrastructure/management/homebrew.js";
import { protectedConfigurationPaths } from "../../src/infrastructure/management/native.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { guardTest, snapshot, standaloneHeader, type SuiteEvidence } from "./guard.js";
/**
 * The user's own environment. No Harness runs here, so the guard (./guard.ts) proves its shared list untouched: the shell
 * startup files, ~/.npmrc and ~/.agents/skills, which Homebrew could reach. HH_REAL_EVIDENCE, when set, receives the record (0600).
 */
const environment = captureNativeEnvironment(), evidencePath = process.env.HH_REAL_EVIDENCE, evidence: SuiteEvidence = { header: null, results: [] };

// Each run starts Homebrew's own Ruby, about 18 seconds with Homebrew 7.0.9 on 2026-10-17; four runs share one budget.
test("original Homebrew authenticates one inherited sandbox and denies configuration writes", { timeout: 180000 }, async t => {
  assert.equal(process.platform, "darwin", "required native Homebrew protection acceptance needs its macOS host");
  const before = await snapshot([], environment);
  const manager = "/opt/homebrew/bin/brew", root = await mkdtemp(join(tmpdir(), "brew-native-protection-")); t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = guardTest(t, before, environment, evidencePath, evidence);
  evidence.header ??= await standaloneHeader([], { root, workspaceLockRoot: join(root, "locks"), policy: "official" });
  assert.match((await homebrewSandboxIdentity(manager))!, /^[a-f0-9]{64}$/);
  const protectedFile = join(root, "protected-model.json"); await writeFile(protectedFile, "unchanged", { mode: 0o600 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, USER: process.env.USER ?? "", HOMEBREW_NO_AUTO_UPDATE: "1" }, signal = new AbortController().signal;
  const logs: string[] = [], context = (stage: string): ManagementInstallContext => ({ stage, signal, assertOwned() {}, log(_stream, line) { logs.push(line); } });
  const failed = (error: unknown): boolean => error instanceof ManagementError && error.code === "PROCESS_FAILED";
  const read = join(root, "read"); await mkdir(read);
  await runHomebrewProtected(manager, ["ruby", "-e", "require 'sandbox'; raise 'not inherited' unless Sandbox.inherited_sandbox?; puts 'authentic inherited sandbox'"], [], [], env, context(read));
  assert.ok(logs.some(line => line.includes("authentic inherited sandbox")));
  logs.length = 0;
  // A second run in the same stage, as an upgrade runs Homebrew after reading its dry run again.
  await runHomebrewProtected(manager, ["ruby", "-e", "puts 'second run in one stage'"], [], [], env, context(read));
  assert.ok(logs.some(line => line.includes("second run in one stage")));
  logs.length = 0;
  const deny = join(root, "deny"); await mkdir(deny);
  await assert.rejects(runHomebrewProtected(manager, ["ruby", "-e", "File.write(ARGV.fetch(0), 'changed')", protectedFile], [], [protectedFile], env, context(deny)), failed);
  assert.ok(logs.some(line => line.includes("Operation not permitted") && line.includes(protectedFile)));
  assert.equal(await readFile(protectedFile, "utf8"), "unchanged");
  // Homebrew's own executable must stay protected, independently of the model rule.
  logs.length = 0;
  const repository = join(root, "repository"); await mkdir(repository);
  await assert.rejects(runHomebrewProtected(manager, ["ruby", "-e", "File.open(HOMEBREW_BREW_FILE, File::WRONLY) {}"], [], [], env, context(repository)), failed);
  assert.ok(logs.some(line => line.includes("Operation not permitted")));
  outcome.completed = true;
});

test("Homebrew maintenance runs with the user's home and cache, and the user's configuration there stays unwritable (ADR-044)", { timeout: 180000 }, async t => {
  assert.equal(process.platform, "darwin", "required native Homebrew protection acceptance needs its macOS host");
  const before = await snapshot([], environment);
  const manager = "/opt/homebrew/bin/brew", root = await realpath(await mkdtemp(join(tmpdir(), "brew-user-cache-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const outcome = guardTest(t, before, environment, evidencePath, evidence);
  evidence.header ??= await standaloneHeader([], { root, workspaceLockRoot: join(root, "locks"), policy: "official" });
  // A home of this test's own stands for the user's: its shell startup file and configuration directory, and Homebrew's cache under it.
  const home = join(root, "home"); await mkdir(join(home, ".config"), { recursive: true }); await writeFile(join(home, ".zshrc"), "unchanged", { mode: 0o600 });
  const source = { home, values: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", USER: process.env.USER ?? "" } };
  const { directories, files } = protectedConfigurationPaths(source), cache = homebrewCache(source), signal = new AbortController().signal, logs: string[] = [];
  const context = async (name: string): Promise<ManagementInstallContext> => { const stage = join(root, name); await mkdir(stage); return { stage, signal, assertOwned() {}, log(_stream, line) { logs.push(line); } }; };
  const failed = (error: unknown): boolean => error instanceof ManagementError && error.code === "PROCESS_FAILED";
  assert.equal(cache, join(home, "Library", "Caches", "Homebrew"));
  // Its cache is the user's, where its local records and downloads live.
  await runHomebrewProtected(manager, ["ruby", "-e", "require 'fileutils'; FileUtils.mkdir_p(ARGV.fetch(0)); File.write(File.join(ARGV.fetch(0), 'probe'), 'cached'); puts ENV.fetch('HOMEBREW_CACHE')", cache],
    directories, files, homebrewEnvironment(source, root), await context("cache"), { cache: "user" });
  assert.equal(await readFile(join(cache, "probe"), "utf8"), "cached"); assert.ok(logs.includes(cache), "Homebrew used the user's cache");
  // The user's shell startup file and configuration directory are denied, though the home is the user's own.
  for (const [name, target] of [["zshrc", join(home, ".zshrc")], ["config", join(home, ".config", "written")]] as const)
    await assert.rejects(runHomebrewProtected(manager, ["ruby", "-e", "File.write(ARGV.fetch(0), 'changed')", target], directories, files, homebrewEnvironment(source, root), await context(name), { cache: "user" }), failed, target);
  assert.equal(await readFile(join(home, ".zshrc"), "utf8"), "unchanged"); assert.equal(existsSync(join(home, ".config", "written")), false);
  outcome.completed = true;
});
