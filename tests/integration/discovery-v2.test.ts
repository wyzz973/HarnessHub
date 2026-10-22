import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { PackageIdentity } from "../../src/contexts/catalog/domain/catalog.js";
import { DiscoveryInputError } from "../../src/contexts/catalog/domain/discovery.js";
import { discoverSearchDirectories, MAX_MANAGER_CHILDREN, MAX_SEARCH_DIRECTORIES } from "../../src/infrastructure/discovery/search.js";
import { LocalInstallationEnumerator } from "../../src/infrastructure/discovery/installation-enumerator.js";
import { LocalInstalledPackageResolver } from "../../src/infrastructure/discovery/packages.js";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-inventory-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function executable(path: string, content = "#!/bin/sh\nexit 99\n"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o700);
}
async function packageAt(root: string, name = "@example/agent", version = "1.0.0", bin: unknown = { agent: "dist/cli.js" }): Promise<string> {
  const directory = join(root, "node_modules", name);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, bin }));
  await writeFile(join(directory, "dist/cli.js"), "process.exit(99);\n");
  return directory;
}
const identity: PackageIdentity = { kind: "npm", name: "@example/agent", version: "1.0.0", binNames: ["agent"] };

test("v2 search preserves PATH, explicit directories and static bins without cwd injection", async (t) => {
  const home = await fixture(t);
  const report = await discoverSearchDirectories({ path: "/first:/second::./relative:/first", home, extra: ["/second", "/third"], pathOnly: false, environment: {} });
  assert.deepEqual(report.directories.slice(0, 3).map((entry) => entry.path), ["/first", "/second", "/third"]);
  assert.equal(report.directories[0]?.source, "path");
  assert.equal(report.directories[2]?.source, "configured-directory");
  assert.ok(report.directories.some((entry) => entry.path === join(home, "Library/pnpm")));
  assert.ok(report.directories.some((entry) => entry.path === join(home, ".volta/bin")));
  assert.ok(report.diagnostics.some((entry) => entry.code === "relative_path_ignored"));
  await assert.rejects(() => discoverSearchDirectories({ path: "", home, extra: ["../relative"], pathOnly: true, environment: {} }), DiscoveryInputError);
});

test("path-only does not inspect manager roots or access supplemental environment", async (t) => {
  const home = await fixture(t);
  await mkdir(join(home, ".nvm/versions/node/v1/bin"), { recursive: true });
  const environment = new Proxy({}, { get: () => { throw new Error("environment accessed"); } });
  const report = await discoverSearchDirectories({ path: "/only", home, extra: [], pathOnly: true, environment });
  assert.deepEqual(report.directories, [{ path: "/only", source: "path" }]);
  assert.deepEqual(report.diagnostics, []);
});

test("nvm fnm mise Volta and pnpm custom roots are read without modifying global environment", async (t) => {
  const home = await fixture(t), custom = join(home, "custom roots");
  const environment = { NVM_DIR: join(custom, "nvm"), FNM_DIR: join(custom, "fnm"), MISE_DATA_DIR: join(custom, "mise"), VOLTA_HOME: join(custom, "volta"), PNPM_HOME: join(custom, "pnpm") };
  for (const path of [join(environment.NVM_DIR, "versions/node/v22/bin"), join(environment.FNM_DIR, "node-versions/v24/installation/bin"), join(environment.MISE_DATA_DIR, "installs/node/25/bin")]) await mkdir(path, { recursive: true });
  const environmentDigest = (): string => createHash("sha256").update(JSON.stringify(Object.entries(process.env).sort())).digest("hex");
  const before = environmentDigest();
  const report = await discoverSearchDirectories({ path: "", home, extra: [], pathOnly: false, environment });
  for (const path of [join(environment.NVM_DIR, "versions/node/v22/bin"), join(environment.FNM_DIR, "node-versions/v24/installation/bin"), join(environment.MISE_DATA_DIR, "installs/node/25/bin"), join(environment.VOLTA_HOME, "bin"), environment.PNPM_HOME])
    assert.ok(report.directories.some((entry) => entry.path === path && entry.source === "manager-directory"), path);
  assert.equal(environmentDigest(), before, "global environment was modified");
});

