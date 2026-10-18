import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { UnsafeEdit } from "../../src/infrastructure/capabilities/edits.js";
import { editMcp, mcpEntry } from "../../src/infrastructure/capabilities/mcp-edits.js";
import { commandLine, definitionProblem, mcpVariables, ownedOf, readMcp, renderMcp, sameMcp, type McpDefinition } from "../../src/infrastructure/capabilities/mcp-definitions.js";

const DOCS: McpDefinition = { transport: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], cwd: null, url: null,
  env: [{ key: "DOCS_TOKEN", variable: "DOCS_TOKEN" }, { key: "LOG_LEVEL", value: "info" }], headers: [] };
const REMOTE: McpDefinition = { transport: "http", command: null, args: [], cwd: null, url: "https://mcp.example.com/v1", env: [], headers: [{ name: "Authorization", variable: "EXAMPLE_TOKEN", prefix: "Bearer " }] };
/** The lines removed and added between two texts, in order: everything else must be byte for byte the same. */
function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const left = before.split("\n"), right = after.split("\n");
  let start = 0; while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0; while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  return { removed: left.slice(start, left.length - end), added: right.slice(start, right.length - end) };
}

test("G064-M1 a server reads into one definition from every Harness's way of writing it, and back, with each Harness's references", () => {
  const written = {
    claude: { type: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: "${DOCS_TOKEN}", LOG_LEVEL: "info" } },
    cursor: { command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: "${env:DOCS_TOKEN}", LOG_LEVEL: "info" }, disabled: false },
    gemini: { command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: "$DOCS_TOKEN", LOG_LEVEL: "info" }, timeout: 30000 },
    hermes: { command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: "${DOCS_TOKEN}", LOG_LEVEL: "info" } },
    opencode: { type: "local", command: ["npx", "-y", "@acme/docs-mcp"], environment: { DOCS_TOKEN: "{env:DOCS_TOKEN}", LOG_LEVEL: "info" }, enabled: true },
    codex: { command: "npx", args: ["-y", "@acme/docs-mcp"], env: { LOG_LEVEL: "info" }, env_vars: ["DOCS_TOKEN"], startup_timeout_sec: 20 },
  } as const;
  for (const [style, raw] of Object.entries(written) as [keyof typeof written, unknown][]) {
    const read = readMcp(raw, style);
    assert.equal(read.problem, null, style); assert.ok(sameMcp(read.definition!, DOCS), style);
    const rendered = renderMcp(DOCS, style);
    assert.ok(rendered.ok, style);
    // What HarnessHub writes is what the Harness's own entry holds in the keys HarnessHub owns; the rest is the user's.
    assert.ok(sameMcp(readMcp(rendered.value, style).definition!, DOCS), style + " reads back");
  }
  assert.deepEqual(renderMcp(DOCS, "codex"), { ok: true, value: { args: ["-y", "@acme/docs-mcp"], command: "npx", env: { LOG_LEVEL: "info" }, env_vars: ["DOCS_TOKEN"] } });
  assert.deepEqual(renderMcp(REMOTE, "codex"), { ok: true, value: { bearer_token_env_var: "EXAMPLE_TOKEN", url: "https://mcp.example.com/v1" } });
  assert.deepEqual(renderMcp(REMOTE, "gemini"), { ok: true, value: { headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" }, httpUrl: "https://mcp.example.com/v1" } });
  assert.deepEqual(renderMcp(REMOTE, "opencode"), { ok: true, value: { headers: { Authorization: "Bearer {env:EXAMPLE_TOKEN}" }, type: "remote", url: "https://mcp.example.com/v1" } });
  // Cursor's own remote entries carry no transport name; Claude's do.
  assert.deepEqual(renderMcp(REMOTE, "cursor"), { ok: true, value: { headers: { Authorization: "Bearer ${env:EXAMPLE_TOKEN}" }, url: "https://mcp.example.com/v1" } });
  assert.deepEqual(renderMcp(REMOTE, "claude"), { ok: true, value: { headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" }, type: "http", url: "https://mcp.example.com/v1" } });
  assert.deepEqual(mcpVariables(DOCS), ["DOCS_TOKEN"]); assert.equal(commandLine(DOCS), "npx -y @acme/docs-mcp");
  // What a Harness cannot express is refused with the reason, never written another way.
  assert.match((renderMcp({ ...REMOTE, transport: "sse" }, "codex") as { reason: string }).reason, /SSE/u);
  assert.match((renderMcp({ ...REMOTE, transport: "sse" }, "hermes") as { reason: string }).reason, /SSE/u);
  assert.match((renderMcp({ ...DOCS, env: [{ key: "TOKEN", variable: "DOCS_TOKEN" }] }, "codex") as { reason: string }).reason, /同名/u);
  assert.match((renderMcp({ ...REMOTE, headers: [{ name: "X-Key", variable: "EXAMPLE_TOKEN", prefix: "Key " }] }, "codex") as { reason: string }).reason, /前缀/u);
  assert.deepEqual(ownedOf({ command: "x", startup_timeout_sec: 5, tools: { a: { approval_mode: "approve" } } }, "codex"), { command: "x" });
});

test("G064-M1 a credential is never kept as written: literal secrets, lower-case variables, plain HTTP, shell characters and secret arguments are refused", () => {
  const problem = (raw: unknown, style: Parameters<typeof readMcp>[1] = "claude") => readMcp(raw, style).problem;
  assert.match(problem({ command: "npx", env: { API_KEY: "plain-value" } }) ?? "", /API_KEY 的值像是密钥/u);
  assert.match(problem({ command: "npx", env: { HOME_DIR: "sk-abcdefghijklmnop" } }) ?? "", /像是密钥/u);
  assert.equal(problem({ command: "npx", env: { LOG_LEVEL: "debug", NODE_ENV: "production" } }), null, "plain settings may be literal");
  assert.match(problem({ command: "npx", env: { TOKEN: "${lower_case}" } }) ?? "", /大写/u);
  assert.match(problem({ type: "http", url: "http://mcp.example.com" }) ?? "", /HTTPS/u);
  assert.equal(problem({ type: "http", url: "http://127.0.0.1:3000/mcp" }), null, "plain HTTP to this machine is allowed");
  assert.match(problem({ type: "http", url: "https://mcp.example.com/?token=abc" }) ?? "", /查询串/u);
  assert.match(problem({ command: "npx; rm -rf /" }) ?? "", /shell/u);
  assert.match(problem({ command: "npx", args: ["--token", "abc123secret"] }) ?? "", /参数里像是写着密钥/u);
  assert.match(problem({ command: "npx", cwd: "relative/dir" }) ?? "", /绝对路径/u);
  assert.match(problem({ type: "http", url: "https://x.example.com", headers: { "X-Api-Key": "literal" } }) ?? "", /请求头 X-Api-Key 的值像是密钥/u);
  assert.match(problem({ command: "npx", args: "not-a-list" }) ?? "", /字符串列表/u);
  assert.equal(definitionProblem(DOCS), null);
});

const CODEX = "model = \"gpt-5\"            # the model stays\nmodel_reasoning_effort = \"high\"\n\n[[skills.config]]\npath = \"/u/.agents/skills/beta/SKILL.md\"\nenabled = false\n\n"
  + "# MCP servers\n[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"-y\", \"@acme/docs-mcp\"]\nenv_vars = [\"DOCS_TOKEN\"]\nstartup_timeout_sec = 20\n\n[mcp_servers.docs.tools.search]\napproval_mode = \"approve\"\n\n"
  + "[mcp_servers.other]\nurl = \"https://other.example.com/mcp\"\n\n[profiles.fast]\nmodel = \"gpt-5-mini\"\n";
test("G064-M1 Codex's table group is added, changed in its owned keys only and removed, with the model, profiles and other servers byte for byte", () => {
  // Adding a server appends its table; nothing else moves.
  const added = editMcp(CODEX, "codex", "remote", renderMcp(REMOTE, "codex").ok ? (renderMcp(REMOTE, "codex") as { value: Record<string, unknown> }).value : {});
  assert.equal(added, CODEX + "\n[mcp_servers.remote]\nbearer_token_env_var = \"EXAMPLE_TOKEN\"\nurl = \"https://mcp.example.com/v1\"\n");
  // Changing the owned keys of docs keeps the user's timeout and tool approval.
  const changed = editMcp(CODEX, "codex", "docs", { command: "uvx", args: ["docs-mcp"], env_vars: ["DOCS_TOKEN"] });
  const docs = JSON.parse(JSON.stringify(parseToml(changed).mcp_servers)) as Record<string, Record<string, unknown>>;
  assert.deepEqual(docs.docs, { command: "uvx", args: ["docs-mcp"], env_vars: ["DOCS_TOKEN"], startup_timeout_sec: 20, tools: { search: { approval_mode: "approve" } } });
  assert.ok(changed.startsWith("model = \"gpt-5\"            # the model stays\n") && changed.includes("[profiles.fast]\nmodel = \"gpt-5-mini\"\n"));
  // Removing it takes the whole group, its sub-table included, and nothing else.
  const removed = editMcp(CODEX, "codex", "docs", undefined);
  assert.equal(removed, CODEX.replace("[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"-y\", \"@acme/docs-mcp\"]\nenv_vars = [\"DOCS_TOKEN\"]\nstartup_timeout_sec = 20\n\n[mcp_servers.docs.tools.search]\napproval_mode = \"approve\"\n\n", ""));
  assert.equal(mcpEntry(parseToml(removed), "codex", "docs"), undefined);
  // Invalid samples: an owned key spanning lines is not changed in place.
  assert.throws(() => editMcp(CODEX.replace("args = [\"-y\", \"@acme/docs-mcp\"]", "args = [\n  \"-y\",\n  \"@acme/docs-mcp\",\n]"), "codex", "docs", { command: "uvx" }), UnsafeEdit);
});

const HERMES = "# Hermes settings\nmodel:\n  default: deepseek-v4  # chosen\nmcp_servers: {}\nskills:\n  disabled: [beta]\n";
test("G064-M1 Hermes's servers are added to an empty map, changed and removed by whole lines, and the last removal leaves an empty map", () => {
  const value = (renderMcp(DOCS, "hermes") as { value: Record<string, unknown> }).value;
  const one = editMcp(HERMES, "hermes", "docs", value);
  assert.deepEqual(changedLines(HERMES, one), { removed: ["mcp_servers: {}"], added: ["mcp_servers:", "  docs:", "    args:", "      - -y", "      - \"@acme/docs-mcp\"", "    command: npx", "    env:", "      DOCS_TOKEN: ${DOCS_TOKEN}", "      LOG_LEVEL: info"] });
  const two = editMcp(one, "hermes", "remote", (renderMcp(REMOTE, "hermes") as { value: Record<string, unknown> }).value);
  assert.deepEqual(Object.keys((parseYaml(two) as { mcp_servers: object }).mcp_servers), ["docs", "remote"]);
  // A user's own key in the entry stays when the owned keys change.
  const withTimeout = two.replace("    command: npx\n", "    command: npx\n    timeout: 90\n");
  const changed = editMcp(withTimeout, "hermes", "docs", { command: "uvx", args: ["docs-mcp"] });
  assert.deepEqual((parseYaml(changed) as { mcp_servers: Record<string, unknown> }).mcp_servers.docs, { command: "uvx", args: ["docs-mcp"], timeout: 90 });
  const back = editMcp(editMcp(two, "hermes", "remote", undefined), "hermes", "docs", undefined);
  assert.equal(back, HERMES, "removing both brings the file back byte for byte");
  // Invalid sample: a flow-style map with entries is not changed.
  assert.throws(() => editMcp(HERMES.replace("mcp_servers: {}", "mcp_servers: { a: { command: x } }"), "hermes", "docs", value), UnsafeEdit);
});

const CURSOR = "{\n  // the editor shares this file\n  \"mcpServers\": {\n    \"docs\": { \"command\": \"npx\", \"args\": [\"-y\", \"@acme/docs-mcp\"], \"disabled\": true }\n  }\n}\n";
test("G064-M1 a JSON server's owned keys change in place, the user's keys and comments stay, and removal takes only that entry", () => {
  const changed = editMcp(CURSOR, "cursor", "docs", (renderMcp(DOCS, "cursor") as { value: Record<string, unknown> }).value);
  assert.ok(changed.includes("// the editor shares this file") && changed.includes("\"disabled\": true"));
  assert.deepEqual(ownedOf(mcpEntry(JSON.parse(changed.replace(/\/\/.*\n/u, "\n")), "cursor", "docs"), "cursor"), (renderMcp(DOCS, "cursor") as { value: unknown }).value);
  const added = editMcp(CURSOR, "cursor", "remote", (renderMcp(REMOTE, "cursor") as { value: Record<string, unknown> }).value);
  assert.deepEqual(Object.keys(JSON.parse(added.replace(/\/\/.*\n/u, "\n")).mcpServers), ["docs", "remote"]);
  assert.equal(editMcp(added, "cursor", "remote", undefined).replace(/\s+/gu, ""), CURSOR.replace(/\s+/gu, ""));
});

test("G064-M4 Claude's MCP entries are written by its own commands, predicted on a private copy, checked only at the server's entry, and a session's overwrite shows as lost", async t => {
  const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CapabilityChanges } = await import("../../src/infrastructure/capabilities/changes.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-claude-mcp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), file = join(home, ".claude.json");
  await mkdir(join(home, ".claude"), { recursive: true }); await mkdir(join(root, "data"));
  await writeFile(file, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "uvx", args: ["other"] } } }, null, 2));
  const runs: { args: readonly string[]; env: Readonly<Record<string, string>>; writable: readonly string[]; files: readonly string[] }[] = [];
  // Claude Code 2.1.302 as observed: `mcp add-json` and `mcp remove` rewrite its file, and on a fresh start it adds keys of its own.
  const claude = async (args: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly writable: readonly string[]; readonly files: readonly string[] }) => {
    runs.push({ args, ...options });
    const target = options.env.CLAUDE_CONFIG_DIR ? join(options.env.CLAUDE_CONFIG_DIR, ".claude.json") : file;
    const value = JSON.parse(await readFile(target, "utf8")) as { mcpServers?: Record<string, unknown>; migrationVersion?: number };
    value.mcpServers ??= {};
    if (args[1] === "add-json") value.mcpServers[args[2]!] = JSON.parse(args[3]!); else delete value.mcpServers[args[2]!];
    if (options.env.CLAUDE_CONFIG_DIR) value.migrationVersion ??= 11;
    await writeFile(target, JSON.stringify(value, null, 2));
  };
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment: { home, values: { HOME: home } }, homes: [home], processes: async () => "", claude });
  t.after(() => changes.close());
  const installed = [{ harnessId: "claude", name: "Claude Code", version: "2.1.302" }];
  await changes.saveMcpServer("docs", { ...DOCS }, false);
  // The check runs Claude's command on a copy: the real file does not change, and the keys Claude adds itself are listed.
  const check = await changes.checkMcpSync("docs", "claude", false, installed);
  assert.equal(check.blocked, null, JSON.stringify(check));
  assert.match(check.command ?? "", /^claude mcp add-json docs '\{.*\}' -s user$/u);
  assert.deepEqual([check.rewrite?.target, check.rewrite?.before, check.rewrite?.added], ["mcpServers.docs", null, ["migrationVersion"]]);
  assert.ok(check.notes.some(note => note.includes("可能按内存里的副本整份写回")));
  assert.equal(runs[0]!.env.CLAUDE_CONFIG_DIR?.startsWith(root), false, "the copy is in a private folder of its own");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).mcpServers, { other: { type: "stdio", command: "uvx", args: ["other"] } });
  // A running session rewrites another key between the check and the confirmation: only the server's entry must be as checked.
  const before = JSON.parse(await readFile(file, "utf8")); before.numStartups = 4; await writeFile(file, JSON.stringify(before, null, 2));
  const applied = await changes.apply(check.fingerprint, "claude-docs");
  assert.equal(applied.status, "applied", JSON.stringify(applied.error));
  assert.deepEqual([runs[1]!.writable, runs[1]!.files], [[join(home, ".claude", "backups"), join(home, ".claude", "telemetry")], [file]], "the real run may write Claude's file and its own folders only");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).mcpServers.docs, { type: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: "${DOCS_TOKEN}", LOG_LEVEL: "info" } });
  assert.equal(JSON.parse(await readFile(file, "utf8")).numStartups, 4, "the session's own change stays");
  let view = await changes.mcpInventory(installed);
  assert.equal(view.servers[0]!.targets[0]!.state, "synced");
  // Changing it removes and adds, through the same prediction.
  await changes.saveMcpServer("docs", { ...DOCS, args: ["-y", "@acme/docs-mcp", "--fast"] }, true);
  const update = await changes.checkMcpSync("docs", "claude", false, installed);
  assert.match(update.command ?? "", /^claude mcp remove docs -s user；claude mcp add-json docs /u);
  assert.equal((await changes.apply(update.fingerprint, "claude-docs-2")).status, "applied");
  // A session writes its old copy back: the entry is gone, shown as removed, and written again only when asked.
  const lost = JSON.parse(await readFile(file, "utf8")); delete lost.mcpServers.docs; await writeFile(file, JSON.stringify(lost, null, 2));
  view = await changes.mcpInventory(installed);
  assert.equal(view.servers[0]!.targets[0]!.state, "removed");
  assert.deepEqual((await changes.history()).drift.map(item => [item.kind, item.harnessId, item.state]), [["mcp", "claude", "removed"]]);
  assert.match((await changes.checkMcpSync("docs", "claude", false, installed)).blocked ?? "", /重新写入/u);
  const again = await changes.checkMcpSync("docs", "claude", true, installed);
  assert.equal((await changes.apply(again.fingerprint, "claude-docs-3")).status, "applied");
  // The entry changed after a check refuses that check; removal takes HarnessHub's entry only.
  const stale = await changes.checkMcpRemove("docs", "claude", installed);
  const touched = JSON.parse(await readFile(file, "utf8")); touched.mcpServers.docs.args = ["changed"]; await writeFile(file, JSON.stringify(touched, null, 2));
  await assert.rejects(changes.apply(stale.fingerprint, "claude-stale"), (error: unknown) => error instanceof Error && "code" in error && error.code === "CAPABILITY_TARGET_CHANGED");
  touched.mcpServers.docs.args = ["-y", "@acme/docs-mcp", "--fast"]; await writeFile(file, JSON.stringify(touched, null, 2));
  const remove = await changes.checkMcpRemove("docs", "claude", installed);
  assert.equal((await changes.apply(remove.fingerprint, "claude-docs-off")).status, "applied");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8")).mcpServers), ["other"]);
});

