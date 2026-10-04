// SPDX-License-Identifier: MIT
/**
 * Where each core agent reads its user-wide instructions, MCP servers and
 * skills (04 section 8), following Magpie's table (yetone/magpie, MIT,
 * internal/library/targets.go @2e340f7) and the directory variables the
 * wiring Adapters honour. Locations are computed from an explicit home and
 * environment map; nothing here reads the process environment.
 */
import path from "node:path";
import { wiringAdapter } from "../wiring/adapters/index.js";
import type {
  AdapterEnvironment,
  FileLocation,
} from "../wiring/adapters/types.js";
import type { ConfigFormat } from "../wiring/formats/index.js";
import type { LibraryAgent, McpServerItem } from "./types.js";

/** How an agent spells an MCP server entry (see `encodeServer`). */
export type McpStyle =
  "claude" | "codex" | "gemini" | "opencode" | "pi" | "kimi" | "hermes";

/**
 * How an agent's configuration names an environment variable instead of a
 * value: Claude Code `${VAR}`, Gemini CLI and Qwen Code `${VAR}`, OpenCode
 * `{env:VAR}`, Codex `env_vars` and `env_http_headers`. Absent for an agent
 * whose MCP configuration takes values only (04 section 8: Kimi, and Pi,
 * Crush and Hermes until verified).
 */
export type SecretIndirection = "claude" | "gemini" | "opencode" | "codex";

export interface McpPlacement {
  file: FileLocation;
  format: ConfigFormat;
  /** The object the servers are kept under: object keys only. */
  container: readonly string[];
  style: McpStyle;
  transports: readonly McpServerItem["transport"][];
  indirection?: SecretIndirection;
}

export interface LibraryTarget {
  agent: LibraryAgent;
  name: string;
  instructions?: {
    file: FileLocation;
    /** A file the agent reads instead when it exists (Codex's AGENTS.override.md). */
    override?: string;
  };
  mcp?: McpPlacement;
  skills?: { directory: string; root: string };
}

/** What each agent can take, independent of where its files are. */
export const libraryCapabilities: Readonly<
  Record<
    LibraryAgent,
    {
      instructions: boolean;
      transports: readonly McpServerItem["transport"][];
      indirection: boolean;
    }
  >
> = {
  claude: {
    instructions: true,
    transports: ["stdio", "http", "sse"],
    indirection: true,
  },
  // Codex speaks streamable HTTP only (Magpie internal/library/mcp.go).
  codex: {
    instructions: true,
    transports: ["stdio", "http"],
    indirection: true,
  },
  gemini: {
    instructions: true,
    transports: ["stdio", "http", "sse"],
    indirection: true,
  },
  qwen: {
    instructions: true,
    transports: ["stdio", "http", "sse"],
    indirection: true,
  },
  opencode: {
    instructions: true,
    transports: ["stdio", "http", "sse"],
    indirection: true,
  },
  // Pi's own MCP (0.99 on) has no SSE.
  pi: { instructions: true, transports: ["stdio", "http"], indirection: false },
  crush: {
    instructions: true,
    transports: ["stdio", "http", "sse"],
    indirection: false,
  },
  kimi: {
    instructions: false,
    transports: ["stdio", "http", "sse"],
    indirection: false,
  },
  hermes: {
    instructions: false,
    transports: ["stdio", "http", "sse"],
    indirection: false,
  },
};

/** The directory of the file an Adapter edits, as the wiring locates it. */
function adapterDirectory(
  environment: AdapterEnvironment,
  agent: string,
  fileId: string,
): { directory: string; root: string; location: FileLocation } {
  const file = wiringAdapter(agent).files.find((item) => item.id === fileId);
  if (!file) throw new Error(`The ${agent} Adapter has no ${fileId} file`);
  const location = file.locate(environment);
  return {
    directory: path.dirname(location.create),
    root: location.root,
    location,
  };
}

function single(file: string, root: string): FileLocation {
  return { candidates: [file], create: file, root };
}

/**
 * Where `agent` keeps each of the three on this machine.
 *
 * @throws WiringError `WIRING_CONTEXT_INVALID` for a relative directory variable.
 */
