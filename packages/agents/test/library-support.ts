// SPDX-License-Identifier: MIT
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { LibraryStore } from "../src/library/store.js";
import {
  applyLibrarySync,
  planLibrarySync,
  type LibrarySources,
  type LibrarySyncOptions,
  type ConfirmedLibraryPlan,
} from "../src/library/sync.js";
import { libraryAgents, type LibraryAgent } from "../src/library/types.js";
import { sandbox } from "./wiring-support.js";

export const ALL: LibraryAgent[] = [...libraryAgents];
/** The agents with a user-wide instructions file. */
export const WITH_INSTRUCTIONS: LibraryAgent[] = ALL.filter(
  (agent) => agent !== "kimi" && agent !== "hermes",
);

/** Synthetic secret values: `synthetic-<variable>`; none is a real credential. */
export function syntheticSecret(name: string): string {
  return `synthetic-${name.toLowerCase()}`;
}

/** The secrets and references of the Library as the daemon would pass them, overridable. */
export function librarySources(
  store: LibraryStore,
  overrides: Partial<LibrarySources> = {},
): LibrarySources {
  return {
    instructionText: (id) => store.instructionText(id),
    skillDirectory: (sha256, name) => store.skillDirectory(sha256, name),
    skillsRoot: path.join(store.directory, "skills"),
    resolve: (ref) => Promise.resolve(syntheticSecret(ref.value)),
    forbiddenValue: () => Promise.resolve(false),
    forbiddenRef: () => Promise.resolve(undefined),
    ...overrides,
  };
}

/** Writes a skill directory `<parent>/<name>` with SKILL.md and an executable script. */
export async function writeSkill(
  parent: string,
  name: string,
  description: string,
  body = "Use scripts/run.sh.",
): Promise<string> {
  const directory = path.join(parent, name);
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
  const script = path.join(directory, "scripts", "run.sh");
  await writeFile(script, "#!/bin/sh\necho run\n");
  await chmod(script, 0o755);
  return directory;
}

/** A private home, data directory and Library, with plan and apply bound to them. */
export async function librarySandbox(t: TestContext) {
  const context = await sandbox(t);
  const store = new LibraryStore(context.dataDir, context.clock);
  const sources = librarySources(store);
  return {
    context,
    store,
    sources,
    plan: async (
      options: LibrarySyncOptions = {},
      io: LibrarySources = sources,
    ) =>
      planLibrarySync(
        await store.index(),
        await store.applied(),
        io,
        context,
        options,
      ),
    apply: async (
      options: LibrarySyncOptions & { expect?: ConfirmedLibraryPlan } = {},
      io: LibrarySources = sources,
    ) =>
      applyLibrarySync(
        await store.index(),
        await store.applied(),
        io,
        context,
        {
          ...options,
          persist: (state) => store.saveApplied(state),
        },
      ),
  };
}

/**
 * The items of the golden runs: one instruction set for every agent with an
 * instructions file, MCP servers of each transport with and without secrets,
 * and one skill.
 */
export async function addFixtureItems(
  store: LibraryStore,
  root: string,
  agents: readonly LibraryAgent[] = ALL,
): Promise<void> {
  await store.putInstructionSet("team", {
    name: "Team rules",
    text: "# Team rules\n\nRun the tests before you commit.\n",
    agents: agents.filter((agent) => WITH_INSTRUCTIONS.includes(agent)),
  });
  const now = { agents: [...agents] };
  await store.putMcpServer({
    name: "files",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv"],
    env: { LOG_LEVEL: "info" },
    ...now,
  });
  await store.putMcpServer({
    name: "github",
    transport: "stdio",
    command: "github-mcp",
    args: ["stdio"],
    secretEnv: { GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" } },
    ...now,
  });
  await store.putMcpServer({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/docs",
    headers: { "X-Client": "hh" },
    ...now,
  });
  await store.putMcpServer({
    name: "search",
    transport: "http",
    url: "https://mcp.example.test/search",
    secretHeaders: { Authorization: { kind: "env", value: "SEARCH_AUTH" } },
    ...now,
  });
  await store.putMcpServer({
    name: "events",
    transport: "sse",
    url: "https://mcp.example.test/events",
    ...now,
  });
  const source = await writeSkill(
    path.join(root, "skill-source"),
    "pdf-tools",
    "Work with PDF files.",
  );
  await store.importSkill(source, [...agents]);
}

/**
 * Every file and link under `home`, by path relative to it with `/`: a
 * file's text, a link as `-> <target>` with the data directory written as
 * `<data>` and a stored version as `<version>`.
 */
export async function tree(
  home: string,
  dataDir: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(home, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    const key = path.relative(home, file).split(path.sep).join("/");
    if (entry.isSymbolicLink())
      result[key] = `-> ${(await readlink(file))
        .split(dataDir)
        .join("<data>")
        .split(path.sep)
        .join("/")
        .replace(/[0-9a-f]{64}/, "<version>")}`;
    else if (entry.isFile()) result[key] = await readFile(file, "utf8");
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** User configuration each agent already has: comments, other keys, a server of the user's. */
export const EXISTING_LIBRARY: Readonly<
  Record<LibraryAgent, Readonly<Record<string, string>>>
> = {
  claude: {
    ".claude/CLAUDE.md": "# My notes\n\nPrefer small diffs.\n",
    ".claude.json": `{
  "numStartups": 4,
  "mcpServers": {
    "mine": { "command": "my-mcp" }
  }
}
`,
  },
  codex: {
    ".codex/AGENTS.md": "Answer in English.",
    ".codex/config.toml": `# Codex settings
model = "o3" # mine

[mcp_servers.mine]
command = "my-mcp"
`,
  },
  gemini: {
    ".gemini/GEMINI.md": "Use British spelling.\r\nKeep answers short.\r\n",
    ".gemini/settings.json": `{
  // mine
  "ui": { "theme": "GitHub" }
}
`,
  },
  qwen: {
    ".qwen/QWEN.md": "Use metric units.\n",
    ".qwen/settings.json": `{
  "mcpServers": {}
}
`,
  },
  opencode: {
    ".config/opencode/AGENTS.md": "Explain before editing.\n",
    ".config/opencode/opencode.json": `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mine": { "type": "local", "command": ["my-mcp"] }
  }
}
`,
  },
  pi: {
    ".pi/agent/AGENTS.md": "Be brief.\n",
    ".pi/agent/mcp.json": `{
  "mcpServers": {
    "mine": { "command": "my-mcp" }
  }
}
`,
  },
  crush: {
    ".config/crush/CRUSH.md": "No emoji.\n",
    ".config/crush/crush.json": `{
  "$schema": "https://charm.land/crush.json",
  "options": { "debug": false }
}
`,
  },
  kimi: {
    ".kimi/mcp.json": `{"mcpServers":{"mine":{"command":"my-mcp"}}}
`,
    ".agents/skills/my-skill/SKILL.md":
      "---\nname: my-skill\ndescription: Mine.\n---\n",
  },
  hermes: {
    ".hermes/config.yaml": `# Hermes Agent settings
model:
  default: anthropic/claude-sonnet-4 # mine
mcp_servers:
  mine:
    command: my-mcp
`,
  },
};
