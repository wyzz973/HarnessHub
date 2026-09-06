import { readFile, writeFile, mkdir, lstat, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    arch: { type: "string", default: process.arch },
  },
});
if (!["arm64", "x64"].includes(values.arch))
  throw new Error("Unsupported release architecture");
const root = path.resolve(
  values.root ??
    path.join(repo, ".tools/contest-prepared", `win32-${values.arch}`),
);
const npm = "${bundle}/engines/npm/node_modules/";
const node = "${node}";
const winTriple =
  values.arch === "arm64"
    ? "aarch64-pc-windows-msvc"
    : "x86_64-pc-windows-msvc";
const npmRoot = path.join(root, "engines/npm/node_modules");
const packageInfo = async (name) =>
  JSON.parse(await readFile(path.join(npmRoot, name, "package.json"), "utf8"));
const engines = [],
  components = [];
async function add(id, name, packageName, entry, args, env = {}, extras = {}) {
  const info = await packageInfo(packageName);
  const command = entry.endsWith(".exe")
    ? [npm + entry, ...args]
    : [node, npm + entry, ...args];
  const requiredFiles = [`engines/npm/node_modules/${entry}`];
  engines.push({
    id,
    name,
    version: info.version,
    driver: "acp",
    command,
    env,
    configuration: { adapter: id },
    requiredFiles,
    ...extras,
  });
  components.push({
    id: packageName,
    version: info.version,
    license: info.license ?? "See packaged LICENSE/README",
    source: `https://registry.npmjs.org/${packageName}/${info.version}`,
  });
}
await add(
  "codex",
  "Codex",
  "@openai/codex",
  "@agentclientprotocol/codex-acp/dist/index.js",
  [],
  {
    CODEX_HOME: "${home}/.codex",
    CODEX_PATH:
      npm +
      `@openai/codex-win32-${values.arch}/vendor/${winTriple}/bin/codex.exe`,
    INITIAL_AGENT_MODE: "read-only",
  },
);
engines
  .at(-1)
  .requiredFiles.push(
    `engines/npm/node_modules/@openai/codex-win32-${values.arch}/vendor/${winTriple}/bin/codex.exe`,
  );
await add(
  "claude",
  "Claude Code",
  "@anthropic-ai/claude-code",
  "@agentclientprotocol/claude-agent-acp/dist/index.js",
  [],
  {
    CLAUDE_CODE_EXECUTABLE:
      npm + `@anthropic-ai/claude-code-win32-${values.arch}/claude.exe`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_GIT_BASH_PATH: "${bundle}/bin/git/usr/bin/bash.exe",
    DISABLE_AUTOUPDATER: "1",
  },
);
engines
  .at(-1)
  .requiredFiles.push(
    `engines/npm/node_modules/@anthropic-ai/claude-code-win32-${values.arch}/claude.exe`,
  );
