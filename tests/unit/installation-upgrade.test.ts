import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagementError, type InstallationObservation, type ManagementInstallContext } from "../../src/contracts/management.js";
import { homebrewPlanLine, LocalInstallationUpgrader, parseHomebrewPlan, sharedRuntimes } from "../../src/infrastructure/management/installation-upgrade.js";
import { homebrewEnvironment } from "../../src/infrastructure/management/homebrew.js";
import { officialInstallMethod, productChannels } from "../../src/adapters/catalog-channels.js";
import { parseManagementInput } from "../../src/contexts/management/domain/input.js";
import { parseManagementJob, parseUpgradeRequest } from "../../src/contexts/management/domain/state.js";
import { adapterVersionVerification } from "../../src/infrastructure/management/verified-versions.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof ManagementError && error.code === expected;
// The shapes Homebrew 7.0.9 printed on 2026-10-17 for `brew upgrade --dry-run` (standard output; tap warnings go to standard error).
const FFMPEG = `==> Would install 2 dependencies:
mpg123  1.33.7
sdl3    3.4.18
==> Would upgrade 5 dependencies:
lame         3.100   -> 4.0
libvpx       1.16.0  -> 1.17.0
sdl2-compat  2.32.10 -> 2.32.74
svt-av1      4.1.0   -> 4.2.0
x265         4.2     -> 4.3
==> Would upgrade 1 requested outdated package
ffmpeg 8.1_1 -> 9.0.2_1 (21.5MB)
==> Would upgrade 1 dependent
openai-whisper 20250625_4 -> 20250625_7 (10.1MB)
`;
const GEMINI = `Warning: The following taps are not trusted:
  steipete/tap
==> Downloading bottle manifests
✔︎ Bottle Manifest gemini-cli (0.46.0)
==> Would upgrade 1 requested outdated package
gemini-cli 0.38.2 -> 0.46.0 (21.8MB)
==> 1 Deprecated or disabled package
gemini-cli (deprecated)
`;

test("G011-UG1 Homebrew's dry run is read as the packages it would upgrade, newly install and upgrade as dependents, and a shared runtime among them is named", () => {
  const ffmpeg = parseHomebrewPlan(FFMPEG);
  assert.deepEqual(ffmpeg.packages.map(entry => [entry.name, entry.action, entry.from, entry.to]), [
    ["mpg123", "install", null, "1.33.7"], ["sdl3", "install", null, "3.4.18"], ["lame", "upgrade", "3.100", "4.0"], ["libvpx", "upgrade", "1.16.0", "1.17.0"], ["sdl2-compat", "upgrade", "2.32.10", "2.32.74"],
    ["svt-av1", "upgrade", "4.1.0", "4.2.0"], ["x265", "upgrade", "4.2", "4.3"], ["ffmpeg", "upgrade", "8.1_1", "9.0.2_1"], ["openai-whisper", "dependent", "20250625_4", "20250625_7"]]);
  assert.deepEqual(ffmpeg.deprecated, []);
  assert.deepEqual(ffmpeg.packages.filter(entry => entry.name !== "ffmpeg").map(homebrewPlanLine).slice(0, 3), ["新装 mpg123 1.33.7", "新装 sdl3 3.4.18", "升级 lame 3.100 → 4.0"]);
  assert.equal(homebrewPlanLine(ffmpeg.packages.at(-1)!), "升级依赖它的 openai-whisper 20250625_4 → 20250625_7");
  // Tap warnings and the manifest lines are not packages; a package Homebrew marks deprecated is named.
  const gemini = parseHomebrewPlan(GEMINI);
  assert.deepEqual(gemini.packages, [{ name: "gemini-cli", action: "upgrade", from: "0.38.2", to: "0.46.0" }]);
  assert.deepEqual(gemini.deprecated, ["gemini-cli"]);
  assert.deepEqual(parseHomebrewPlan("Warning: Not upgrading codex, the latest version is already installed\n"), { packages: [], deprecated: [] });
  assert.deepEqual(sharedRuntimes(["升级 node 24.1.0 → 25.0.0", "新装 python@3.14 3.14.1", "升级 lame 3.100 → 4.0", "升级依赖它的 node@22 22.1.0 → 22.2.0", "升级 nodejs-helper 1 → 2"]),
    ["升级 node 24.1.0 → 25.0.0", "新装 python@3.14 3.14.1", "升级依赖它的 node@22 22.1.0 → 22.2.0"]);
});

