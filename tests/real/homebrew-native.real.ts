import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagementError, type ManagementInstallContext } from "../../src/contracts/management.js";
import { homebrewSandboxIdentity, runHomebrewProtected } from "../../src/infrastructure/management/homebrew.js";

test("original Homebrew authenticates one inherited sandbox and denies configuration writes", { timeout: 60000 }, async t => {
  assert.equal(process.platform, "darwin", "required native Homebrew protection acceptance needs its macOS host");
  const manager = "/opt/homebrew/bin/brew", root = await mkdtemp(join(tmpdir(), "brew-native-protection-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.match((await homebrewSandboxIdentity(manager))!, /^[a-f0-9]{64}$/);
  const protectedFile = join(root, "protected-model.json"); await writeFile(protectedFile, "unchanged", { mode: 0o600 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, USER: process.env.USER ?? "", HOMEBREW_NO_AUTO_UPDATE: "1" }, signal = new AbortController().signal;
  const logs: string[] = [], context = (stage: string): ManagementInstallContext => ({ stage, signal, assertOwned() {}, log(_stream, line) { logs.push(line); } });
  const failed = (error: unknown): boolean => error instanceof ManagementError && error.code === "PROCESS_FAILED";
  const read = join(root, "read"); await mkdir(read);
  await runHomebrewProtected(manager, ["ruby", "-e", "require 'sandbox'; raise 'not inherited' unless Sandbox.inherited_sandbox?; puts 'authentic inherited sandbox'"], [], [], env, context(read));
  assert.ok(logs.some(line => line.includes("authentic inherited sandbox")));
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
});