await add(
  "gemini",
  "Gemini CLI",
  "@google/gemini-cli",
  "@google/gemini-cli/bundle/gemini.js",
  ["--acp"],
  { GEMINI_CLI_DISABLE_AUTO_UPDATE: "true" },
);
await add(
  "qwen",
  "Qwen Code",
  "@qwen-code/qwen-code",
  "@qwen-code/qwen-code/cli-entry.js",
  ["--acp", "--experimental-skills"],
  { QWEN_DISABLE_AUTO_UPDATE: "1" },
);
await add(
  "copilot",
  "GitHub Copilot CLI",
  "@github/copilot",
  `@github/copilot-win32-${values.arch}/copilot.exe`,
  ["--acp"],
  { COPILOT_OFFLINE: "true" },
);
await add(
  "qoder",
  "Qoder CLI",
  "@qoder-ai/qodercli",
  "@qoder-ai/qodercli/bundle/qodercli.js",
  ["--acp"],
);
await add(
  "mimo",
  "MiMo Code",
  "@mimo-ai/cli",
  `@mimo-ai/mimocode-windows-${values.arch}/bin/mimo.exe`,
  ["acp"],
  { MIMOCODE_DISABLE_AUTOUPDATE: "true" },
);
await add(
  "dsh",
  "DeepSeek Harness",
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh/lib/bin.js",
  ["--profile", "acp"],
  { DSH_HOME: "${home}/.dsh", DSH_TELEMETRY_DISABLED: "1" },
);
await add(
  "pi",
  "Pi",
  "@earendil-works/pi-coding-agent",
  "pi-acp/dist/index.js",
  [],
  {
    PI_ACP_PI_COMMAND: "${bundle}/bin/pi.cmd",
    PI_CODING_AGENT_DIR: "${home}/.pi/agent",
    PI_SKIP_VERSION_CHECK: "1",
  },
  {
    notes: [
      "Pi ACP does not forward session MCP servers; use local extensions or a Skill tool bridge.",
    ],
  },
);
await add(
  "openclaw",
  "OpenClaw",
  "openclaw",
  "openclaw/openclaw.mjs",
  ["acp"],
  {
    OPENCLAW_STATE_DIR: "${home}/.openclaw",
    OPENCLAW_CONFIG_PATH: "${home}/.openclaw/openclaw.json",
    OPENCLAW_NO_BANNER: "1",
  },
  {
    notes: [
      "OpenClaw ACP requires its private Gateway; session MCP servers use native Gateway plugins instead.",
    ],
  },
);
engines.at(-1).command = [
  node,
  "${bundle}/scripts/launch-openclaw-bundled.mjs",
  npm + "openclaw/openclaw.mjs",
];
engines.at(-1).requiredFiles.push("scripts/launch-openclaw-bundled.mjs");
engines.at(-1).acp = { initializeTimeoutMs: 60000 };
for (const receipt of JSON.parse(
  await readFile(path.join(root, "binary-receipts.json"), "utf8"),
)) {
  const env =
    receipt.id === "opencode" ? { OPENCODE_DISABLE_AUTOUPDATE: "true" } : {};
  engines.push({
    id: receipt.id,
    name: receipt.name,
    version: receipt.version,
    driver: "acp",
    command: receipt.command,
    env,
    configuration: { adapter: receipt.id },
    requiredFiles: [receipt.command[0].replace("${bundle}/", "")],
  });
  components.push({
    id: receipt.id,
    version: receipt.version,
    source: receipt.source,
    license: receipt.license,
    sha256: receipt.sha256,
  });
  if (receipt.id === "kimi") {
    const item = engines.at(-1);
    item.driver = "cli";
    item.command = [receipt.command[0], "--quiet", "--prompt", "{prompt}"];
    item.cli = { inputMode: "argv", maxOutputBytes: 1048576 };
    item.configuration.env = { KIMI_MODEL_MAX_CONTEXT_SIZE: "1048576" };
    item.notes = [
      "Uses the official noninteractive CLI; ACP 1.50.0 requires vendor OAuth even with a custom provider.",
    ];
  }
  if (receipt.id === "antigravity") {
    engines.at(-1).acp = { initializeTimeoutMs: 60000 };
    engines
      .at(-1)
      .requiredFiles.push("engines/antigravity/localharness_external.exe");
  }
}
for (const extra of [
  {
    id: "hermes",
    name: "Hermes Agent",
    version: "0.19.0",
    command: [
      "${bundle}/engines/hermes/runtime/python.exe",
      "-I",
      "-B",
      "-m",
      "acp_adapter",
    ],
    env: {
      HERMES_HOME: "${home}/.hermes",
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      HERMES_GIT_BASH_PATH: "${bundle}/bin/git/usr/bin/bash.exe",
    },
    required: "engines/hermes/runtime/python.exe",
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    version: "2.21.1",
    command: ["${bundle}/engines/kiro/kiro-cli.exe", "acp"],
    env: {},
    required: "engines/kiro/kiro-cli.exe",
  },
]) {
  if (!(await lstat(path.join(root, extra.required))).isFile())
    throw new Error(`Required extra engine is not prepared: ${extra.id}`);
  engines.push({
    id: extra.id,
    name: extra.name,
    version: extra.version,
    driver: "acp",
    command: extra.command,
    env: extra.env,
    configuration: { adapter: extra.id },
    requiredFiles: [extra.required],
    notes:
      values.arch === "arm64"
        ? [
            "This component uses bundled x64 code under Windows 11 ARM64 emulation.",
          ]
        : [],
  });
}
await mkdir(path.join(root, "bin"), { recursive: true });
await writeFile(
  path.join(root, "bin/pi.cmd"),
  '@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\engines\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n',
);
// Upstream pi-acp 0.0.33 starts .cmd with shell:true, which loses quoted Windows paths.
// Pin this narrow source change; copyTree ships its unchanged license and this receipt.
const piEntry = path.join(npmRoot, "pi-acp/dist/index.js");
let piSource = await readFile(piEntry, "utf8");
const oldImport = 'import { spawn } from "child_process";';
const newImport = 'import spawn from "cross-spawn";';
if (piSource.includes(oldImport))
  piSource = piSource
    .replace(oldImport, newImport)
    .replace(
      "      shell: shouldUseShellForPiCommand(cmd)\n",
      "      windowsHide: true\n",
    );
else if (!piSource.includes(newImport))
  throw new Error("Pinned pi-acp Windows patch no longer matches");
const piTemporary = `${piEntry}.${randomUUID()}.tmp`;
await writeFile(piTemporary, piSource, { flag: "wx" });
await rename(piTemporary, piEntry);
components.push({
  id: "pi-acp-windows-launch-patch",
  version: "1",
  source: "scripts/prepare-engine-catalog.mjs",
  license: "MIT",
});
components.push({
  id: "portable-git",
  version: "2.55.0.windows.5",
  source: `https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5`,
  license: "GPL-2.0 and bundled component licenses",
});
for (const name of [
  "@agentclientprotocol/codex-acp",
  "@agentclientprotocol/claude-agent-acp",
  "pi-acp",
]) {
  const info = await packageInfo(name);
  components.push({
    id: name,
    version: info.version,
    license: info.license ?? "See packaged LICENSE",
    source: `https://registry.npmjs.org/${name}/${info.version}`,
  });
}
const extraSources = JSON.parse(
  await readFile(
    path.join(repo, "distribution/extra-engine-sources.json"),
    "utf8",
  ),
);
for (const [id, artifact] of Object.entries(extraSources.artifacts))
  components.push({ id, ...artifact });
components.push({
  id: "hermes",
  version: extraSources.hermes.version,
  license: extraSources.hermes.license,
  wheels: extraSources.hermes.wheels,
});
engines
  .find((item) => item.id === "pi")
  .requiredFiles.push(
    "engines/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "bin/pi.cmd",
  );
engines.find((item) => item.id === "dsh").acp = { initializeTimeoutMs: 60000 };
for (const engine of engines)
  for (const file of engine.requiredFiles)
    await lstat(path.join(file.startsWith("scripts/") ? repo : root, file));
await writeFile(
  path.join(root, "prepared.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      platform: "win32",
      arch: values.arch,
      nodeVersion: "24.20.0",
      engines: engines.sort((a, b) => a.id.localeCompare(b.id)),
      components,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Prepared ${engines.length} engine registrations with bundle-relative templates.`,
);