test("G011-UG2 an installation upgrade names the installation and its confirmed check; its frozen request and job facts are checked field by field", () => {
  const ref = "a".repeat(64), fingerprint = "b".repeat(64);
  assert.deepEqual(parseManagementInput({ harnessId: "claude", action: "upgrade", commandId: "g-1", installation: ref, expectedInstallationFingerprint: fingerprint }),
    { harnessId: "claude", action: "upgrade", commandId: "g-1", installation: ref, expectedInstallationFingerprint: fingerprint });
  for (const input of [{ harnessId: "claude", action: "upgrade", commandId: "g", installation: ref, expectedInstallationFingerprint: fingerprint, controlId: "claude-acp-npm" },
    { harnessId: "claude", action: "upgrade", commandId: "g", installation: ref, expectedInstallationFingerprint: fingerprint, expectedNativeFingerprint: fingerprint },
    { harnessId: "claude", action: "upgrade", commandId: "g", installation: ref, expectedInstallationFingerprint: fingerprint, restartServices: [] }])
    assert.throws(() => parseManagementInput(input), code("INVALID_INPUT"), JSON.stringify(input));
  const target = { harnessId: "claude", controlId: "claude-acp-npm", ref, role: "product", channel: "npm", name: "@anthropic-ai/claude-code", root: "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code",
    prefix: "/opt/homebrew", entry: "/opt/homebrew/bin/claude", resolvedPath: "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", version: "2.1.296", active: false, label: "npm 全局（Homebrew Node）", fingerprint: "c".repeat(64) };
  const request = { target, kind: "version", command: "/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.305", executable: "/opt/homebrew/bin/npm",
    args: ["install", "--global", "--prefix", "/opt/homebrew", "@anthropic-ai/claude-code@2.1.305"], env: {}, writes: ["/opt/homebrew"], shellProfile: null, configFiles: [], version: "2.1.305", dependencies: [], script: null, runtime: null, fingerprint };
  assert.equal(parseUpgradeRequest(request).version, "2.1.305");
  const rerun = { ...request, kind: "rerun", executable: "/bin/sh", args: ["/data/install-jobs/x/install.sh"], env: { CODEX_NON_INTERACTIVE: "1" }, version: null,
    script: { path: "/data/install-jobs/x/install.sh", source: "https://releases.openai.com/codex/install.sh", sha256: "d".repeat(64), interpreter: "sh" } };
  assert.equal(parseUpgradeRequest(rerun).script?.interpreter, "sh");
  for (const invalid of [{ ...request, kind: "rerun" }, { ...rerun, script: null }, { ...request, executable: "npm" }, { ...request, writes: ["relative"] }, { ...request, env: { "bad-name": "x" } },
    { ...request, kind: "terminal" }, { ...rerun, script: { ...rerun.script, interpreter: "zsh" } }, { ...request, target: { ...target, fingerprint: "/tmp" } }])
    assert.throws(() => parseUpgradeRequest(invalid), code("INVALID_DATA"), JSON.stringify(invalid).slice(0, 120));
  const job = { id: "management-77777777-7777-4777-8777-777777777777", harnessId: "claude", controlId: "claude-acp-npm", action: "upgrade", status: "completed", phase: "completed", cancelRequested: false,
    createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:01:00.000Z", resolvedVersion: "2.1.305", installationId: null, error: null, logCursor: 2,
    native: { channel: "npm", location: "/opt/homebrew/bin/claude", beforeVersion: "2.1.296", actualVersion: "2.1.305", dispatched: true, configurationPreserved: true,
      installation: { label: "npm 全局（Homebrew Node）", role: "product", kind: "version", command: request.command, dependencies: [], shellChanges: [], configChanges: [], blocked: [] } } };
  assert.deepEqual(parseManagementJob(job), job);
  // A completed upgrade read its new version, and that version is the job's; only an upgrade carries upgrade facts.
  for (const invalid of [{ ...job, resolvedVersion: "2.1.304" }, { ...job, native: { ...job.native, actualVersion: null } }, { ...job, action: "install" }, { ...job, native: { ...job.native, dispatched: false } },
    { ...job, native: { ...job.native, installation: { ...job.native.installation, kind: "terminal" } } }, { ...job, native: { ...job.native, restartServices: [] } }])
    assert.throws(() => parseManagementJob(invalid), code("INVALID_DATA"), JSON.stringify(invalid).slice(0, 160));
});

