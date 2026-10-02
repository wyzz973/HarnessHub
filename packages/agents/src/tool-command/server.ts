// SPDX-License-Identifier: MIT
import path from "node:path";
import type { ProcessLauncher } from "@harnesshub/core/process-launcher";
import {
  MAX_ARG,
  parseCommandConfiguration,
  type CommandConfiguration,
  type CommandTool,
} from "./config.js";
import { isWindowsBatch, windowsBatchLaunch } from "./windows-batch.js";

const MAX_MESSAGE = 64 * 1024;
const MAX_BUFFER = 128 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_ARGS = 64;
const TIMEOUT_MS = 30_000;
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(message);
}

/** One command MCP server: its validated tools and the launcher that runs them. */
interface Server {
  readonly config: CommandConfiguration;
  readonly tools: ReadonlyMap<string, CommandTool>;
  readonly definitions: ReturnType<typeof definitions>;
  readonly launcher: ProcessLauncher;
}

const definitions = (config: CommandConfiguration) =>
  config.tools.map((tool) => ({
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
        typeof arg === "string" && arg.length <= MAX_ARG && !arg.includes("\0"),
    )
  )
    fail("CLI args must be a bounded string array");
  return args as string[];
}

function boundedAppend(
  current: Buffer[],
  bytes: Buffer,
  state: { size: number; truncated: boolean },
) {
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

/** Direct argv for native programs; Windows batch entries go through cmd.exe. */
function launch(tool: CommandTool, args: string[]) {
  const argv = [...tool.prefixArgs, ...args];
  if (process.platform !== "win32")
    return { file: tool.command, argv, windowsVerbatimArguments: false };
  if (path.extname(tool.command).toLowerCase() === ".ps1")
    fail(
      "PowerShell script entries are not supported; wrap the script in a .cmd file or use a native executable",
    );
  if (!isWindowsBatch(tool.command))
    return { file: tool.command, argv, windowsVerbatimArguments: false };
  // Node rejects direct .cmd/.bat spawns (CVE-2024-27980). cmd.exe receives
  // every argument quoted; values it would still reinterpret are rejected.
  const batch = windowsBatchLaunch(tool.command, argv, process.env);
  return { file: batch.file, argv: batch.args, windowsVerbatimArguments: true };
}

async function execute(
  server: Server,
  tool: CommandTool,
  args: string[],
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  const command = launch(tool, args);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const output = { size: 0, truncated: false };
  // The tool stays in this server's process group, which belongs to the
  // engine's Worker. After TIMEOUT_MS the launcher sends SIGTERM, and SIGKILL
  // two seconds later if the tool is still running; the call answers once the
  // tool has exited.
  const child = server.launcher.launch({
    file: command.file,
    args: command.argv,
    cwd: server.config.workspace,
    env: "inherit",
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: TIMEOUT_MS,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  });
  child.stdout?.on("data", (chunk: Buffer) =>
    boundedAppend(stdout, chunk, output),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    boundedAppend(stderr, chunk, output),
  );
  const collected = () => ({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    truncated: output.truncated,
  });
  const exit = await child.exit;
  if (exit.error) throw exit.error;
  // A timed-out tool is reported at once, without waiting for its streams.
  if (exit.timedOut)
    return { exitCode: null, signal: null, ...collected(), timedOut: true };
  const closed = await child.closed;
  return {
    exitCode: closed.code,
    signal: closed.signal,
    ...collected(),
    timedOut: closed.timedOut,
  };
}

async function output(value: unknown) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_OUTPUT)
    fail("MCP response size limit reached");
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
  );
}

async function handle(
  server: Server,
  bytes: Buffer,
  state: { initialized: boolean; ready: boolean },
) {
  let request: unknown;
  try {
    request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return output({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid UTF-8 JSON" },
    });
  }
  if (
    !object(request) ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string"
  )
    return output({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid JSON-RPC request" },
    });
  if (!Object.hasOwn(request, "id")) {
    if (request.method === "notifications/initialized" && state.initialized)
      state.ready = true;
    return;
  }
  const id = request.id;
  if (!(typeof id === "string" || Number.isSafeInteger(id)))
    return output({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request id" },
    });
  const answer = (result: unknown) => output({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) =>
    output({ jsonrpc: "2.0", id, error: { code, message } });
  if (request.method === "ping") return answer({});
  if (request.method === "initialize") {
    if (
      state.initialized ||
      !object(request.params) ||
      typeof request.params.protocolVersion !== "string"
    )
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
  if (request.method === "tools/list")
    return answer({ tools: server.definitions });
  if (request.method === "tools/call") {
    if (!object(request.params) || typeof request.params.name !== "string")
      return error(-32602, "Invalid tools/call request");
    const tool = server.tools.get(request.params.name);
    if (!tool) return error(-32602, "Unknown CLI tool");
    try {
      const result = await execute(
        server,
        tool,
        dynamicArgs(request.params.arguments ?? {}),
      );
      return answer({
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: result.exitCode !== 0 || result.timedOut,
      });
    } catch (cause) {
      return answer({
        content: [
          {
            type: "text",
            text:
              cause instanceof Error ? cause.message : "CLI execution failed",
          },
        ],
        isError: true,
      });
    }
  }
  return error(-32601, "Method not found");
}

/**
 * Runs the command MCP server on this process's stdin and stdout, configured
 * by its command line and environment (`--workspace <dir>` and the managed
 * CLI declaration). Tools are started with `launcher`. SIGINT, SIGTERM or a
 * failed stdout stop reading requests and call `onStop`, whose owner
 * terminates any tool still running.
 *
 * @throws Error when the configuration is invalid, before any tool can run.
 */
export function serveCommandMcp(
  launcher: ProcessLauncher,
  onStop: () => void,
): void {
  const config = parseCommandConfiguration(process.argv.slice(2), process.env);
  const server: Server = {
    config,
    tools: new Map(config.tools.map((tool) => [`cli_${tool.name}`, tool])),
    definitions: definitions(config),
    launcher,
  };
  const state = { initialized: false, ready: false };
  let pending = Buffer.alloc(0);
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.stdin.destroy();
  };
  const terminate = () => {
    stop();
    onStop();
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  process.stdout.on("error", terminate);
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
        void output({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Message too large" },
        });
        continue;
      }
      process.stdin.pause();
      void handle(server, line, state).finally(() => {
        if (!stopped) process.stdin.resume();
      });
    }
  });
}
