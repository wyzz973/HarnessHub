import assert from "node:assert/strict";
import test from "node:test";
import { classifyProgram } from "../../src/contexts/catalog/domain/channels.js";
import { adapterChannels, productChannels } from "../../src/adapters/catalog-channels.js";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";

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
  assert.deepEqual(channel("hermes", HOME + "/.local/bin/hermes", HOME + "/.local/bin/hermes", path => path === HOME + "/.hermes/hermes-agent/venv/bin/hermes"),
    { kind: "script", name: ".hermes/hermes-agent", root: HOME + "/.hermes/hermes-agent", prefix: null });
  assert.equal(channel("hermes", HOME + "/.local/bin/hermes", HOME + "/.local/bin/hermes", () => false), null, "a launcher without its program is not an installation");
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
  assert.deepEqual(adapterChannels("cursor", cursor.controls.find(control => control.distribution?.kind === "binary")!)?.scripts, [{ root: ".local/share/harnesses/cursor", launchers: [], program: null, removal: null }],
    "HarnessHub's own archive layout is not one it uninstalls");
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