test("manager roots enumerate only one known version layer and skip directory links", async (t) => {
  const home = await fixture(t), versions = join(home, ".nvm/versions/node");
  await mkdir(join(versions, "v1/bin"), { recursive: true });
  await mkdir(join(versions, "v1/deeper/v2/bin"), { recursive: true });
  await mkdir(join(home, "elsewhere/bin"), { recursive: true });
  await symlink(join(home, "elsewhere"), join(versions, "linked-version"));
  await mkdir(join(home, "Library/Application Support/fnm/node-versions/v3/installation/bin"), { recursive: true });
  await mkdir(join(home, ".local/state/fnm_multishells/session/bin"), { recursive: true });
  const report = await discoverSearchDirectories({ path: "", home, extra: [], pathOnly: false, environment: {} });
  assert.ok(report.directories.some((entry) => entry.path === join(versions, "v1/bin")));
  assert.ok(report.directories.some((entry) => entry.path === join(home, "Library/Application Support/fnm/node-versions/v3/installation/bin")));
  assert.ok(report.directories.some((entry) => entry.path === join(home, ".local/state/fnm_multishells/session/bin")));
  assert.ok(!report.directories.some((entry) => entry.path.includes("linked-version") || entry.path.includes("deeper")));
});

test("manager child and total search limits report partial inventories", async (t) => {
  const home = await fixture(t), versions = join(home, ".nvm/versions/node");
  for (let index = 0; index < MAX_MANAGER_CHILDREN + 1; index++) await mkdir(join(versions, "v" + index, "bin"), { recursive: true });
  const managers = await discoverSearchDirectories({ path: "", home, extra: [], pathOnly: false, environment: {} });
  assert.equal(managers.directories.filter((entry) => entry.path.startsWith(versions)).length, MAX_MANAGER_CHILDREN);
  assert.ok(managers.diagnostics.some((entry) => entry.code === "scan_truncated" && entry.path === versions));
  const path = Array.from({ length: MAX_SEARCH_DIRECTORIES + 1 }, (_, index) => join(home, "p" + index)).join(":");
  const total = await discoverSearchDirectories({ path, home, extra: [], pathOnly: true, environment: {} });
  assert.equal(total.directories.length, MAX_SEARCH_DIRECTORIES);
  assert.ok(total.diagnostics.some((entry) => entry.code === "scan_truncated"));
});

test("invalid supplemental roots are diagnosed and do not replace known roots", async (t) => {
  const home = await fixture(t);
  const report = await discoverSearchDirectories({ path: "", home, extra: [], pathOnly: false, environment: { NVM_DIR: "relative", PNPM_HOME: "x\0y" } });
  assert.equal(report.diagnostics.filter((entry) => entry.code === "relative_path_ignored").length, 2);
  assert.ok(report.directories.some((entry) => entry.path === join(home, "Library/pnpm")));
});

test("reviewed product installation variables contribute bounded directories only", async (t) => {
  const home = await fixture(t);
  const environment = { OPENCODE_INSTALL_DIR: join(home, "opencode-custom"), XDG_BIN_DIR: join(home, "xdg-bin"), GROK_BIN_DIR: join(home, "grok-custom"), MCODE_INSTALL_DIR: join(home, "mcode-custom"), GOPATH: join(home, "go-one") + ":" + join(home, "go-two"), SECRET_HOME: "ignored" };
  const report = await discoverSearchDirectories({ path: "", home, extra: [], pathOnly: false, environment });
  for (const path of [environment.OPENCODE_INSTALL_DIR, environment.XDG_BIN_DIR, environment.GROK_BIN_DIR, join(environment.MCODE_INSTALL_DIR, "bin"), join(home, "go-one/bin"), join(home, "go-two/bin")])
    assert.ok(report.directories.some((entry) => entry.path === path), path);
  assert.ok(report.directories.some((entry) => entry.path === join(home, ".minimax-code/bin")));
  assert.ok(!JSON.stringify(report).includes("SECRET_HOME"));
});

test("root cardinality and PATH input limits are enforced independently of directory deduplication", async (t) => {
  const home = await fixture(t);
  const truncated = await discoverSearchDirectories({ path: Array(513).fill("/same").join(":"), home, extra: [], pathOnly: true, environment: {} });
  assert.equal(truncated.directories.length, 1);
  assert.ok(truncated.diagnostics.some((entry) => entry.code === "scan_truncated" && entry.path === "PATH"));
  await assert.rejects(() => discoverSearchDirectories({ path: "x".repeat(512 * 1024 + 1), home, extra: [], pathOnly: true, environment: {} }), DiscoveryInputError);
  await assert.rejects(() => discoverSearchDirectories({ path: "", home, extra: Array(MAX_SEARCH_DIRECTORIES + 1).fill("/same"), pathOnly: true, environment: {} }), DiscoveryInputError);
});