export function libraryTarget(
  agent: LibraryAgent,
  environment: AdapterEnvironment,
): LibraryTarget {
  const capability = libraryCapabilities[agent];
  const transports = capability.transports;
  switch (agent) {
    case "claude": {
      const { directory, root } = adapterDirectory(
        environment,
        "claude",
        "settings",
      );
      // Claude Code keeps user-wide MCP servers in ~/.claude.json, or in
      // the directory CLAUDE_CONFIG_DIR names.
      const override = environment.directory("CLAUDE_CONFIG_DIR");
      return {
        agent,
        name: "Claude Code",
        instructions: { file: single(path.join(directory, "CLAUDE.md"), root) },
        mcp: {
          file: single(
            path.join(override ?? environment.home, ".claude.json"),
            override ?? environment.home,
          ),
          format: "json",
          container: ["mcpServers"],
          style: "claude",
          transports,
          indirection: "claude",
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
    case "codex": {
      const { directory, root, location } = adapterDirectory(
        environment,
        "codex",
        "config",
      );
      return {
        agent,
        name: "Codex CLI",
        instructions: {
          file: single(path.join(directory, "AGENTS.md"), root),
          override: path.join(directory, "AGENTS.override.md"),
        },
        mcp: {
          file: location,
          format: "toml",
          container: ["mcp_servers"],
          style: "codex",
          transports,
          indirection: "codex",
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
    case "gemini":
    case "qwen": {
      const { directory, root, location } = adapterDirectory(
        environment,
        agent,
        "settings",
      );
      return {
        agent,
        name: agent === "gemini" ? "Gemini CLI" : "Qwen Code",
        instructions: {
          file: single(
            path.join(directory, agent === "gemini" ? "GEMINI.md" : "QWEN.md"),
            root,
          ),
        },
        mcp: {
          file: location,
          format: "json",
          container: ["mcpServers"],
          style: "gemini",
          transports,
          indirection: "gemini",
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
    case "opencode": {
      const { directory, root, location } = adapterDirectory(
        environment,
        "opencode",
        "config",
      );
      return {
        agent,
        name: "OpenCode",
        instructions: { file: single(path.join(directory, "AGENTS.md"), root) },
        mcp: {
          file: location,
          format: "json",
          container: ["mcp"],
          style: "opencode",
          transports,
          indirection: "opencode",
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
    case "pi": {
      const { directory, root } = adapterDirectory(
        environment,
        "pi",
        "settings",
      );
      // Pi 0.99 and later read their own mcp.json beside settings.json.
      return {
        agent,
        name: "Pi",
        instructions: { file: single(path.join(directory, "AGENTS.md"), root) },
        mcp: {
          file: single(path.join(directory, "mcp.json"), root),
          format: "json",
          container: ["mcpServers"],
          style: "pi",
          transports,
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
    case "crush": {
      const { directory, root, location } = adapterDirectory(
        environment,
        "crush",
        "config",
      );
      // CRUSH.md is read from the XDG configuration directory on every
      // platform; crush.json may be under LOCALAPPDATA on Windows.
      const config = environment.directory("XDG_CONFIG_HOME");
      return {
        agent,
        name: "Crush",
        instructions: {
          file: single(
            path.join(
              config ?? path.join(environment.home, ".config"),
              "crush",
              "CRUSH.md",
            ),
            config ?? environment.home,
          ),
        },
        mcp: {
          file: location,
          format: "json",
          container: ["mcp"],
          style: "claude",
          transports,
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
    case "kimi": {
      const { directory, root } = adapterDirectory(
        environment,
        "kimi",
        "config",
      );
      // Kimi reads the first user-wide skills directory there is, so one
      // of its own would hide Claude Code's: the shared one instead.
      return {
        agent,
        name: "Kimi Code",
        mcp: {
          file: single(path.join(directory, "mcp.json"), root),
          format: "json",
          container: ["mcpServers"],
          style: "kimi",
          transports,
        },
        skills: {
          directory: path.join(environment.home, ".agents", "skills"),
          root: environment.home,
        },
      };
    }
    case "hermes": {
      const { directory, root, location } = adapterDirectory(
        environment,
        "hermes",
        "config",
      );
      return {
        agent,
        name: "Hermes Agent",
        mcp: {
          file: location,
          format: "yaml",
          container: ["mcp_servers"],
          style: "hermes",
          transports,
        },
        skills: { directory: path.join(directory, "skills"), root },
      };
    }
  }
}
