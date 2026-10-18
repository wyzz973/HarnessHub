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
