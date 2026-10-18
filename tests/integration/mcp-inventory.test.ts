import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { CapabilityChangeCheck, CapabilityChangeView, CapabilityHistory, McpInventoryView } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

const macOnly = { skip: process.platform !== "darwin" && "capability changes run their Harness commands under macOS's sandbox (ADR-045)", timeout: 120000 };
/** A Gateway on a private home with the official installations' fixture files, through its formal entry. */
async function gateway(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-inventory-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere"));
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":"), LINEAR_TOKEN: "set-but-never-shown" } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { nativeEnvironment: environment, installations: "official", management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const answers: unknown[] = [];
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as T; answers.push(value);
    return { status: response.status, value };
  };
  const inventory = async () => (await call<McpInventoryView>("/capabilities/mcp")).value;
  const sync = (name: string, harnessId: string, overwrite = false) => call<CapabilityChangeCheck>("/capabilities/mcp/sync?" + new URLSearchParams({ name, harnessId, ...(overwrite ? { overwrite: "true" } : {}) }));
  const apply = (fingerprint: string, commandId: string) => call<CapabilityChangeView>("/capabilities/changes", { fingerprint, commandId });
  const clean = async () => {
    const text = JSON.stringify(answers);
    for (const secret of [...CREDENTIALS, "set-but-never-shown"]) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
    assert.deepEqual((await readdir(home)).filter(name => name.startsWith("ran-")), []);
  };
  return { root, home, call, inventory, sync, apply, clean };
}
const state = (view: McpInventoryView, name: string, harnessId: string) => view.servers.find(server => server.name === name)?.targets.find(target => target.harnessId === harnessId)?.state;

