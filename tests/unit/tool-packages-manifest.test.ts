import assert from "node:assert/strict";
import test from "node:test";
import { limits, parseManifest } from "../../src/tool-packages/index.js";
import { hash, isStdioMcp } from "../../src/tool-packages/manifest.js";
import type { ToolPackageManifest } from "../../src/tool-packages/types.js";

function manifest(): ToolPackageManifest {
  return {
    schemaVersion: 1,
    id: "portable-tools",
    version: "1.0.0",
    displayName: "Portable tools",
    files: [
      { path: "skills/review/SKILL.md", size: 4, sha256: hash("test") },
      { path: "server.mjs", size: 0, sha256: hash("") },
    ],
    skills: [{ path: "skills/review/SKILL.md" }],
    mcpServers: [
      {
        name: "files",
        launch: "node",
        entry: "server.mjs",
        args: [{ anchor: "workspace" }, { anchor: "package", path: "skills" }],
      },
    ],
  };
}

void test("tool package identity is stable across JSON formatting/key/file order and includes all declarations", () => {
  const original = manifest();
  const inspection = parseManifest(original);
  const reordered = { ...original, files: [...original.files].reverse() };
  assert.equal(
    inspection.digest,
    parseManifest(JSON.parse(JSON.stringify(reordered, null, 4)) as unknown)
      .digest,
  );
  assert.deepEqual(
    original,
    manifest(),
    "parse does not mutate caller objects",
  );
  assert.notEqual(
    inspection.digest,
    parseManifest({ ...original, displayName: "Other" }).digest,
  );
  assert.equal(inspection.fileCount, 2);
  assert.equal(inspection.totalBytes, 4);
});

void test("tool package schema rejects versions, host paths, Windows aliases and ambiguous directory spellings", () => {
  for (const input of [
    { ...manifest(), schemaVersion: 2 },
    { ...manifest(), scripts: { install: "run me" } },
    { ...manifest(), id: "../package" },
    { ...manifest(), files: [] },
  ])
    assert.throws(() => parseManifest(input));
  for (const name of [
    "../out",
    "/absolute",
    "C:/absolute",
    "C:relative",
    "a\\b",
    "a//b",
    "a/./b",
    "a/../b",
    "a:b",
    "CON.txt",
    "dir/NUL",
    "a. ",
    "tool-package.json",
    "tool-package.json/child",
    `${"a/".repeat(64)}file`,
  ]) {
    const input = manifest();
    input.files.push({ path: name, size: 0, sha256: hash("") });
    assert.throws(
      () => parseManifest(input),
      { code: "INVALID_TOOL_PACKAGE_PATH" },
      name,
    );
  }
  for (const paths of [
    ["server.mjs", "SERVER.mjs"],
    ["Folder/a", "folder/b"],
    ["é/a", "e\u0301/b"],
    ["parent", "parent/child"],
  ]) {
    const input = manifest();
    input.files = [
      ...input.files,
      ...paths.map((name) => ({ path: name, size: 0, sha256: hash("") })),
    ];
    assert.throws(() => parseManifest(input), {
      code: "INVALID_TOOL_PACKAGE_PATH",
    });
  }
});

void test("tool package declarations require local payloads, valid Skills, explicit secret slots and bounded resources", () => {
  const invalid = [
    { ...manifest(), skills: [{ path: "skills/review/missing.md" }] },
    { ...manifest(), skills: [], mcpServers: [] },
    {
      ...manifest(),
      mcpServers: [
        {
          name: "download",
          launch: "node",
          entry: "https://example.com/server.js",
        },
      ],
    },
    {
      ...manifest(),
      mcpServers: [{ name: "native", launch: "native", entry: "server.mjs" }],
    },
    {
      ...manifest(),
      mcpServers: [
        {
          name: "files",
          launch: "node",
          entry: "server.mjs",
          args: [{ anchor: "package", path: "../escape" }],
        },
      ],
    },
    {
      ...manifest(),
      mcpServers: [
        {
          name: "files",
          launch: "node",
          entry: "server.mjs",
          args: ["--token", "secret"],
        },
      ],
    },
    {
      ...manifest(),
      mcpServers: [
        {
          name: "files",
          launch: "node",
          entry: "server.mjs",
          env: { PATH: "override" },
        },
      ],
    },
    {
      ...manifest(),
      mcpServers: [
        {
          name: "files",
          launch: "node",
          entry: "server.mjs",
          env: { API_KEY: "secret" },
        },
      ],
    },
    {
      ...manifest(),
      mcpServers: [
        {
          name: "files",
          launch: "node",
          entry: "server.mjs",
          secretEnv: { API_KEY: "/secret/location" },
        },
      ],
    },
    {
      ...manifest(),
      files: manifest().files.map((file) => ({
        ...file,
        size: limits.fileBytes + 1,
      })),
    },
    {
      ...manifest(),
      files: [
        ...manifest().files,
        ...[1, 2, 3].map((i) => ({
          path: `large${i}`,
          size: limits.fileBytes,
          sha256: hash(""),
        })),
      ],
    },
  ];
  for (const input of invalid) assert.throws(() => parseManifest(input));
  const valid = manifest();
  const server = valid.mcpServers![0]!;
  assert.ok(isStdioMcp(server));
  server.secretEnv = { API_KEY: "packageKey" };
  const parsed = parseManifest(valid).manifest.mcpServers![0]!;
  assert.ok(isStdioMcp(parsed));
  assert.equal(parsed.secretEnv!.API_KEY, "packageKey");
});

void test("remote MCP declarations need no files but keep credentials in secret slots with env-only defaults", () => {
  const remote: ToolPackageManifest = {
    schemaVersion: 1,
    id: "remote-tools",
    version: "1.0.0",
    displayName: "Remote tools",
    files: [],
    mcpServers: [
      {
        name: "api",
        type: "http",
        url: "http://127.0.0.1:8123/mcp",
        headers: { "X-Tenant": "team-a" },
        secretHeaders: { Authorization: "API_TOKEN" },
      },
    ],
    defaultSecretBindings: { API_TOKEN: { kind: "env", value: "API_TOKEN" } },
  };
  assert.equal(parseManifest(remote).fileCount, 0);
  const server = remote.mcpServers![0]!;
  assert.equal(isStdioMcp(server), false);
  const variants: unknown[] = [
    { ...remote, mcpServers: [{ ...server, url: "file:///etc/passwd" }] },
    {
      ...remote,
      mcpServers: [{ ...server, url: "http://127.0.0.1:8123/mcp?key=1" }],
    },
    {
      ...remote,
      mcpServers: [{ ...server, headers: { Authorization: "Bearer abc" } }],
    },
    {
      ...remote,
      mcpServers: [{ ...server, secretHeaders: { Authorization: "/abs" } }],
    },
    {
      ...remote,
      defaultSecretBindings: { OTHER: { kind: "env", value: "OTHER" } },
    },
    {
      ...remote,
      defaultSecretBindings: {
        API_TOKEN: { kind: "file", value: "/secret/file" },
      },
    },
    { ...remote, skills: [{ path: "SKILL.md" }] },
  ];
  for (const input of variants)
    assert.throws(() => parseManifest(input), JSON.stringify(input));
});
