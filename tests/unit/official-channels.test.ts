import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyProgram, homebrewName, homebrewReceiptTap } from "../../src/contexts/catalog/domain/channels.js";
import { adapterChannels, productChannels, productMaintenance } from "../../src/adapters/catalog-channels.js";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";
import { LocalInstallationClassifier } from "../../src/infrastructure/discovery/installation-channels.js";

const HOME = "/Users/me", UV = HOME + "/.local/share/uv/tools";
const at = (path: string, resolvedPath = path) => ({ path, resolvedPath });
const channel = (harness: string, path: string, resolvedPath?: string, exists: (path: string) => boolean = () => false) => classifyProgram(at(path, resolvedPath), productChannels(harness)!, HOME, UV, exists);

test("G012-OC1 a found program counts as installed only in a channel its product's official documentation describes (ADR-044)", () => {
  // npm global packages count under any prefix: Homebrew's Node.js or a version manager's.
  assert.deepEqual(channel("openclaw", "/opt/homebrew/bin/openclaw", "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs"),
    { kind: "npm", name: "openclaw", root: "/opt/homebrew/lib/node_modules/openclaw", prefix: "/opt/homebrew" });
  assert.deepEqual(channel("claude", HOME + "/.nvm/versions/node/v26.11.1/bin/claude", HOME + "/.nvm/versions/node/v26.11.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
    { kind: "npm", name: "@anthropic-ai/claude-code", root: HOME + "/.nvm/versions/node/v26.11.1/lib/node_modules/@anthropic-ai/claude-code", prefix: HOME + "/.nvm/versions/node/v26.11.1" });
  // Homebrew formulae and casks, recognized before npm: Gemini's formula carries its own lib/node_modules.
  assert.deepEqual(channel("gemini", "/opt/homebrew/bin/gemini", "/opt/homebrew/Cellar/gemini-cli/0.38.2/libexec/lib/node_modules/@google/gemini-cli/bundle/gemini.js"),
    { kind: "brew-formula", name: "gemini-cli", root: "/opt/homebrew/Cellar/gemini-cli", prefix: "/opt/homebrew" });
  assert.equal(channel("codex", "/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.162.1/bin/codex")?.kind, "brew-cask");
  assert.equal(channel("opencode", "/opt/homebrew/bin/opencode", "/opt/homebrew/Cellar/opencode/1.18.35/bin/opencode")?.kind, "brew-formula");
  // Official scripts: their own directories, and a launcher whose program is inside one.
  assert.equal(channel("cursor", HOME + "/.local/bin/cursor-agent", HOME + "/.local/share/cursor-agent/versions/2026.10.01-e373342/cursor-agent")?.kind, "script");
  assert.equal(channel("claude", HOME + "/.local/bin/claude", HOME + "/.local/share/claude/versions/2.1.296")?.name, ".local/share/claude/versions");
  assert.equal(channel("opencode", HOME + "/.opencode/bin/opencode")?.kind, "script");
  // Hermes's launchers start the checkout's .hermes/bin/hermes; 0.12's started venv/bin/hermes, which still counts.
  const hermes = { kind: "script", name: ".hermes/hermes-agent", root: HOME + "/.hermes/hermes-agent", prefix: null };
  for (const launcher of ["hermes", "hermes-acp", "hermes-agent"])
    assert.deepEqual(channel("hermes", HOME + "/.local/bin/" + launcher, HOME + "/.local/bin/" + launcher, path => path === HOME + "/.hermes/hermes-agent/.hermes/bin/hermes"), hermes, launcher);
  assert.deepEqual(channel("hermes", HOME + "/.local/bin/hermes", HOME + "/.local/bin/hermes", path => path === HOME + "/.hermes/hermes-agent/venv/bin/hermes"), hermes);
  assert.deepEqual(channel("hermes", HOME + "/.local/bin/hermes", HOME + "/.hermes/hermes-agent/.hermes/bin/hermes"), hermes, "a link into the checkout is inside its root");
  assert.equal(channel("hermes", HOME + "/.local/bin/hermes", HOME + "/.local/bin/hermes", () => false), null, "a launcher without its program is not an installation");
  assert.equal(channel("hermes", HOME + "/.local/bin/hermes", HOME + "/.local/bin/hermes", path => path === HOME + "/.hermes/hermes-agent/bin/hermes"), null, "a program the installer never starts is not one");
  assert.equal(channel("hermes", HOME + "/.local/bin/hermes-tools", HOME + "/.local/bin/hermes-tools", () => true), null, "a launcher the installer does not write is not one");
  // pnpm and bun global installs of the official package are listed, as channels not maintained yet.
  assert.deepEqual(channel("gemini", HOME + "/Library/pnpm/gemini", HOME + "/Library/pnpm/global/5/node_modules/.pnpm/@google+gemini-cli@0.62.0/node_modules/@google/gemini-cli/bundle/gemini.js"),
    { kind: "pnpm", name: "@google/gemini-cli", root: HOME + "/Library/pnpm/global/5/node_modules/.pnpm/@google+gemini-cli@0.62.0/node_modules/@google/gemini-cli", prefix: HOME + "/Library/pnpm" });
  assert.equal(channel("openclaw", HOME + "/.bun/bin/openclaw", HOME + "/.bun/install/global/node_modules/openclaw/openclaw.mjs")?.kind, "bun");
  assert.equal(channel("openclaw", HOME + "/work/app/node_modules/.bin/openclaw", HOME + "/work/app/node_modules/openclaw/openclaw.mjs"), null, "a project's own dependency is not an installation");
  // Not official: a source checkout linked onto PATH, an `npm link`, another package of the same name, an unrelated keg.
  assert.equal(channel("pi", "/opt/homebrew/bin/pi", HOME + "/Desktop/project/pi/packages/coding-agent/dist/cli.js"), null);
  assert.equal(channel("dsh", HOME + "/bin/dsh", HOME + "/Desktop/project/deepseek-harness/lib/bin.js"), null);
  assert.equal(channel("openclaw", "/opt/homebrew/bin/openclaw", "/opt/homebrew/lib/node_modules/openclaw-fork/openclaw.mjs"), null);
  assert.equal(channel("opencode", "/opt/homebrew/bin/opencode", "/opt/homebrew/Cellar/opencode-dev/1.0.0/bin/opencode"), null);
  assert.equal(channel("cursor", HOME + "/bin/cursor-agent", HOME + "/.local/share/cursor-agent-copy/cursor-agent"), null, "a root is matched as a whole directory");
});

test("G012-OC1 an adapter is official through the package its registry entry publishes", () => {
  const catalog = loadBuiltinCatalog("darwin-aarch64"), claude = catalog.find(item => item.id === "claude")!, cursor = catalog.find(item => item.id === "cursor")!;
  const adapter = adapterChannels("claude", claude.controls.find(control => control.id === "claude-acp-npm")!)!;
  assert.deepEqual(adapter.npm, ["@agentclientprotocol/claude-agent-acp"]);
  assert.equal(classifyProgram(at("/opt/homebrew/bin/claude-agent-acp", "/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"), adapter, HOME, UV, () => false)?.kind, "npm");
  // A registry archive is official in the directory HarnessHub installs archives into; a control with no package has none.
  assert.deepEqual(adapterChannels("cursor", cursor.controls.find(control => control.distribution?.kind === "binary")!)?.scripts, [{ root: ".local/share/harnesses/cursor", launchers: [], program: null, formerPrograms: [], removal: null, upgrade: null }],
    "HarnessHub's own archive layout is not one it uninstalls or upgrades");
  assert.equal(adapterChannels("pi", catalog.find(item => item.id === "pi")!.controls.find(control => control.id === "pi-native")!), null);
  // Each control either runs the product (its first command) or is an adapter: Claude Code's ACP entry, Codex's app-server.
  assert.equal(claude.binaryNames[0], "claude"); assert.ok(claude.controls.find(control => control.id === "claude-acp-npm")!.executableNames.every(name => name !== "claude"));
  assert.ok(catalog.find(item => item.id === "codex")!.controls.find(control => control.id === "codex-native")!.executableNames.includes("codex"));
  // Every product HarnessHub runs today has its channels recorded with where they were read.
  for (const id of ["claude", "codex", "opencode", "openclaw", "gemini", "cursor", "pi", "hermes", "dsh"]) {
    const recorded = productChannels(id); assert.ok(recorded, id); assert.match(recorded.source.url, /^https:\/\//u); assert.equal(recorded.source.checkedAt, "2026-10-17");
    assert.ok(recorded.npm.length + recorded.brewFormulae.length + recorded.brewCasks.length + recorded.scripts.length + recorded.uv.length > 0, id);
  }
});

test("G012-OC1 a script installation's version is read from its files: Hermes's from its virtual environment's dist-info, none without one", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "official-channels-")));
  const root = join(home, ".hermes", "hermes-agent"), program = join(root, "venv", "bin", "hermes"), launcher = join(home, ".local", "bin", "hermes");
  const site = join(root, "venv", "lib", "python3.11", "site-packages");
  t.after(async () => {
    // The environment is made unreadable below; it is restored first so that the whole home can be removed.
    try { await chmod(site, 0o755); } catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await rm(home, { recursive: true, force: true });
  });
  const put = async (path: string, text: string, mode = 0o644) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); };
  // As the official installer leaves it: the program inside the checkout's environment and a launcher that starts it.
  await put(program, "#!/bin/sh\nexit 3\n", 0o755);
  await put(launcher, "#!/bin/bash\nexec \"" + program + "\" \"$@\"\n", 0o755);
  const classifier = new LocalInstallationClassifier(home, join(home, ".local", "share", "uv", "tools"));
  const read = async (harness: string, path: string) => classifier.classify({ path, resolvedPath: await realpath(path), source: "path", entries: [] }, productChannels(harness)!);
  // Without dist-info the installation is official, and its version unknown.
  assert.deepEqual(await read("hermes", launcher), { channel: { kind: "script", name: ".hermes/hermes-agent", root, prefix: null }, version: null });
  // Another distribution's dist-info, or one whose METADATA names another distribution, is not Hermes's version.
  await put(join(site, "hermes_agent_tools-1.0.0.dist-info", "METADATA"), "Name: hermes-agent-tools\nVersion: 1.0.0\n");
  await put(join(site, "hermes_agent-9.9.9.dist-info", "METADATA"), "Name: other-agent\nVersion: 9.9.9\n");
  assert.equal((await read("hermes", launcher))?.version, null);
  // Its own dist-info: the version, through the launcher or the program itself.
  await put(join(site, "hermes_agent-0.12.0.dist-info", "METADATA"), "Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.12.0\n");
  assert.equal((await read("hermes", launcher))?.version, "0.12.0");
  assert.equal((await read("hermes", program))?.version, "0.12.0");
  // An environment that cannot be read leaves the version unknown; the installation still counts.
  await chmod(site, 0o000);
  assert.deepEqual(await read("hermes", launcher), { channel: { kind: "script", name: ".hermes/hermes-agent", root, prefix: null }, version: null });
  await chmod(site, 0o755);
  // A layout that keeps versions side by side is read by its directory; one with neither has no version to read.
  const versioned = join(home, ".local", "share", "claude", "versions", "2.1.296");
  await put(versioned, "#!/bin/sh\nexit 3\n", 0o755); await symlink(versioned, join(home, ".local", "bin", "claude"));
  assert.equal((await read("claude", join(home, ".local", "bin", "claude")))?.version, "2.1.296");
  await put(join(home, ".opencode", "bin", "opencode"), "#!/bin/sh\nexit 3\n", 0o755);
  assert.deepEqual(await read("opencode", join(home, ".opencode", "bin", "opencode")), { channel: { kind: "script", name: ".opencode/bin", root: join(home, ".opencode", "bin"), prefix: null }, version: null });
});

