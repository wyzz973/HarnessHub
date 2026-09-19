// Zero-dependency MCP stdio server for the simple-toolkit example.
// mcp.json passes "--root ${workspaceFolder}"; the import turns it into the
// Session workspace, which the HarnessHub Worker substitutes before start.
import { opendir, realpath } from "node:fs/promises";
import path from "node:path";

const PLACEHOLDER = "${HARNESSHUB_SESSION_WORKSPACE}";
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--root")
  fail("Usage: overview-mcp.mjs --root ABSOLUTE_WORKSPACE");
const requested = args[1];
if (requested.includes(PLACEHOLDER))
  fail("The Session workspace placeholder was not substituted by the Worker");
if (!path.isAbsolute(requested)) fail("--root must be an absolute directory");
const limit = Math.min(
  Math.max(Number.parseInt(process.env.OVERVIEW_LIMIT ?? "50", 10) || 50, 1),
  500,
);

const tools = [
  {
    name: "workspace_overview",
    description:
      "List the top-level entries of the current Session workspace (read-only).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

async function overview() {
  const root = await realpath(requested);
  const entries = [];
  let truncated = false;
  for await (const entry of await opendir(root)) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      type: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other",
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { root, entries, truncated };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let initialized = false;
let ready = false;
async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
  if (
    !request ||
    typeof request !== "object" ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string"
  )
    return send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
  if (!Object.hasOwn(request, "id")) {
    if (request.method === "notifications/initialized" && initialized)
      ready = true;
    return undefined;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: request.id, result });
  const error = (code, message) =>
    send({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  if (request.method === "ping") return reply({});
  if (request.method === "initialize") {
    if (initialized) return error(-32602, "Already initialized");
    initialized = true;
    const version = request.params?.protocolVersion;
    return reply({
      protocolVersion: versions.includes(version) ? version : versions[0],
      capabilities: { tools: {} },
      serverInfo: { name: "simple-toolkit-overview", version: "1.0.0" },
    });
  }
  if (!ready) return error(-32002, "Server not initialized");
  if (request.method === "tools/list") return reply({ tools });
  if (request.method === "tools/call") {
    if (request.params?.name !== "workspace_overview")
      return error(-32602, "Unknown tool");
    try {
      return reply({
        content: [{ type: "text", text: JSON.stringify(await overview()) }],
        isError: false,
      });
    } catch (cause) {
      return reply({
        content: [
          {
            type: "text",
            text: cause instanceof Error ? cause.message : "Overview failed",
          },
        ],
        isError: true,
      });
    }
  }
  return error(-32601, "Method not found");
}

let buffer = "";
let queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) fail("Message too large");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line)
      queue = queue
        .then(() => handle(line))
        .catch((cause) =>
          process.stderr.write(
            `${cause instanceof Error ? cause.message : cause}\n`,
          ),
        );
  }
});