test("v2 canonical deduplication preserves every alias/source entry and the PATH default", async (t) => {
  const root = await fixture(t), first = join(root, "first"), second = join(root, "second");
  await executable(join(second, "agent"));
  await mkdir(first);
  await symlink(join(second, "agent"), join(first, "agent"));
  await symlink(join(second, "agent"), join(first, "agent-alias"));
  const report = await new LocalInstallationEnumerator([{ path: first, source: "path" }, { path: second, source: "known-directory" }]).enumerate(["agent", "agent-alias"]);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.entries.length, 3);
  assert.equal(report.selected?.path, join(first, "agent"));
  assert.equal(report.selected?.resolvedPath, await realpath(join(second, "agent")));
  assert.equal(report.defaultResolution, "located");
});

test("v2 blocked PATH default preserves healthy alternate installations without selecting them", async (t) => {
  const root = await fixture(t), first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await executable(join(second, "agent"));
  await symlink(join(root, "missing-target"), join(first, "agent"));
  const report = await new LocalInstallationEnumerator([{ path: first, source: "path" }, { path: second, source: "known-directory" }]).enumerate(["agent"]);
  assert.equal(report.defaultResolution, "blocked");
  assert.equal(report.selected, null);
  assert.equal(report.candidates.length, 1);
  assert.ok(report.diagnostics.some((entry) => entry.path === join(first, "agent") && entry.code === "not_found"));
});

test("nonexecutable files and folders block default and unknown names remain missing", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "plain"), "plain"); await chmod(join(root, "plain"), 0o600);
  await mkdir(join(root, "folder"));
  const resolver = new LocalInstallationEnumerator([{ path: root, source: "path" }]);
  assert.equal((await resolver.enumerate(["plain"])).diagnostics[0]?.code, "not_executable");
  assert.equal((await resolver.enumerate(["folder"])).diagnostics[0]?.code, "not_file");
  const missing = await resolver.enumerate(["missing"]);
  assert.equal(missing.defaultResolution, "none"); assert.equal(missing.selected, null);
  assert.equal(missing.diagnostics[0]?.code, "not_found");
});

test("explicit v2 executable overrides are exclusive and never fall back", async (t) => {
  const root = await fixture(t);
  await executable(join(root, "agent"));
  const resolver = new LocalInstallationEnumerator([{ path: root, source: "path" }]);
  const missing = await resolver.enumerate(["agent"], join(root, "missing"));
  assert.equal(missing.defaultResolution, "blocked"); assert.equal(missing.candidates.length, 0); assert.equal(missing.selected, null);
  await assert.rejects(() => resolver.enumerate(["agent"], "relative"), DiscoveryInputError);
  await assert.rejects(() => resolver.enumerate(["../agent"]), DiscoveryInputError);
  await assert.rejects(() => resolver.enumerate(["agent", "agent"]), DiscoveryInputError);
});

test("definitions without reviewed binary names remain empty until an explicit entry is supplied", async (t) => {
  const root = await fixture(t); await executable(join(root, "custom-agent"));
  const resolver = new LocalInstallationEnumerator([{ path: root, source: "path" }]);
  const empty = await resolver.enumerate([]);
  assert.deepEqual(empty, { candidates: [], selected: null, defaultResolution: "none", diagnostics: [] });
  const explicit = await resolver.enumerate([], join(root, "custom-agent"));
  assert.equal(explicit.selected?.entries[0]?.name, "custom-agent");
  assert.equal(explicit.defaultResolution, "located");
});

test("an install absent from PATH can be selected and a fresh scan observes changes", async (t) => {
  const root = await fixture(t);
  const resolver = new LocalInstallationEnumerator([{ path: root, source: "known-directory" }]);
  assert.equal((await resolver.enumerate(["agent"])).selected, null);
  await executable(join(root, "agent"));
  const found = await resolver.enumerate(["agent"]);
  assert.equal(found.selected?.path, join(root, "agent")); assert.equal(found.defaultResolution, "none");
  await rm(join(root, "agent"));
  assert.equal((await resolver.enumerate(["agent"])).selected, null);
});

