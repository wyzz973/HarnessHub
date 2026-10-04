// SPDX-License-Identifier: MIT
/**
 * Reviewed results of syncing the Library items of `addFixtureItems`
 * (library-support.ts) into one agent, in an empty home and over
 * EXISTING_LIBRARY: every file and link by path relative to the home, and
 * the items refused. Secret values never appear: references only. Regenerate
 * only after reviewing a change to what the Library writes.
 */
import type { LibraryAgent } from "../src/library/types.js";

interface Golden {
  files: Record<string, string>;
  refused: string[];
}

export const LIBRARY_GOLDEN: Readonly<
  Record<LibraryAgent, { empty: Golden; existing: Golden }>
> = {
  claude: {
    empty: {
      files: {
        ".claude.json": `{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "type": "sse",
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "github": {
      "type": "stdio",
      "command": "github-mcp",
      "args": [
        "stdio"
      ],
      "env": {
        "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
      }
    },
    "search": {
      "type": "http",
      "url": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "\${SEARCH_AUTH}"
      }
    }
  }
}
`,
        ".claude/CLAUDE.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".claude/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
    existing: {
      files: {
        ".claude.json": `{
  "numStartups": 4,
  "mcpServers": {
    "mine": { "command": "my-mcp" },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "type": "sse",
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "github": {
      "type": "stdio",
      "command": "github-mcp",
      "args": [
        "stdio"
      ],
      "env": {
        "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
      }
    },
    "search": {
      "type": "http",
      "url": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "\${SEARCH_AUTH}"
      }
    }
  }
}
`,
        ".claude/CLAUDE.md": `# My notes

Prefer small diffs.

<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".claude/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
  },
  codex: {
    empty: {
      files: {
        ".codex/AGENTS.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".codex/config.toml": `[mcp_servers.docs]
url = "https://mcp.example.test/docs"

[mcp_servers.docs.http_headers]
X-Client = "hh"

[mcp_servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/srv"]

[mcp_servers.files.env]
LOG_LEVEL = "info"

[mcp_servers.github]
command = "github-mcp"
args = ["stdio"]
env_vars = ["GITHUB_TOKEN"]

[mcp_servers.search]
url = "https://mcp.example.test/search"

[mcp_servers.search.env_http_headers]
Authorization = "SEARCH_AUTH"
`,
        ".codex/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:events"],
    },
    existing: {
      files: {
        ".codex/AGENTS.md": `Answer in English.

<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".codex/config.toml": `# Codex settings
model = "o3" # mine

[mcp_servers.mine]
command = "my-mcp"

[mcp_servers.docs]
url = "https://mcp.example.test/docs"

[mcp_servers.docs.http_headers]
X-Client = "hh"

[mcp_servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/srv"]

[mcp_servers.files.env]
LOG_LEVEL = "info"

[mcp_servers.github]
command = "github-mcp"
args = ["stdio"]
env_vars = ["GITHUB_TOKEN"]

[mcp_servers.search]
url = "https://mcp.example.test/search"

[mcp_servers.search.env_http_headers]
Authorization = "SEARCH_AUTH"
`,
        ".codex/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:events"],
    },
  },
  gemini: {
    empty: {
      files: {
        ".gemini/GEMINI.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".gemini/settings.json": `{
  "mcpServers": {
    "docs": {
      "httpUrl": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "github": {
      "command": "github-mcp",
      "args": [
        "stdio"
      ],
      "env": {
        "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
      }
    },
    "search": {
      "httpUrl": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "\${SEARCH_AUTH}"
      }
    }
  }
}
`,
        ".gemini/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
    existing: {
      files: {
        ".gemini/GEMINI.md": `Use British spelling.\r
Keep answers short.\r
\r
<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->\r
# Team rules\r
\r
Run the tests before you commit.\r
<!-- harnesshub:end -->\r
`,
        ".gemini/settings.json": `{
  // mine
  "ui": { "theme": "GitHub" },
  "mcpServers": {
    "docs": {
      "httpUrl": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "github": {
      "command": "github-mcp",
      "args": [
        "stdio"
      ],
      "env": {
        "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
      }
    },
    "search": {
      "httpUrl": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "\${SEARCH_AUTH}"
      }
    }
  }
}
`,
        ".gemini/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
  },
  qwen: {
    empty: {
      files: {
        ".qwen/QWEN.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".qwen/settings.json": `{
  "mcpServers": {
    "docs": {
      "httpUrl": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "github": {
      "command": "github-mcp",
      "args": [
        "stdio"
      ],
      "env": {
        "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
      }
    },
    "search": {
      "httpUrl": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "\${SEARCH_AUTH}"
      }
    }
  }
}
`,
        ".qwen/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
    existing: {
      files: {
        ".qwen/QWEN.md": `Use metric units.

<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".qwen/settings.json": `{
  "mcpServers": {
    "docs": {
      "httpUrl": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    },
    "github": {
      "command": "github-mcp",
      "args": [
        "stdio"
      ],
      "env": {
        "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
      }
    },
    "search": {
      "httpUrl": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "\${SEARCH_AUTH}"
      }
    }
  }
}
`,
        ".qwen/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
  },
  opencode: {
    empty: {
      files: {
        ".config/opencode/AGENTS.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".config/opencode/opencode.json": `{
  "mcp": {
    "docs": {
      "type": "remote",
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      },
      "enabled": true
    },
    "events": {
      "type": "remote",
      "url": "https://mcp.example.test/events",
      "enabled": true
    },
    "files": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "environment": {
        "LOG_LEVEL": "info"
      },
      "enabled": true
    },
    "github": {
      "type": "local",
      "command": [
        "github-mcp",
        "stdio"
      ],
      "environment": {
        "GITHUB_TOKEN": "{env:GITHUB_TOKEN}"
      },
      "enabled": true
    },
    "search": {
      "type": "remote",
      "url": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "{env:SEARCH_AUTH}"
      },
      "enabled": true
    }
  }
}
`,
        ".config/opencode/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
    existing: {
      files: {
        ".config/opencode/AGENTS.md": `Explain before editing.

<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".config/opencode/opencode.json": `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mine": { "type": "local", "command": ["my-mcp"] },
    "docs": {
      "type": "remote",
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      },
      "enabled": true
    },
    "events": {
      "type": "remote",
      "url": "https://mcp.example.test/events",
      "enabled": true
    },
    "files": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "environment": {
        "LOG_LEVEL": "info"
      },
      "enabled": true
    },
    "github": {
      "type": "local",
      "command": [
        "github-mcp",
        "stdio"
      ],
      "environment": {
        "GITHUB_TOKEN": "{env:GITHUB_TOKEN}"
      },
      "enabled": true
    },
    "search": {
      "type": "remote",
      "url": "https://mcp.example.test/search",
      "headers": {
        "Authorization": "{env:SEARCH_AUTH}"
      },
      "enabled": true
    }
  }
}
`,
        ".config/opencode/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: [],
    },
  },
  pi: {
    empty: {
      files: {
        ".pi/agent/AGENTS.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".pi/agent/mcp.json": `{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
`,
        ".pi/agent/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:events", "mcp:github", "mcp:search"],
    },
    existing: {
      files: {
        ".pi/agent/AGENTS.md": `Be brief.

<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".pi/agent/mcp.json": `{
  "mcpServers": {
    "mine": { "command": "my-mcp" },
    "docs": {
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
`,
        ".pi/agent/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:events", "mcp:github", "mcp:search"],
    },
  },
  crush: {
    empty: {
      files: {
        ".config/crush/crush.json": `{
  "mcp": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "type": "sse",
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
`,
        ".config/crush/CRUSH.md": `<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".config/crush/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:github", "mcp:search"],
    },
    existing: {
      files: {
        ".config/crush/crush.json": `{
  "$schema": "https://charm.land/crush.json",
  "options": { "debug": false },
  "mcp": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.test/docs",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "type": "sse",
      "url": "https://mcp.example.test/events"
    },
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
`,
        ".config/crush/CRUSH.md": `No emoji.

<!-- harnesshub:begin id=team sha=0bdcbadf4ebe3366828a92ca4f01dafcb82a7c79a134ed0dfc293c3bd66586ea -->
# Team rules

Run the tests before you commit.
<!-- harnesshub:end -->
`,
        ".config/crush/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:github", "mcp:search"],
    },
  },
  kimi: {
    empty: {
      files: {
        ".agents/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
        ".kimi/mcp.json": `{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.test/docs",
      "transport": "http",
      "headers": {
        "X-Client": "hh"
      }
    },
    "events": {
      "url": "https://mcp.example.test/events",
      "transport": "sse"
    },
    "files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
`,
      },
      refused: ["mcp:github", "mcp:search"],
    },
    existing: {
      files: {
        ".agents/skills/my-skill/SKILL.md": `---
name: my-skill
description: Mine.
---
`,
        ".agents/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
        ".kimi/mcp.json": `{"mcpServers":{"mine":{"command":"my-mcp"}, "docs": { "url": "https://mcp.example.test/docs", "transport": "http", "headers": { "X-Client": "hh" } }, "events": { "url": "https://mcp.example.test/events", "transport": "sse" }, "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv"], "env": { "LOG_LEVEL": "info" } }}}
`,
      },
      refused: ["mcp:github", "mcp:search"],
    },
  },
  hermes: {
    empty: {
      files: {
        ".hermes/config.yaml": `mcp_servers:
  docs:
    url: https://mcp.example.test/docs
    headers:
      X-Client: hh
  events:
    url: https://mcp.example.test/events
    transport: sse
  files:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /srv
    env:
      LOG_LEVEL: info
`,
        ".hermes/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:github", "mcp:search"],
    },
    existing: {
      files: {
        ".hermes/config.yaml": `# Hermes Agent settings
model:
  default: anthropic/claude-sonnet-4 # mine
mcp_servers:
  mine:
    command: my-mcp
  docs:
    url: https://mcp.example.test/docs
    headers:
      X-Client: hh
  events:
    url: https://mcp.example.test/events
    transport: sse
  files:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /srv
    env:
      LOG_LEVEL: info
`,
        ".hermes/skills/pdf-tools":
          "-> <data>/library/skills/<version>/pdf-tools",
      },
      refused: ["mcp:github", "mcp:search"],
    },
  },
};