test("G064-M2 through the formal Gateway, a server the Harnesses have is listed and claimed, written into others their own way, brought up to date and removed, each shown first", macOnly, async t => {
  const f = await gateway(t), codexFile = join(f.home, ".codex", "config.toml"), geminiFile = join(f.home, ".gemini", "settings.json");
  const cursorFile = join(f.home, ".cursor", "mcp.json"), cursorConfig = JSON.parse(await readFile(cursorFile, "utf8")) as { mcpServers: Record<string, unknown> };
  cursorConfig.mcpServers["@scope/odd"] = { command: "npx", args: ["-y", "@scope/odd"] };
  await writeFile(cursorFile, JSON.stringify(cursorConfig));
  // DeepSeek Harness's profile patch layers as it creates them, one holding a memory server of the user's.
  const header = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n";
  await mkdir(join(f.home, ".dsh", "profiles", "acp"), { recursive: true }); await mkdir(join(f.home, ".dsh", "profiles", "web"), { recursive: true });
  await writeFile(join(f.home, ".dsh", "profiles", "acp", "cordis.patch.yml"), header + "[]\n");
  await writeFile(join(f.home, ".dsh", "profiles", "web", "cordis.patch.yml"), header + "- insert:\n    - id: memory-mine\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: dsh-mem\n"
    + "        transport: stdio\n        command: memorix\n        args: [serve]\n        env: {}\n        cwd: !!js process.cwd()\n");
  const codexBefore = await readFile(codexFile, "utf8");
  // What the Harnesses have: the servers that can be listed, and those that cannot (credentials written literally, a token in the address).
  let view = await f.inventory();
  assert.deepEqual(view.servers, []);
  const candidate = (name: string) => view.candidates.find(item => item.name === name);
  assert.deepEqual(candidate("fs")?.foundIn, [{ harnessId: "hermes", file: "~/.hermes/config.yaml" }]);
  assert.deepEqual(candidate("fs")?.definition, { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], cwd: null, url: null, env: [{ key: "FS_TOKEN", variable: "FS_TOKEN" }], headers: [] });
  assert.match(candidate("github")?.problem ?? "", /API_KEY 的值像是密钥/u);
  assert.match(candidate("docs")?.problem ?? "", /参数里像是写着密钥/u);
  assert.match(candidate("@scope/odd")?.problem ?? "", /服务器名只能用字母/u, "a name HarnessHub cannot write is listed with why");
  assert.ok(view.candidates.filter(item => item.name === "remote").every(item => /查询串/u.test(item.problem ?? "")));
  const writable = Object.fromEntries(view.harnesses.map(item => [item.harnessId, item.writable]));
  assert.deepEqual(["claude", "codex", "cursor", "gemini", "hermes", "opencode", "dsh", "openclaw"].map(id => writable[id]), [true, true, true, true, true, true, true, false]);
  assert.deepEqual([candidate("dsh-mem")?.foundIn, candidate("dsh-mem")?.definition?.command, candidate("dsh-mem")?.definition?.cwd], [[{ harnessId: "dsh", file: "~/.dsh/profiles/web/cordis.patch.yml" }], "memorix", null]);
  assert.match(view.harnesses.find(item => item.harnessId === "openclaw")?.reason ?? "", /重启 Gateway/u);
  // Listing fs and claiming Hermes's identical entry changes no file.
  const hermesFile = join(f.home, ".hermes", "config.yaml"), hermesBefore = await readFile(hermesFile, "utf8");
  const imported = await f.call<CapabilityChangeView[]>("/capabilities/mcp/import", { candidate: candidate("fs")!.id, claim: ["hermes"] });
  assert.equal(imported.status, 200, JSON.stringify(imported.value));
  assert.deepEqual(imported.value.map(change => [change.kind, change.harnessId, change.subject, change.diff]), [["mcp-claim", "hermes", "fs", null]]);
  assert.equal(await readFile(hermesFile, "utf8"), hermesBefore, "claiming writes nothing");
  view = await f.inventory();
  assert.deepEqual([state(view, "fs", "hermes"), state(view, "fs", "codex"), state(view, "fs", "claude"), state(view, "fs", "openclaw")], ["synced", "absent", "absent", "unsupported"]);
  // Claude's own command predicts the write on a copy: the fixture's program fails, so nothing is prepared and nothing ran outside the sandbox.
  const claudeFile = join(f.home, ".claude.json"), claudeBefore = await readFile(claudeFile, "utf8");
  const toClaude = await f.sync("fs", "claude");
  assert.match(toClaude.value.blocked ?? "", /Claude 的预演没有通过/u);
  assert.match(toClaude.value.command ?? "", /^claude mcp add-json fs '\{.*\}' -s user$/u);
  assert.equal(await readFile(claudeFile, "utf8"), claudeBefore);
  assert.deepEqual(view.servers[0]?.variables, [{ name: "FS_TOKEN", set: false }]);
  // Written into Codex its own way: a table of its own, the variable forwarded by name, every other byte as it was.
  const toCodex = await f.sync("fs", "codex");
  assert.equal(toCodex.value.blocked, null, JSON.stringify(toCodex.value));
  assert.ok(toCodex.value.notes.some(note => note === "目标 Harness 会以你的身份运行这个程序：npx -y @modelcontextprotocol/server-filesystem"));
  assert.ok(toCodex.value.notes.some(note => note.includes("FS_TOKEN（HarnessHub 的环境里未设置）")) && toCodex.value.notes.some(note => note.includes("Codex 要重启")));
  assert.equal((await f.apply(toCodex.value.fingerprint, "fs-codex")).value.status, "applied");
  assert.equal(await readFile(codexFile, "utf8"), codexBefore + "\n[mcp_servers.fs]\nargs = [\"-y\", \"@modelcontextprotocol/server-filesystem\"]\ncommand = \"npx\"\nenv_vars = [\"FS_TOKEN\"]\n");
  // Into Gemini and Cursor, with their own references; Cursor says the editor shares the file.
  const toGemini = await f.sync("fs", "gemini");
  assert.equal((await f.apply(toGemini.value.fingerprint, "fs-gemini")).value.status, "applied");
  const gemini = JSON.parse(await readFile(geminiFile, "utf8")) as { mcpServers: Record<string, unknown>; model: unknown };
  assert.deepEqual(gemini.mcpServers.fs, { args: ["-y", "@modelcontextprotocol/server-filesystem"], command: "npx", env: { FS_TOKEN: "${FS_TOKEN}" } });
  assert.deepEqual(gemini.model, { name: "model-key-value" }, "the model stays");
  const toCursor = await f.sync("fs", "cursor");
  assert.ok(toCursor.value.notes.some(note => note.includes("Cursor 编辑器也使用这个文件")));
  assert.equal((await f.apply(toCursor.value.fingerprint, "fs-cursor")).value.status, "applied");
  view = await f.inventory();
  assert.deepEqual(["hermes", "codex", "gemini", "cursor"].map(id => state(view, "fs", id)), ["synced", "synced", "synced", "synced"]);
  // The list changes: every Harness HarnessHub wrote is behind, and an update changes only the owned keys (the user's timeout stays).
  await writeFile(codexFile, (await readFile(codexFile, "utf8")).replace("env_vars = [\"FS_TOKEN\"]\n", "env_vars = [\"FS_TOKEN\"]\nstartup_timeout_sec = 30\n"));
  const definition = { ...view.servers[0]!.definition, args: ["-y", "@modelcontextprotocol/server-filesystem", "~/projects"] };
  assert.equal((await f.call("/capabilities/mcp/servers", { name: "fs", definition, replace: true })).status, 200);
  view = await f.inventory();
  assert.deepEqual(["hermes", "codex", "gemini", "cursor"].map(id => state(view, "fs", id)), ["outdated", "outdated", "outdated", "outdated"]);
  assert.deepEqual(view.servers[0]!.definition.args, ["-y", "@modelcontextprotocol/server-filesystem", "~/projects"], "the home is shown as ~");
  const update = await f.sync("fs", "codex");
  assert.equal(update.value.current, "harnesshub");
  assert.equal((await f.apply(update.value.fingerprint, "fs-codex-2")).value.status, "applied");
  const codex = JSON.parse(JSON.stringify(parseToml(await readFile(codexFile, "utf8")))) as { mcp_servers: Record<string, Record<string, unknown>>; model: string };
  assert.deepEqual(codex.mcp_servers.fs, { args: ["-y", "@modelcontextprotocol/server-filesystem", join(f.home, "projects")], command: "npx", env_vars: ["FS_TOKEN"], startup_timeout_sec: 30 });
  assert.equal(codex.model, "model-key-value");
  const hermesUpdate = await f.sync("fs", "hermes");
  assert.equal((await f.apply(hermesUpdate.value.fingerprint, "fs-hermes")).value.status, "applied");
  assert.deepEqual((parseYaml(await readFile(hermesFile, "utf8")) as { mcp_servers: Record<string, { args: string[] }> }).mcp_servers.fs!.args.at(-1), join(f.home, "projects"));
  // Into DeepSeek Harness: its patch layer for every profile is created holding HarnessHub's own insert, and goes back to `[]`.
  const toDsh = await f.sync("fs", "dsh"), dshFile = join(f.home, ".dsh", "cordis.patch.yml");
  assert.equal(toDsh.value.blocked, null, JSON.stringify(toDsh.value));
  assert.ok(toDsh.value.notes.some(note => note.includes("~/.dsh/cordis.patch.yml")));
  assert.equal((await f.apply(toDsh.value.fingerprint, "fs-dsh")).value.status, "applied");
  const patch = await readFile(dshFile, "utf8");
  assert.ok(patch.startsWith("- insert:\n    - id: harnesshub-mcp-fs\n      name: \"@deepseek-ai/dsh-mcp-client\"\n") && patch.includes("FS_TOKEN: !!js \"process.env.FS_TOKEN\""), patch);
  assert.equal(state(await f.inventory(), "fs", "dsh"), "synced");
  const offDsh = await f.call<CapabilityChangeCheck>("/capabilities/mcp/remove?" + new URLSearchParams({ name: "fs", harnessId: "dsh" }));
  assert.equal((await f.apply(offDsh.value.fingerprint, "fs-dsh-off")).value.status, "applied");
  assert.equal(await readFile(dshFile, "utf8"), "[]\n", "never an empty file DeepSeek Harness would refuse to start with");
  // Removing it from Cursor takes only HarnessHub's entry; the linear server there stays.
  const remove = await f.call<CapabilityChangeCheck>("/capabilities/mcp/remove?" + new URLSearchParams({ name: "fs", harnessId: "cursor" }));
  assert.equal(remove.value.blocked, null, JSON.stringify(remove.value));
  assert.equal((await f.apply(remove.value.fingerprint, "fs-cursor-off")).value.status, "applied");
  assert.deepEqual(Object.keys((JSON.parse(await readFile(join(f.home, ".cursor", "mcp.json"), "utf8")) as { mcpServers: object }).mcpServers), ["linear", "@scope/odd"]);
  // The list entry cannot go while Harnesses still have HarnessHub's entries.
  const tooSoon = await f.call<{ code: string; message: string }>("/capabilities/mcp/servers/delete", { name: "fs" });
  assert.deepEqual([tooSoon.status, tooSoon.value.code], [409, "CAPABILITY_TARGET_REFUSED"]);
  assert.match(tooSoon.value.message, /先从 .*移除/u);
  await f.clean();
});