test("G012-OC1 a Homebrew install receipt names another tap's formula or cask in full; Homebrew's own tap and anything malformed leave the bare name", () => {
  const receipt = (tap: unknown) => ({ homebrew_version: "5.1.0", source: { path: "/opt/homebrew/Library/Taps/x/y.rb", tap, spec: "stable" } });
  assert.equal(homebrewReceiptTap("brew-formula", receipt("anomalyco/tap")), "anomalyco/tap");
  assert.equal(homebrewReceiptTap("brew-cask", receipt("farion1231/ccswitch")), "farion1231/ccswitch");
  // Homebrew's own taps, in any case: the bare name stays.
  for (const [kind, tap] of [["brew-formula", "homebrew/core"], ["brew-formula", "Homebrew/Core"], ["brew-cask", "homebrew/cask"]] as const) assert.equal(homebrewReceiptTap(kind, receipt(tap)), null, tap);
  // A receipt without a well-formed tap is not used: nothing in it can reach a Homebrew command line.
  for (const value of [null, [], "anomalyco/tap", {}, { source: null }, { source: [] }, { source: "anomalyco/tap" }, receipt(undefined), receipt(7), receipt(""), receipt("anomalyco"),
    receipt("anomalyco/tap/opencode"), receipt("../tap"), receipt("-x/tap"), receipt("anomalyco/-tap"), receipt("anomalyco/ta p"), receipt("anomalyco/tap\n--force"), receipt("a".repeat(65) + "/tap")])
    assert.equal(homebrewReceiptTap("brew-formula", value), null, JSON.stringify(value));
  assert.equal(homebrewName("opencode", "anomalyco/tap"), "anomalyco/tap/opencode");
  assert.equal(homebrewName("opencode", null), "opencode");
});

