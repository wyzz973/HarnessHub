import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { ManagementError } from "../../src/contracts/management.js";
import { blockedWrites, codexProfile, downloadScript, keyChanges, lineChanges } from "../../src/infrastructure/management/official-install.js";
import { officialInstallMethod } from "../../src/adapters/catalog-channels.js";
import { parseManagementInput } from "../../src/contexts/management/domain/input.js";
import { parseInstallRequest } from "../../src/contexts/management/domain/state.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof ManagementError && error.code === expected;
/** A fetch that serves fixed responses by URL, recording every request; nothing leaves this process. */
function served(routes: Readonly<Record<string, () => Response>>) {
  const asked: string[] = [];
  const fetcher = (async (input: URL | RequestInfo) => { const url = String(input); asked.push(url); const route = routes[url]; return route ? route() : new Response("missing", { status: 404 }); }) as typeof fetch;
  return { fetcher, asked };
}
const SCRIPT = "#!/bin/bash\necho installing\n";

test("G011-IN1 an install script is downloaded only over HTTPS through its recorded hosts, bounded, and only when it is a script", async t => {
  const directory = await mkdtemp(join(tmpdir(), "official-download-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
  const ok = served({ "https://claude.ai/install.sh": redirect("https://downloads.claude.ai/claude-code-releases/bootstrap.sh"), "https://downloads.claude.ai/claude-code-releases/bootstrap.sh": () => new Response(SCRIPT) });
  const result = await downloadScript("https://claude.ai/install.sh", ["claude.ai", "downloads.claude.ai"], join(directory, "a.sh"), AbortSignal.timeout(5000), ok.fetcher);
  assert.deepEqual(result, { finalUrl: "https://downloads.claude.ai/claude-code-releases/bootstrap.sh", sha256: createHash("sha256").update(SCRIPT).digest("hex") });
  assert.equal(await readFile(join(directory, "a.sh"), "utf8"), SCRIPT);
  // Refused, saving nothing: a redirect to a host not recorded, a plain-HTTP or credentialed URL, an oversized body, an error page.
  const elsewhere = served({ "https://claude.ai/install.sh": redirect("https://evil.example/install.sh") });
  await assert.rejects(downloadScript("https://claude.ai/install.sh", ["claude.ai"], join(directory, "b.sh"), AbortSignal.timeout(5000), elsewhere.fetcher), code("INSTALL_SOURCE_REFUSED"));
  assert.deepEqual(elsewhere.asked, ["https://claude.ai/install.sh"], "the unrecorded host is never asked");
  await assert.rejects(downloadScript("http://claude.ai/install.sh", ["claude.ai"], join(directory, "c.sh"), AbortSignal.timeout(5000), ok.fetcher), code("INSTALL_SOURCE_REFUSED"));
  await assert.rejects(downloadScript("https://user:pw@claude.ai/install.sh", ["claude.ai"], join(directory, "d.sh"), AbortSignal.timeout(5000), ok.fetcher), code("INSTALL_SOURCE_REFUSED"));
  const big = served({ "https://cursor.com/install": () => new Response("#!/bin/bash\n" + "x".repeat(1024 * 1024)) });
  await assert.rejects(downloadScript("https://cursor.com/install", ["cursor.com"], join(directory, "e.sh"), AbortSignal.timeout(5000), big.fetcher), code("DOWNLOAD_LIMIT"));
  const page = served({ "https://cursor.com/install": () => new Response("<!doctype html><title>blocked</title>") });
  await assert.rejects(downloadScript("https://cursor.com/install", ["cursor.com"], join(directory, "f.sh"), AbortSignal.timeout(5000), page.fetcher), code("INSTALL_SOURCE_REFUSED"));
  await assert.rejects(downloadScript("https://cursor.com/missing", ["cursor.com"], join(directory, "g.sh"), AbortSignal.timeout(5000), page.fetcher), code("DOWNLOAD_FAILED"));
  for (const name of ["b.sh", "c.sh", "d.sh", "e.sh", "f.sh", "g.sh"]) await assert.rejects(readFile(join(directory, name)), name);
});

test("G011-IN2 what an installer changed is recorded as lines of the one startup file it may change and as key paths of a product configuration", () => {
  assert.equal(codexProfile("/Users/me", "/bin/zsh"), "/Users/me/.zprofile");
  assert.equal(codexProfile("/Users/me", "/bin/bash"), "/Users/me/.bash_profile");
  assert.equal(codexProfile("/Users/me", "/opt/homebrew/bin/fish"), "/Users/me/.profile");
  assert.deepEqual(lineChanges("export A=1\n", "export A=1\n\n# >>> Codex installer >>>\nexport PATH=\"/Users/me/.local/bin:$PATH\"\n# <<< Codex installer <<<\n"),
    { added: ["# >>> Codex installer >>>", "export PATH=\"/Users/me/.local/bin:$PATH\"", "# <<< Codex installer <<<"], removed: [] });
  assert.deepEqual(lineChanges(null, null), { added: [], removed: [] });
  // A known install field shows its value; any other changed key is named only, since the file may hold account details.
  assert.deepEqual(keyChanges(JSON.stringify({ numStartups: 3, oauthAccount: { email: "a@b" } }), JSON.stringify({ numStartups: 3, installMethod: "native", oauthAccount: { email: "c@d" } })),
    [{ path: "installMethod", value: "\"native\"" }, { path: "oauthAccount.email", value: null }]);
  assert.deepEqual(keyChanges("{not json", "{}"), [{ path: "(整个文件)", value: null }]);
  assert.deepEqual(keyChanges(null, "{\"autoUpdates\":true}"), [{ path: "autoUpdates", value: "true" }]);
  assert.deepEqual(blockedWrites("mkdir: /Users/me/.zshrc.d: Operation not permitted\ncp: /Users/me/Library/x: Permission denied\nok\n"), ["/Users/me/.zshrc.d", "/Users/me/Library/x"]);
  assert.deepEqual(blockedWrites("/data/install-jobs/j/install.bash: line 8: /Users/me/.zshrc: Operation not permitted\n"), ["/Users/me/.zshrc"], "the script's own path is not the denied one");
});

test("G011-IN3 every product has one official install method; scripts are fetched from their own hosts and write only plain home paths", () => {
  for (const id of ["claude", "codex", "opencode", "cursor"]) {
    const method = officialInstallMethod(id); assert.equal(method?.kind, "script", id); if (method?.kind !== "script") continue;
    assert.ok(method.hosts.includes(new URL(method.url).hostname), id); assert.ok(method.command.includes(method.url), id);
    for (const path of [...method.writes, ...method.configFiles, method.installs.path]) assert.match(path, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u, id + ": " + path);
    assert.ok(method.writes.some(path => method.installs.path.startsWith(path + "/")), id + " installs inside what it may write");
  }
  for (const id of ["openclaw", "gemini", "pi", "dsh"]) assert.equal(officialInstallMethod(id)?.kind, "npm", id);
  assert.equal(officialInstallMethod("hermes")?.kind, "terminal");
  assert.equal(officialInstallMethod("amp"), null);
});

test("G011-IN4 an official install request names only the confirmed check, and a frozen install request is checked field by field", () => {
  const fingerprint = "c".repeat(64);
  assert.deepEqual(parseManagementInput({ harnessId: "dsh", action: "install", commandId: "i-1", expectedInstallFingerprint: fingerprint }), { harnessId: "dsh", action: "install", commandId: "i-1", expectedInstallFingerprint: fingerprint });
  for (const input of [{ harnessId: "dsh", action: "upgrade", commandId: "i", expectedInstallFingerprint: fingerprint }, { harnessId: "dsh", action: "install", commandId: "i", expectedInstallFingerprint: "/tmp/x" },
    { harnessId: "dsh", action: "install", commandId: "i", expectedInstallFingerprint: fingerprint, controlId: "dsh-native" }, { harnessId: "dsh", action: "install", commandId: "i", expectedInstallFingerprint: fingerprint, expectedDefaultRevision: 0 }])
    assert.throws(() => parseManagementInput(input), code("INVALID_INPUT"), JSON.stringify(input));
  const npm = { harnessId: "dsh", method: "npm", source: "@deepseek-ai/dsh@0.2.0", sha256: null, script: null, interpreter: null, args: [], env: {}, writes: ["/opt/prefix"], shellProfile: null, configFiles: [],
    package: "@deepseek-ai/dsh", version: "0.2.0", prefix: "/opt/prefix", npm: "/opt/prefix/bin/npm", entry: "/opt/prefix/bin/dsh", command: "dsh", runtime: null, fingerprint };
  assert.equal(parseInstallRequest(npm).version, "0.2.0");
  const script = { ...npm, method: "script", source: "https://cursor.com/install", sha256: "d".repeat(64), script: "/data/install-jobs/x/install.bash", interpreter: "bash", package: null, version: null, prefix: null, npm: null, writes: ["/Users/me/.local/bin"] };
  assert.equal(parseInstallRequest(script).interpreter, "bash");
  for (const invalid of [{ ...npm, prefix: null }, { ...script, sha256: null }, { ...script, script: "relative/install.bash" }, { ...npm, env: { "bad-name": "x" } }, { ...npm, writes: ["relative"] }, { ...script, interpreter: "zsh" }])
    assert.throws(() => parseInstallRequest(invalid), code("INVALID_DATA"), JSON.stringify(invalid));
});
