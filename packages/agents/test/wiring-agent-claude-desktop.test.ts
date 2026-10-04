// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  planWiring,
  unwire,
  WiringError,
} from "../src/wiring/index.js";
import { sandbox, TARGET, writeFiles } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's agents at 2e340f7; the golden files are
// reviewed output: regenerate them only after reviewing a change to what the
// adapter writes.
/** Where Claude Desktop keeps its folders on this platform, relative to the home. */
const BASE =
  process.platform === "darwin"
    ? "Library/Application Support"
    : process.platform === "win32"
      ? "AppData/Local"
      : ".config";
const PROFILE =
  "Claude-3p/configLibrary/00000000-0000-4000-8000-6861726e6573.json";
const FILES = [
  PROFILE,
  "Claude-3p/configLibrary/_meta.json",
  "Claude-3p/claude_desktop_config.json",
  "Claude/claude_desktop_config.json",
];

adapterSuite("claude-desktop", {
  protocol: "anthropic",
  executables: [],
  files: FILES.map((file) => `${BASE}/${file}`),
  locations:
    process.platform === "darwin"
      ? []
      : [
          {
            env:
              process.platform === "win32"
                ? { LOCALAPPDATA: "local" }
                : { XDG_CONFIG_HOME: "xdg" },
            files: FILES.map(
              (file) =>
                `${process.platform === "win32" ? "local" : "xdg"}/${file}`,
            ),
          },
        ],
  existing: {
    [`${BASE}/Claude-3p/configLibrary/00000000-0000-4000-8000-6861726e6573.json`]: `{
  "coworkEgressAllowedHosts": ["example.com"]
}
`,
    [`${BASE}/Claude-3p/configLibrary/_meta.json`]: `{
  "appliedId": "11111111-2222-4333-8444-555555555555",
  "entries": [
    { "id": "11111111-2222-4333-8444-555555555555", "name": "Bedrock" }
  ]
}
`,
    [`${BASE}/Claude-3p/claude_desktop_config.json`]: `{
  "mcpServers": {}
}
`,
    [`${BASE}/Claude/claude_desktop_config.json`]: `{
  "deploymentMode": "1p",
  "mcpServers": { "files": { "command": "npx" } }
}
`,
  },
  golden: {
    empty: {
      [`${BASE}/Claude-3p/claude_desktop_config.json`]: `{
  "deploymentMode": "3p"
}
`,
      [`${BASE}/Claude-3p/configLibrary/_meta.json`]: `{
  "entries": [
    {
      "id": "00000000-0000-4000-8000-6861726e6573",
      "name": "HarnessHub"
    }
  ],
  "appliedId": "00000000-0000-4000-8000-6861726e6573"
}
`,
      [`${BASE}/Claude-3p/configLibrary/00000000-0000-4000-8000-6861726e6573.json`]: `{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:3180",
  "inferenceGatewayApiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
  "inferenceGatewayAuthScheme": "bearer",
  "disableDeploymentModeChooser": true,
  "coworkEgressAllowedHosts": [
    "*"
  ]
}
`,
      [`${BASE}/Claude/claude_desktop_config.json`]: `{
  "deploymentMode": "3p"
}
`,
    },
    existing: {
      [`${BASE}/Claude-3p/claude_desktop_config.json`]: `{
  "mcpServers": {},
  "deploymentMode": "3p"
}
`,
      [`${BASE}/Claude-3p/configLibrary/_meta.json`]: `{
  "appliedId": "00000000-0000-4000-8000-6861726e6573",
  "entries": [
    { "id": "11111111-2222-4333-8444-555555555555", "name": "Bedrock" },
    {
      "id": "00000000-0000-4000-8000-6861726e6573",
      "name": "HarnessHub"
    }
  ]
}
`,
      [`${BASE}/Claude-3p/configLibrary/00000000-0000-4000-8000-6861726e6573.json`]: `{
  "coworkEgressAllowedHosts": ["example.com"],
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:3180",
  "inferenceGatewayApiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
  "inferenceGatewayAuthScheme": "bearer",
  "disableDeploymentModeChooser": true
}
`,
      [`${BASE}/Claude/claude_desktop_config.json`]: `{
  "deploymentMode": "3p",
  "mcpServers": { "files": { "command": "npx" } }
}
`,
    },
  },
});

void test("claude-desktop: unwire after Desktop changed its files puts back the mode and the profile applied before", async (t) => {
  const context = await sandbox(t);
  const meta = path.join(
    context.home,
    BASE,
    "Claude-3p",
    "configLibrary",
    "_meta.json",
  );
  const config = path.join(
    context.home,
    BASE,
    "Claude",
    "claude_desktop_config.json",
  );
  await writeFiles(context.home, {
    [`${BASE}/Claude-3p/configLibrary/_meta.json`]:
      '{"appliedId": "other", "entries": [{"id": "other", "name": "Bedrock"}]}\n',
    [`${BASE}/Claude/claude_desktop_config.json`]: '{"deploymentMode": "1p"}\n',
  });
  const { record } = await applyWiring("claude-desktop", TARGET, context);
  // Desktop adds a profile of its own after ours and touches its config.
  const wired = JSON.parse(await readFile(meta, "utf8")) as {
    entries: unknown[];
  };
  await writeFile(
    meta,
    JSON.stringify({
      ...wired,
      entries: [...wired.entries, { id: "new", name: "Vertex" }],
    }),
  );
  await writeFile(
    config,
    JSON.stringify({
      ...(JSON.parse(await readFile(config, "utf8")) as object),
      mcpServers: {},
    }),
  );
  await unwire(record, context);
  assert.deepEqual(JSON.parse(await readFile(meta, "utf8")), {
    appliedId: "other",
    entries: [
      { id: "other", name: "Bedrock" },
      { id: "new", name: "Vertex" },
    ],
  });
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
    deploymentMode: "1p",
    mcpServers: {},
  });
});