test("v2 scan and local npm resolution never execute a candidate, package runner or package bin", async (t) => {
  const root = await fixture(t), sentinel = join(root, "launched");
  const content = "#!/bin/sh\nprintf launched > '" + sentinel + "'\n";
  for (const name of ["node", "npx", "uvx", "agent"]) await executable(join(root, "bin", name), content);
  const directory = await packageAt(root);
  await writeFile(join(directory, "dist/cli.js"), "require('node:fs').writeFileSync(" + JSON.stringify(sentinel) + ", 'launched');");
  const enumerator = new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]);
  assert.equal((await enumerator.enumerate(["agent"])).candidates.length, 1);
  const report = await new LocalInstalledPackageResolver([root], enumerator).resolve(identity);
  assert.equal(report.command?.executable, join(root, "bin/node"));
  assert.equal(report.command?.args[0], await realpath(join(directory, "dist/cli.js")));
  await assert.rejects(() => readFile(sentinel), { code: "ENOENT" });
});

test("npm resolution accepts actual installed version differences while reporting observed version", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node")); await packageAt(root, identity.name, "0.9.0");
  const report = await new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }])).resolve(identity);
  assert.ok(report.command); assert.equal(report.packageVersion, "0.9.0");
  assert.ok(report.diagnostics.some((entry) => entry.code === "package_version_observed" && entry.detail?.includes("catalog-reference=1.0.0")));
});

test("a copy left in npm's npx cache is never an installation, as in comparable products", async (t) => {
  const home = await fixture(t), bin = join(home, "bin");
  await executable(join(bin, "node"));
  // `npx @deepseek-ai/dsh web`, the README's way to run it, leaves the package here without a `dsh` command.
  await packageAt(join(home, ".npm", "_npx", "0123456789abcdef"), "@deepseek-ai/dsh", "0.2.1-alpha.2", { dsh: "dist/cli.js" });
  const { inventory } = await import("../../src/infrastructure/catalog/inventory-composition.js");
  const observed = await inventory({ home, environment: { PATH: bin }, searchDirs: [], packageRoots: [], pathOnly: false, installations: "official" });
  const control = observed.report.harnesses.find(harness => harness.id === "dsh")?.controls[0];
  assert.ok(control);
  // A dsh installed on this host may still be found in a standard directory; the npx cache never supplies one.
  assert.ok(![control.command?.executable ?? "", ...(control.command?.args ?? [])].some(part => part.includes("_npx")));
  if (control.installation.selected === null) assert.equal(control.state, "missing_dependency");
});

test("an installed package reports its own version from metadata behind the found entry, and nothing runs", async (t) => {
  const root = await fixture(t), sentinel = join(root, "launched"), bin = join(root, "bin");
  await executable(join(bin, "node"), "#!/bin/sh\nprintf launched > '" + sentinel + "'\n");
  const resolver = new LocalInstalledPackageResolver([], new LocalInstallationEnumerator([{ path: bin, source: "path" }]));
  // npm -g: the global bin is a link to the package's declared bin.
  const directory = await packageAt(join(root, "global"), identity.name, "1.4.2");
  await symlink(join(directory, "dist/cli.js"), join(bin, "agent"));
  const npm = await resolver.observe(identity, join(bin, "agent"));
  assert.ok(npm.some(entry => entry.code === "package_version_observed" && entry.detail?.startsWith("installed=1.4.2; catalog-reference=1.0.0; installed package metadata")));
  // A file that is not one of the package's bins, or a package with another name, establishes nothing.
  await writeFile(join(directory, "dist/other.js"), "process.exit(99);\n");
  assert.deepEqual(await resolver.observe(identity, join(directory, "dist/other.js")), []);
  assert.deepEqual(await resolver.observe({ ...identity, name: "@example/other" }, join(bin, "agent")), []);
  // Python: a console script names its environment's interpreter; an installer's launcher execs that script once.
  const venv = join(root, "home", ".tool", "venv"), python: PackageIdentity = { kind: "python", name: "hermes-agent", version: "0.12.0", binNames: ["hermes"] };
  await mkdir(join(venv, "bin"), { recursive: true }); await writeFile(join(venv, "pyvenv.cfg"), "version_info = 3.11.5\n");
  await executable(join(venv, "bin", "python3"), "#!/bin/sh\nprintf launched > '" + sentinel + "'\n");
  await executable(join(venv, "bin", "hermes"), "#!" + join(venv, "bin", "python3") + "\nimport sys\n");
  await mkdir(join(venv, "lib", "python3.11", "site-packages", "hermes_agent-0.12.0.dist-info"), { recursive: true });
  await writeFile(join(venv, "lib", "python3.11", "site-packages", "hermes_agent-0.12.0.dist-info", "METADATA"), "Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.12.0\n");
  await executable(join(bin, "hermes"), "#!/usr/bin/env bash\nunset PYTHONPATH\nexec \"" + join(venv, "bin", "hermes") + "\" \"$@\"\n");
  for (const entry of [join(venv, "bin", "hermes"), join(bin, "hermes")])
    assert.ok((await resolver.observe(python, entry)).some(row => row.code === "package_version_observed" && row.detail?.startsWith("installed=0.12.0;")));
  // Only one launcher hop is followed, and an environment without pyvenv.cfg is not a virtual environment.
  await executable(join(bin, "twice"), "#!/bin/sh\nexec \"" + join(bin, "hermes") + "\" \"$@\"\n");
  assert.deepEqual(await resolver.observe(python, join(bin, "twice")), []);
  await rm(join(venv, "pyvenv.cfg"));
  assert.deepEqual(await resolver.observe(python, join(venv, "bin", "hermes")), []);
  await assert.rejects(() => readFile(sentinel), { code: "ENOENT" });
});