test("G011-UG3 every script layout says how it updates: the product's own updater, its official script again, or a command only for the terminal", () => {
  const upgrade = (id: string) => productChannels(id)?.scripts[0]?.upgrade;
  assert.deepEqual(upgrade("claude"), { kind: "self-update", args: ["update"], command: "claude update" });
  assert.deepEqual(upgrade("cursor"), { kind: "self-update", args: ["update"], command: "agent update" });
  for (const id of ["codex", "opencode"]) { assert.deepEqual(upgrade(id), { kind: "rerun" }, id); assert.equal(officialInstallMethod(id)?.kind, "script", id + " reruns the script it installs with"); }
  const hermes = upgrade("hermes");
  assert.equal(hermes?.kind, "terminal"); if (hermes?.kind === "terminal") { assert.equal(hermes.command, "hermes update --yes"); assert.match(hermes.explains, /git stash.*config\.yaml.*重启网关/su); }
  // A self-updating product updates inside what its official install may write.
  for (const id of ["claude", "cursor"]) assert.equal(officialInstallMethod(id)?.kind, "script", id);
  // An adapter version is verified against the adapter HarnessHub ran, not the product.
  assert.deepEqual(adapterVersionVerification("claude", "0.89.1"), { state: "verified", program: "2.1.296", adapter: "0.89.1" });
  assert.equal(adapterVersionVerification("claude", "0.90.0")?.state, "unverified");
  assert.equal(adapterVersionVerification("codex", "1.0.0"), null);
});

test("G011-UG4 an installation's version is the one its channel records, and a Homebrew run keeps the user's home, settings and local records", async t => {
  // Channel roots are resolved paths, as discovery classifies a program by the path it resolves to.
  const root = await realpath(await mkdtemp(join(tmpdir(), "upgrade-version-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), source = { home, values: { HOME: home, PATH: "/usr/bin:/bin", HOMEBREW_BOTTLE_DOMAIN: "https://mirror.example/bottles", HOMEBREW_CACHE: join(root, "brew-cache") } };
  const upgrader = new LocalInstallationUpgrader(source, { npm: null });
  const context: ManagementInstallContext = { stage: root, signal: new AbortController().signal, assertOwned: () => {}, log: () => {} };
  const base = { harnessId: "claude", controlId: "claude-acp-npm", ref: "a".repeat(64), role: "product" as const, active: false, label: "x", version: null };
  const npmRoot = join(root, "prefix", "lib", "node_modules", "@anthropic-ai", "claude-code"); await mkdir(npmRoot, { recursive: true });
  await writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.305" }));
  const npm: InstallationObservation = { ...base, channel: "npm", name: "@anthropic-ai/claude-code", root: npmRoot, prefix: join(root, "prefix"), entry: join(root, "prefix", "bin", "claude"), resolvedPath: join(npmRoot, "cli.js") };
  assert.equal(await upgrader.version(npm, context), "2.1.305");
  assert.equal(upgrader.kind(npm), "version");
  // A Homebrew keg and a script's versions directory name the version the command resolves to now.
  const keg = join(root, "brew", "Cellar", "gemini-cli", "0.46.0", "bin"); await mkdir(keg, { recursive: true }); await writeFile(join(keg, "gemini"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(root, "brew", "bin")); await symlink(join(keg, "gemini"), join(root, "brew", "bin", "gemini"));
  const brew: InstallationObservation = { ...base, harnessId: "gemini", channel: "brew-formula", name: "gemini-cli", root: join(root, "brew", "Cellar", "gemini-cli"), prefix: join(root, "brew"), entry: join(root, "brew", "bin", "gemini"), resolvedPath: join(keg, "gemini") };
  assert.equal(await upgrader.version(brew, context), "0.46.0");
  const versions = join(home, ".local", "share", "claude", "versions"); await mkdir(versions, { recursive: true }); await writeFile(join(versions, "2.1.302"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(home, ".local", "bin"), { recursive: true }); await symlink(join(versions, "2.1.302"), join(home, ".local", "bin", "claude"));
  const script: InstallationObservation = { ...base, channel: "script", name: ".local/share/claude/versions", root: versions, prefix: null, entry: join(home, ".local", "bin", "claude"), resolvedPath: join(versions, "2.1.302") };
  assert.equal(await upgrader.version(script, context), "2.1.302");
  assert.equal(upgrader.kind(script), "self-update");
  assert.equal(upgrader.kind({ ...script, role: "adapter" }), null, "an adapter's script layout is not a product's");
  assert.equal(upgrader.kind({ ...npm, channel: "uv" }), null);
  // The user's Homebrew settings reach Homebrew; HarnessHub's own switches override them, and nothing points it at a private home.
  const env = homebrewEnvironment({ ...source, values: { ...source.values, HOMEBREW_NO_AUTO_UPDATE: "0" } }, root);
  assert.deepEqual([env.HOME, env.HOMEBREW_CACHE, env.HOMEBREW_BOTTLE_DOMAIN, env.HOMEBREW_NO_AUTO_UPDATE, env.HOMEBREW_NO_INSTALL_CLEANUP, env.HOMEBREW_NO_AUTOREMOVE, env.TMPDIR],
    [home, join(root, "brew-cache"), "https://mirror.example/bottles", "1", "1", "1", root]);
  assert.equal(homebrewEnvironment({ home, values: { HOME: home } }, root).HOMEBREW_CACHE, join(home, "Library", "Caches", "Homebrew"));
});