const DSH = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n";
test("G064-M6 DeepSeek Harness's MCP rows read and write with !!js references, and its patch list is never left empty or absent once there", async () => {
  const { parseConfig } = await import("../../src/infrastructure/capabilities/formats.js");
  const { setDshPatch, dshRows } = await import("../../src/infrastructure/capabilities/mcp-edits.js");
  const rows = (text: string) => { const value = parseConfig(text, "yaml"); assert.ok(value.ok, text); return dshRows(value.value); };
  // As DeepSeek Harness writes a row: references are `!!js process.env.X`, the working folder `!!js process.cwd()` (its default).
  const read = readMcp({ serverName: "docs", transport: "stdio", command: "npx", args: ["-y", "@acme/docs-mcp"], env: { DOCS_TOKEN: { jsExpression: "process.env.DOCS_TOKEN" }, LOG_LEVEL: "info" }, cwd: { jsExpression: "process.cwd()" } }, "dsh");
  assert.equal(read.problem, null); assert.ok(sameMcp(read.definition!, DOCS));
  assert.deepEqual(renderMcp(DOCS, "dsh"), { ok: true, value: { args: ["-y", "@acme/docs-mcp"], command: "npx", env: { DOCS_TOKEN: { jsExpression: "process.env.DOCS_TOKEN" }, LOG_LEVEL: "info" }, transport: "stdio" } });
  assert.deepEqual(renderMcp(REMOTE, "dsh"), { ok: true, value: { headers: { Authorization: { jsExpression: "'Bearer ' + process.env.EXAMPLE_TOKEN" } }, transport: "streamable-http", url: "https://mcp.example.com/v1" } });
  assert.match((renderMcp({ ...REMOTE, transport: "sse" }, "dsh") as { reason: string }).reason, /SSE/u);
  assert.match(readMcp({ serverName: "x", transport: "stdio", command: "npx", env: { A: { jsExpression: "require('fs')" } } }, "dsh").problem ?? "", /读不了的表达式/u, "an expression HarnessHub cannot read refuses the row");
  // Added to an empty list, the patch is a block list; a second goes after it; each reads back as the same server.
  const docs = (renderMcp(DOCS, "dsh") as { value: Record<string, unknown> }).value, remote = (renderMcp(REMOTE, "dsh") as { value: Record<string, unknown> }).value;
  const one = setDshPatch(DSH, "docs", docs);
  assert.ok(one.startsWith(DSH.replace("[]\n", "- insert:\n    - id: harnesshub-mcp-docs\n")), one);
  assert.ok(one.includes("DOCS_TOKEN: !!js \"process.env.DOCS_TOKEN\""));
  const two = setDshPatch(one, "remote", remote);
  assert.deepEqual(rows(two).map(row => [row.id, row.config.serverName]), [["harnesshub-mcp-docs", "docs"], ["harnesshub-mcp-remote", "remote"]]);
  assert.ok(sameMcp(readMcp(rows(two)[1]!.config, "dsh").definition!, REMOTE), "the header with its prefix reads back");
  // Replaced in place, then removed: the last removal leaves `[]`, byte for byte the file it was.
  const replaced = setDshPatch(two, "docs", { ...docs, args: ["-y", "@acme/docs-mcp", "--fast"] });
  assert.deepEqual(rows(replaced).map(row => row.config.serverName), ["docs", "remote"]);
  assert.equal(setDshPatch(setDshPatch(replaced, "docs", undefined), "remote", undefined), DSH);
  // A file that did not exist is created as a list, and goes back to `[]`, never to an empty file DeepSeek Harness would refuse.
  assert.equal(setDshPatch(setDshPatch("", "docs", docs), "docs", undefined), "[]\n");
  // Invalid samples: a one-line list with patches in it, and a top level that is not a list.
  assert.throws(() => setDshPatch("[{ disable: x }]\n", "docs", docs), UnsafeEdit);
  assert.throws(() => setDshPatch("key: value\n", "docs", docs), UnsafeEdit);
});