test("a package manager without the target package is not an installation", async (t) => {
  const root = await fixture(t);
  await executable(join(root, "bin/node")); await executable(join(root, "bin/npx")); await executable(join(root, "bin/uvx"));
  const report = await new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }])).resolve(identity);
  assert.equal(report.command, null); assert.ok(report.diagnostics.some((entry) => entry.code === "not_found"));
});

test("missing or blocked Node prevents package selection even with a healthy alternate Node", async (t) => {
  const root = await fixture(t); await packageAt(root);
  const missing = await new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([])).resolve(identity);
  assert.equal(missing.command, null); assert.ok(missing.diagnostics.some((entry) => entry.code === "runtime_missing"));
  await mkdir(join(root, "bad")); await symlink(join(root, "gone"), join(root, "bad/node")); await executable(join(root, "good/node"));
  const blocked = await new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bad"), source: "path" }, { path: join(root, "good"), source: "known-directory" }])).resolve(identity);
  assert.equal(blocked.command, null); assert.ok(blocked.diagnostics.some((entry) => entry.code === "runtime_missing" && entry.detail?.includes("blocked")));
});

test("npm package name mismatch and missing requested bin are rejected", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node"));
  const directory = await packageAt(root);
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@other/agent", version: "1.0.0", bin: { agent: "dist/cli.js" } }));
  assert.equal((await resolver.resolve(identity)).command, null);
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: identity.name, version: "1.0.0", bin: { other: "dist/cli.js" } }));
  const missing = await resolver.resolve(identity);
  assert.equal(missing.command, null); assert.ok(missing.diagnostics.some((entry) => entry.code === "package_invalid"));
});

test("npm resolver selects a unique undeclared bin but rejects ambiguity", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node"));
  const directory = await packageAt(root);
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]));
  assert.ok((await resolver.resolve({ ...identity, binNames: [] })).command);
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: identity.name, version: "1.0.0", bin: { agent: "dist/cli.js", another: "dist/cli.js" } }));
  const ambiguous = await resolver.resolve({ ...identity, binNames: [] });
  assert.equal(ambiguous.command, null); assert.ok(ambiguous.diagnostics.some((entry) => entry.code === "package_invalid"));
});

test("direct package-root layout and string bin metadata are supported without package managers", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node"));
  const directory = await packageAt(root, identity.name, "1.0.0", "dist/cli.js");
  await mkdir(join(root, "@example"));
  await rename(directory, join(root, identity.name));
  const report = await new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }])).resolve(identity);
  assert.equal(report.command?.args[0], await realpath(join(root, identity.name, "dist/cli.js")));
});

test("a local npm bin must be a readable ordinary file", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node")); const directory = await packageAt(root);
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]));
  const bin = join(directory, "dist/cli.js"); await rm(bin); await mkdir(bin);
  const report = await resolver.resolve(identity);
  assert.equal(report.command, null); assert.ok(report.diagnostics.some((entry) => entry.code === "package_invalid"));
});

test("package bin traversal and symlink escape cannot produce commands", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node"));
  const directory = await packageAt(root); await writeFile(join(root, "outside.js"), "process.exit(99)");
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]));
  for (const bin of ["../../outside.js", join(root, "outside.js"), "dist/link.js"]) {
    if (bin === "dist/link.js") await symlink(join(root, "outside.js"), join(directory, bin));
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: identity.name, version: "1.0.0", bin: { agent: bin } }));
    const report = await resolver.resolve(identity);
    assert.equal(report.command, null); assert.ok(report.diagnostics.some((entry) => entry.code === "package_invalid"));
  }
});