test("G064-M3 an entry someone else changed is left alone until the user writes it again, a same-named server of the user's is never overwritten, and what a Harness cannot express is refused", macOnly, async t => {
  const f = await gateway(t);
  let view = await f.inventory();
  const fs = view.candidates.find(item => item.name === "fs")!;
  await f.call("/capabilities/mcp/import", { candidate: fs.id, claim: [] });
  const toGemini = await f.sync("fs", "gemini");
  assert.equal((await f.apply(toGemini.value.fingerprint, "fs-gemini")).value.status, "applied");
  // Hermes has its own fs, not claimed and now different: never overwritten.
  const geminiFile = join(f.home, ".gemini", "settings.json"), hermesFile = join(f.home, ".hermes", "config.yaml");
  await writeFile(hermesFile, (await readFile(hermesFile, "utf8")).replace("@modelcontextprotocol/server-filesystem", "@other/filesystem"));
  view = await f.inventory();
  assert.equal(state(view, "fs", "hermes"), "different");
  assert.match((await f.sync("fs", "hermes", true)).value.blocked ?? "", /定义不同；HarnessHub 不覆盖/u);
  // Someone changes the entry HarnessHub wrote in Gemini: it is the user's now, shown in the drift list, written again only when asked.
  const settings = JSON.parse(await readFile(geminiFile, "utf8")) as { mcpServers: Record<string, { args: string[] }> };
  settings.mcpServers.fs!.args = ["-y", "changed-by-hand"];
  await writeFile(geminiFile, JSON.stringify(settings));
  view = await f.inventory();
  assert.equal(state(view, "fs", "gemini"), "changed");
  const history = (await f.call<CapabilityHistory>("/capabilities/history")).value;
  assert.deepEqual(history.drift.map(item => [item.kind, item.harnessId, item.subject, item.state]), [["mcp", "gemini", "fs", "changed"]]);
  assert.deepEqual(history.orphans, [], "an MCP entry is not an orphaned skill switch");
  assert.match((await f.sync("fs", "gemini")).value.blocked ?? "", /现在归你.*重新写入/u);
  const again = await f.call<CapabilityChangeCheck>("/capabilities/drift/" + history.drift[0]!.id + "/reapply");
  assert.equal(again.value.blocked, null, JSON.stringify(again.value));
  assert.ok(again.value.notes.some(note => note.includes("会覆盖外部对这一项的改动")));
  assert.equal((await f.apply(again.value.fingerprint, "fs-gemini-again")).value.status, "applied");
  assert.equal(state(await f.inventory(), "fs", "gemini"), "synced");
  // A server whose argument holds the home in its middle is listed as read (absolute), and shown with ~.
  const withRoot = JSON.parse(await readFile(geminiFile, "utf8")) as { mcpServers: Record<string, unknown> };
  withRoot.mcpServers.rooted = { command: "uvx", args: ["rooted-mcp", "--root=" + join(f.home, "work")], env: { DATA_DIR: join(f.home, "data") } };
  await writeFile(geminiFile, JSON.stringify(withRoot));
  const rooted = (await f.inventory()).candidates.find(item => item.name === "rooted")!;
  assert.deepEqual([rooted.definition?.args, rooted.definition?.env], [["rooted-mcp", "--root=~/work"], [{ key: "DATA_DIR", value: "~/data" }]]);
  assert.equal((await f.call("/capabilities/mcp/import", { candidate: rooted.id, claim: ["gemini"] })).status, 200);
  assert.equal(state(await f.inventory(), "rooted", "gemini"), "synced", "the claim matched the absolute argument as written");
  // Gemini's SSE server is listed, but Codex and Hermes cannot take SSE: refused with the reason, nothing written.
  const legacy = (await f.inventory()).candidates.find(item => item.name === "legacy")!;
  await f.call("/capabilities/mcp/import", { candidate: legacy.id, claim: ["gemini"] });
  view = await f.inventory();
  assert.deepEqual([state(view, "legacy", "codex"), state(view, "legacy", "hermes")], ["unsupported", "unsupported"]);
  assert.match(view.servers.find(server => server.name === "legacy")!.targets.find(target => target.harnessId === "codex")!.reason ?? "", /SSE/u);
  assert.match((await f.sync("legacy", "codex")).value.blocked ?? "", /SSE/u);
  // Invalid samples refused before anything is kept: a literal credential, plain HTTP elsewhere, shell characters, a renamed variable for Codex.
  const save = (definition: object) => f.call<{ code: string; message: string }>("/capabilities/mcp/servers", { name: "bad", definition });
  assert.match((await save({ transport: "stdio", command: "npx", args: [], env: [{ key: "API_KEY", value: "plain-but-secret-name" }] })).value.message, /API_KEY 的值像是密钥/u);
  assert.match((await save({ transport: "http", url: "http://mcp.example.com/" })).value.message, /HTTPS/u);
  assert.match((await save({ transport: "stdio", command: "npx && curl evil", args: [] })).value.message, /shell/u);
  assert.match((await save({ transport: "stdio", command: "npx", args: ["--dir=~/x"] })).value.message, /只在开头展开/u);
  assert.equal((await save({ transport: "stdio", command: "npx", args: ["renamed"], env: [{ key: "TOKEN", variable: "MY_TOKEN" }] })).status, 200);
  assert.match((await f.sync("bad", "codex")).value.blocked ?? "", /同名的环境变量/u);
  assert.equal((await f.call("/capabilities/mcp/servers/delete", { name: "bad" })).status, 200);
  // A name the list allows but DeepSeek Harness's client does not (more than 32 characters): refused there only.
  const long = "docs-" + "x".repeat(30);
  assert.equal((await f.call("/capabilities/mcp/servers", { name: long, definition: { transport: "http", url: "https://mcp.example.com/" } })).status, 200);
  view = await f.inventory();
  assert.deepEqual([state(view, long, "dsh"), state(view, long, "codex")], ["unsupported", "absent"]);
  assert.match((await f.sync(long, "dsh")).value.blocked ?? "", /最多 32 个字符/u);
  assert.equal((await f.call("/capabilities/mcp/servers/delete", { name: long })).status, 200);
  // The documented downgrade to v2: the list, the MCP history and the MCP ledger entries go; every other record stays.
  const copy = join(f.root, "downgrade.sqlite");
  await writeFile(copy, await readFile(join(f.root, "data", "capabilities", "capabilities.sqlite")));
  const db = new DatabaseSync(copy);
  try {
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM capability_ledger WHERE key LIKE 'mcp/%'").get()?.n as number) > 0);
    db.exec(await readFile(new URL("../../../tools/capabilities-v3-to-v2.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ["capability_backups", "capability_changes", "capability_ledger", "capability_owner", "skill_sources", "skill_undo"]);
    assert.deepEqual([db.prepare("SELECT COUNT(*) AS n FROM capability_ledger WHERE key LIKE 'mcp/%'").get()?.n, db.prepare("SELECT COUNT(*) AS n FROM capability_changes WHERE json_extract(view_json, '$.kind') LIKE 'mcp-%'").get()?.n], [0, 0]);
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM capability_backups").get()?.n as number) > 0, "the backups stay");
  } finally { db.close(); }
  await f.clean();
});