test("G012-OC1 discovery records the tap a keg's or cask's install receipt names, and only for Homebrew; a receipt it cannot use is ignored", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "official-channels-brew-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path: string, text: string, mode = 0o644) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); };
  const home = join(root, "home"), brew = join(root, "homebrew"), keg = join(brew, "Cellar", "opencode", "1.18.35"), program = join(keg, "bin", "opencode"), receipt = join(keg, "INSTALL_RECEIPT.json");
  await put(program, "#!/bin/sh\nexit 3\n", 0o755);
  const classifier = new LocalInstallationClassifier(home, join(home, ".local", "share", "uv", "tools"));
  const read = (harness: string, path: string) => classifier.classify({ path, resolvedPath: path, source: "path", entries: [] }, productChannels(harness)!);
  const bare = { kind: "brew-formula", name: "opencode", root: join(brew, "Cellar", "opencode"), prefix: brew };
  const tapped = (tap: string) => JSON.stringify({ homebrew_version: "5.1.0", source: { path: brew + "/Library/Taps/anomalyco/homebrew-tap/opencode.rb", tap, spec: "stable", versions: { stable: "1.18.35" } } });
  // As this computer's OpenCode keg records it: installed from anomalyco/tap, so Homebrew knows it as anomalyco/tap/opencode.
  await put(receipt, tapped("anomalyco/tap"));
  assert.deepEqual(await read("opencode", program), { channel: { ...bare, tap: "anomalyco/tap" }, version: "1.18.35" });
  // Homebrew's own tap, no receipt, and receipts that cannot be used: no tap is recorded, and the installation still counts.
  await put(receipt, tapped("homebrew/core"));
  assert.deepEqual(await read("opencode", program), { channel: bare, version: "1.18.35" });
  for (const bytes of ["{\"source\":", "ÿ", Buffer.from([0xff, 0xfe]), " ".repeat(64 * 1024 + 1) + "{}"]) {
    await writeFile(receipt, bytes);
    assert.deepEqual(await read("opencode", program), { channel: bare, version: "1.18.35" }, String(bytes).slice(0, 12));
  }
  await rm(receipt);
  assert.deepEqual(await read("opencode", program), { channel: bare, version: "1.18.35" });
  // A receipt that is a link is not followed, and one that is a directory is not read.
  await put(join(root, "elsewhere.json"), tapped("anomalyco/tap")); await symlink(join(root, "elsewhere.json"), receipt);
  assert.deepEqual(await read("opencode", program), { channel: bare, version: "1.18.35" });
  await rm(receipt); await mkdir(receipt);
  assert.deepEqual(await read("opencode", program), { channel: bare, version: "1.18.35" });
  // A cask keeps its receipt in .metadata: another tap's is recorded, Homebrew's own cask tap is not.
  const cask = join(brew, "Caskroom", "codex"), binary = join(cask, "0.162.1", "codex");
  await put(binary, "#!/bin/sh\nexit 3\n", 0o755);
  await put(join(cask, ".metadata", "INSTALL_RECEIPT.json"), JSON.stringify({ source: { tap: "openai/tap", version: "0.162.1" } }));
  assert.deepEqual(await read("codex", binary), { channel: { kind: "brew-cask", name: "codex", root: cask, prefix: brew, tap: "openai/tap" }, version: "0.162.1" });
  await put(join(cask, ".metadata", "INSTALL_RECEIPT.json"), JSON.stringify({ source: { tap: "homebrew/cask", version: "0.162.1" } }));
  assert.deepEqual(await read("codex", binary), { channel: { kind: "brew-cask", name: "codex", root: cask, prefix: brew }, version: "0.162.1" });
  // Other channels never carry a tap, whatever files lie beside them.
  const npm = join(brew, "lib", "node_modules", "openclaw");
  await put(join(npm, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.3.23-2" })); await put(join(npm, "openclaw.mjs"), "#!/bin/sh\nexit 3\n", 0o755);
  await put(join(npm, "INSTALL_RECEIPT.json"), tapped("anomalyco/tap"));
  assert.deepEqual(await read("openclaw", join(npm, "openclaw.mjs")), { channel: { kind: "npm", name: "openclaw", root: npm, prefix: brew }, version: "2026.3.23-2" });
});

test("G012-OC1 Hermes's resident gateway is recognized by its command line in every form v0.22 and 0.12 start it, with options and their values before gateway", () => {
  const [resident] = productMaintenance("hermes").resident, checkout = HOME + "/.hermes/hermes-agent";
  assert.equal(resident?.stop, "hermes gateway stop");
  for (const command of [
    // Unsupervised, as v0.22's runtime starts it (gateway_runtime_start.py), and as 0.12's launchd job ran it.
    "python -m hermes_cli.main --profile default gateway run --replace", "/opt/homebrew/opt/python@3.11/bin/python3.11 -m hermes_cli.main --profile default gateway run --quiet --idle-exit",
    checkout + "/venv/bin/python -m hermes_cli.main gateway",
    // Under launchd, behind hermes_cli.stderr_timestamp (gateway_launchd.py), with or without a profile.
    checkout + "/.hermes/bin/hermes --run-module hermes_cli.stderr_timestamp --error-log " + HOME + "/.hermes/logs/gateway.error.log -- " + checkout + "/.hermes/bin/hermes gateway run --external-supervisor",
    checkout + "/.hermes/bin/hermes --profile work gateway run --external-supervisor",
    // In a terminal.
    "hermes gateway run", HOME + "/.local/bin/hermes gateway", "hermes --quiet gateway", "hermes -p=work gateway run"])
    assert.ok(resident?.command.test(command), command);
  for (const command of [checkout + "/.hermes/bin/hermes acp", HOME + "/.local/bin/hermes-acp", "python -m hermes_cli.main --profile default acp", "hermes chat --resume 20261022_101010_abcdef",
    "grep hermes gateway", HOME + "/bin/hermes-gateway-monitor", "vim " + HOME + "/notes/hermes gateway.md", "hermes_cli.mainx gateway run", "hermes gateway-status"])
    assert.equal(resident?.command.test(command), false, command);
});

test("G012-OC1 Hermes's version is the one its checkout's install stamp names; without a stamp only 0.12's own environment has one, and 0.0.0 is no version", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "official-channels-hermes-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const put = async (path: string, text: string, mode = 0o644) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); };
  const root = join(home, ".hermes", "hermes-agent"), program = join(root, ".hermes", "bin", "hermes"), stamp = join(root, "install-stamp.json"), site = join(root, "venv", "lib", "python3.11", "site-packages");
  const classifier = new LocalInstallationClassifier(home, join(home, ".local", "share", "uv", "tools"));
  const read = async (path: string) => (await classifier.classify({ path, resolvedPath: await realpath(path), source: "path", entries: [] }, productChannels("hermes")!))?.version;
  // As v0.22.4's installer leaves it: the checkout's launcher and the three launchers in ~/.local/bin that exec it.
  await put(program, "#!/bin/sh\nexec /usr/bin/false -I -c 'import sys' \"$@\"\n", 0o755);
  await put(join(home, ".local", "bin", "hermes"), "#!/bin/sh\nexec " + program + " \"$@\"\n", 0o755);
  await put(join(home, ".local", "bin", "hermes-acp"), "#!/bin/sh\nexec " + join(root, ".hermes", "bin", "hermes-acp") + " \"$@\"\n", 0o755);
  await put(join(home, ".local", "bin", "hermes-agent"), "#!/bin/sh\nexec " + program + " --run-module run_agent \"$@\"\n", 0o755);
  const launcher = join(home, ".local", "bin", "hermes"), stamped = (fields: Record<string, unknown>) => put(stamp, JSON.stringify({ schemaVersion: 2, commit: "4d04303818b61bf3aa09278af48356315515965b", source: "git", ...fields }));
  // Before its installer finished there is no stamp: the installation counts, its version is unknown.
  assert.deepEqual(await classifier.classify({ path: launcher, resolvedPath: launcher, source: "path", entries: [] }, productChannels("hermes")!),
    { channel: { kind: "script", name: ".hermes/hermes-agent", root, prefix: null }, version: null });
  // The stamp's display version, else its base version; a version it cannot name is unknown.
  await stamped({ baseVersion: "0.22.4", displayVersion: "0.22.4+3.gabc1234" });
  for (const path of [launcher, join(home, ".local", "bin", "hermes-acp"), join(home, ".local", "bin", "hermes-agent"), program]) assert.equal(await read(path), "0.22.4+3.gabc1234", path);
  await stamped({ baseVersion: "0.22.4" }); assert.equal(await read(launcher), "0.22.4");
  await stamped({ baseVersion: "0.22.4", displayVersion: "0.22.4+?" }); assert.equal(await read(launcher), "0.22.4", "a display version that is no version");
  for (const fields of [{ baseVersion: "0.0.0" }, { baseVersion: "unknown", displayVersion: "git.abc1234" }, { baseVersion: "0.0.0", displayVersion: "0.0.0+12.gabc1234" }, { baseVersion: 22 }, {}]) {
    await stamped(fields); assert.equal(await read(launcher), null, JSON.stringify(fields));
  }
  // A venv/ left beside today's program is a former layout's: neither with a stamp nor without one does it give the version.
  await put(join(site, "hermes_agent-0.12.0.dist-info", "METADATA"), "Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.12.0\n");
  await put(join(root, "venv", "bin", "hermes"), "#!/bin/sh\nexit 3\n", 0o755);
  await stamped({ baseVersion: "0.22.4" }); assert.equal(await read(launcher), "0.22.4");
  await rm(stamp); assert.equal(await read(launcher), null);
  for (const text of ["{\"baseVersion\":", "[]", "\"0.22.4\""]) { await put(stamp, text); assert.equal(await read(launcher), null, text); }
  await rm(stamp);
  // 0.12's layout, whose launcher starts venv/bin/hermes and which has no stamp: its distribution's version, unless 0.0.0.
  await rm(join(root, ".hermes"), { recursive: true });
  await put(launcher, "#!/bin/bash\nexec \"" + join(root, "venv", "bin", "hermes") + "\" \"$@\"\n", 0o755);
  assert.equal(await read(launcher), "0.12.0");
  await rm(join(site, "hermes_agent-0.12.0.dist-info"), { recursive: true });
  await put(join(site, "hermes_agent-0.0.0.dist-info", "METADATA"), "Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.0.0\n");
  assert.equal(await read(launcher), null, "0.0.0 is the placeholder of a checkout that keeps its version elsewhere");
  // A 0.12 checkout that an update stamped: the stamp wins over its environment.
  await stamped({ baseVersion: "0.22.4" }); assert.equal(await read(launcher), "0.22.4");
});