test("package directory and package.json links outside declared roots are rejected", async (t) => {
  const root = await fixture(t), outside = await fixture(t); await executable(join(root, "bin/node"));
  const packageDirectory = await packageAt(outside);
  await mkdir(join(root, "node_modules/@example"), { recursive: true });
  await symlink(packageDirectory, join(root, "node_modules/@example/agent"));
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]));
  assert.equal((await resolver.resolve(identity)).command, null);
  await rm(join(root, "node_modules/@example/agent"));
  const local = await packageAt(root); await rm(join(local, "package.json")); await symlink(join(packageDirectory, "package.json"), join(local, "package.json"));
  const linked = await resolver.resolve(identity);
  assert.equal(linked.command, null); assert.ok(linked.diagnostics.some((entry) => entry.code === "package_invalid"));
});

test("npm metadata reads are bounded, regular and valid UTF-8 JSON", async (t) => {
  const root = await fixture(t); await executable(join(root, "bin/node")); const directory = await packageAt(root);
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: join(root, "bin"), source: "path" }]));
  const manifest = join(directory, "package.json");
  for (const bytes of [Buffer.from([0xff]), Buffer.from("broken"), Buffer.alloc(64 * 1024 + 1, " ")]) {
    await writeFile(manifest, bytes);
    const report = await resolver.resolve(identity);
    assert.equal(report.command, null); assert.ok(report.diagnostics.some((entry) => entry.code === "package_invalid"));
  }
  await rm(manifest); await mkdir(manifest);
  assert.equal((await resolver.resolve(identity)).command, null);
});

test("Python executable names or uvx alone never imply verified package identity", async (t) => {
  const root = await fixture(t); await executable(join(root, "python-agent")); await executable(join(root, "uvx"));
  const resolver = new LocalInstalledPackageResolver([root], new LocalInstallationEnumerator([{ path: root, source: "path" }]));
  const report = await resolver.resolve({ kind: "python", name: "python-agent", version: "1.0.0", binNames: ["python-agent"] });
  assert.equal(report.command, null); assert.ok(report.diagnostics.some((entry) => entry.code === "package_invalid" && entry.detail?.includes("identity/version")));
});

test("a Python distribution at the 0.0.0 placeholder names its package but no installed version, so none is reported", async (t) => {
  const root = await fixture(t), bin = join(root, "bin"), venv = join(root, "home", ".tool", "venv"), site = join(venv, "lib", "python3.12", "site-packages");
  const resolver = new LocalInstalledPackageResolver([], new LocalInstallationEnumerator([{ path: bin, source: "path" }]));
  const python: PackageIdentity = { kind: "python", name: "hermes-agent", version: "latest", binNames: ["hermes"] };
  await mkdir(join(venv, "bin"), { recursive: true }); await writeFile(join(venv, "pyvenv.cfg"), "version_info = 3.12.4\n");
  await executable(join(venv, "bin", "python3")); await executable(join(venv, "bin", "hermes"), "#!" + join(venv, "bin", "python3") + "\nimport sys\n");
  // Hermes's pyproject is always 0.0.0; the version it really is lives in its checkout's install stamp.
  for (const version of ["0.0.0", "0.0.0+12.gabc1234"]) {
    await rm(site, { recursive: true, force: true }); await mkdir(join(site, "hermes_agent-" + version + ".dist-info"), { recursive: true });
    await writeFile(join(site, "hermes_agent-" + version + ".dist-info", "METADATA"), "Metadata-Version: 2.4\nName: hermes-agent\nVersion: " + version + "\n");
    assert.deepEqual(await resolver.observe(python, join(venv, "bin", "hermes")), [], version);
  }
  // A real version in the same place is reported, against the catalog's reference.
  await rm(site, { recursive: true }); await mkdir(join(site, "hermes_agent-0.12.0.dist-info"), { recursive: true });
  await writeFile(join(site, "hermes_agent-0.12.0.dist-info", "METADATA"), "Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.12.0\n");
  assert.ok((await resolver.observe(python, join(venv, "bin", "hermes"))).some(row => row.code === "package_version_observed" && row.detail?.startsWith("installed=0.12.0; catalog-reference=latest;")));
});
