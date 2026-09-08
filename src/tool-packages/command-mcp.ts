import { spawn } from "node:child_process";
import path from "node:path";

interface CommandTool {
  name: string;
  description?: string;
  command: string;
  prefixArgs: string[];
}

const MAX_MESSAGE = 64 * 1024;
const MAX_BUFFER = 128 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_ARGS = 64;
const MAX_ARG = 4096;
const TIMEOUT_MS = 30_000;
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(message);
}
function parseConfig(): { workspace: string; tools: CommandTool[] } {
  const workspace = process.env.HARNESSHUB_CLI_WORKSPACE;
  const raw = process.env.HARNESSHUB_CLI_TOOLS_JSON;
  if (!workspace || !path.isAbsolute(workspace) || !raw)
    fail("Managed CLI MCP configuration is missing");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail("Managed CLI MCP configuration is invalid JSON");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    fail("Managed CLI MCP must contain 1-16 tools");
  const tools = value.map((item): CommandTool => {
    if (!object(item)) fail("Invalid managed CLI tool");
    const { name, description, command, prefixArgs } = item;
    if (
      typeof name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/.test(name) ||
      typeof command !== "string" ||
      !path.isAbsolute(command) ||
      !Array.isArray(prefixArgs) ||
      prefixArgs.length > 128 ||
      !prefixArgs.every(
        (arg) => typeof arg === "string" && arg.length > 0 && arg.length <= MAX_ARG,
      ) ||
      (description !== undefined &&
        (typeof description !== "string" || description.length > 512))
    )
      fail("Invalid managed CLI tool declaration");
    return {
      name,
      command,
      prefixArgs: [...prefixArgs] as string[],
      ...(typeof description === "string" ? { description } : {}),
    };
  });
  if (new Set(tools.map((tool) => tool.name.toLowerCase())).size !== tools.length)
    fail("Managed CLI tool names must be unique");
  return { workspace, tools };
}

const config = parseConfig();
const toolMap = new Map(config.tools.map((tool) => [`cli_${tool.name}`, tool]));
const toolDefinitions = config.tools.map((tool) => ({
  name: `cli_${tool.name}`,
  description:
    tool.description ??
    `Run the allow-listed ${tool.name} CLI in the current workspace. Shell expressions are not accepted.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      args: {
        type: "array",
        maxItems: MAX_ARGS,
        items: { type: "string", maxLength: MAX_ARG },
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
}));

function dynamicArgs(value: unknown): string[] {
  if (!object(value)) fail("CLI arguments must be an object");
  if (Object.keys(value).some((key) => key !== "args"))
    fail("Unknown CLI tool argument");
  const args = value.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > MAX_ARGS ||
    !args.every(
      (arg) =>
        typeof arg === "string" &&
        arg.length <= MAX_ARG &&
        !arg.includes("\0"),
    )
  )
    fail("CLI args must be a bounded string array");
  return args as string[];
}

function boundedAppend(current: Buffer[], bytes: Buffer, state: { size: number; truncated: boolean }) {
  if (state.size >= MAX_OUTPUT) {
    state.truncated = true;
    return;
  }
  const remaining = MAX_OUTPUT - state.size;
  const selected = bytes.subarray(0, remaining);
  current.push(selected);
  state.size += selected.length;
  if (selected.length < bytes.length) state.truncated = true;
}

async function execute(tool: CommandTool, args: string[]) {
  return new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
  }>((resolve, reject) => {
    const controller = new AbortController();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const output = { size: 0, truncated: false };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);
    timer.unref();
    const child = spawn(tool.command, [...tool.prefixArgs, ...args], {
      cwd: config.workspace,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });
    child.stdout.on("data", (chunk: Buffer) => boundedAppend(stdout, chunk, output));
    child.stderr.on("data", (chunk: Buffer) => boundedAppend(stderr, chunk, output));
    child.once("error", (error) => {
      clearTimeout(timer);
      if (timedOut && error.name === "AbortError")
        resolve({
          exitCode: null,
          signal: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut: true,
          truncated: output.truncated,
        });
      else reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        truncated: output.truncated,
      });
    });
  });
}

async function output(value: unknown) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_OUTPUT) fail("MCP response size limit reached");
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
  );
}

async function handle(bytes: Buffer, state: { initialized: boolean; ready: boolean }) {
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid UTF-8 JSON" } });
  }
  if (!object(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string")
    return output({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } });
  if (!Object.hasOwn(request, "id")) {
    if (request.method === "notifications/initialized" && state.initialized) state.ready = true;
    return;
  }
  const id = request.id;
  if (!(typeof id === "string" || Number.isSafeInteger(id)))
    return output({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request id" } });
  const answer = (result: unknown) => output({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => output({ jsonrpc: "2.0", id, error: { code, message } });
  if (request.method === "ping") return answer({});
  if (request.method === "initialize") {
    if (state.initialized || !object(request.params) || typeof request.params.protocolVersion !== "string")
      return error(-32602, "Invalid initialize request");
    state.initialized = true;
    return answer({
      protocolVersion: versions.includes(request.params.protocolVersion)
        ? request.params.protocolVersion
        : versions[0],
      capabilities: { tools: {} },
      serverInfo: { name: "harnesshub-command-mcp", version: "1.0.0" },
    });
  }
  if (!state.ready) return error(-32002, "MCP client is not initialized");
  if (request.method === "tools/list") return answer({ tools: toolDefinitions });
  if (request.method === "tools/call") {
    if (!object(request.params) || typeof request.params.name !== "string")
      return error(-32602, "Invalid tools/call request");
    const tool = toolMap.get(request.params.name);
    if (!tool) return error(-32602, "Unknown CLI tool");
    try {
      const result = await execute(tool, dynamicArgs(request.params.arguments ?? {}));
      return answer({
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: result.exitCode !== 0 || result.timedOut,
      });
    } catch (cause) {
      return answer({
        content: [
          {
            type: "text",
            text: cause instanceof Error ? cause.message : "CLI execution failed",
          },
        ],
        isError: true,
      });
    }
  }
  return error(-32601, "Method not found");
}

const state = { initialized: false, ready: false };
let pending = Buffer.alloc(0);
let stopped = false;
const stop = () => {
  stopped = true;
  process.stdin.destroy();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.stdout.on("error", stop);
process.stdin.on("data", (chunk: Buffer) => {
  if (stopped) return;
  pending = Buffer.concat([pending, chunk]);
  if (pending.length > MAX_BUFFER) {
    stop();
    return;
  }
  for (;;) {
    const newline = pending.indexOf(10);
    if (newline < 0) break;
    const line = pending.subarray(0, newline);
    pending = pending.subarray(newline + 1);
    if (line.length === 0) continue;
    if (line.length > MAX_MESSAGE) {
      void output({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } });
      continue;
    }
    process.stdin.pause();
    void handle(line, state).finally(() => {
      if (!stopped) process.stdin.resume();
    });
  }
});
