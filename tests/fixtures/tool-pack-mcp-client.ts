import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type test from "node:test";
import type { EngineMcpServer } from "../../src/domain/engine-configuration.js";
import { SESSION_WORKSPACE_PLACEHOLDER } from "../../src/tool-packages/index.js";

export interface McpResponse {
  jsonrpc: string;
  id: number | null;
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/**
 * What the Worker does before starting a Tool Pack MCP server (ADR 0013):
 * every placeholder occurrence in args and env values becomes the Session
 * directory. Tests use it to launch bound servers as a Session would.
 */
export function substituteSessionWorkspace(
  server: EngineMcpServer,
  workspace: string,
): { command: string; args: string[]; env: Record<string, string> } {
  assert.equal(server.type, "stdio");
  const replace = (value: string) =>
    value.replaceAll(SESSION_WORKSPACE_PLACEHOLDER, workspace);
  return {
    command: server.command!,
    args: (server.args ?? []).map(replace),
    env: Object.fromEntries(
      Object.entries(server.env ?? {}).map(([name, value]) => [
        name,
        replace(value),
      ]),
    ),
  };
}

/** Line-delimited JSON-RPC client owning one stdio MCP server process. */
export function startMcp(
  t: test.TestContext,
  launch: { command: string; args: string[]; env: Record<string, string> },
) {
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  const pending = new Map<number, (response: McpResponse) => void>();
  let buffered = "";
  let stderr = "";
  let sequence = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    stderr += text;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    buffered += text;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const response = JSON.parse(buffered.slice(0, newline)) as McpResponse;
      buffered = buffered.slice(newline + 1);
      if (typeof response.id === "number") pending.get(response.id)?.(response);
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited.catch(() => undefined);
    }
  });
  const request = (method: string, params?: unknown) =>
    new Promise<McpResponse>((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${stderr}`));
      }, 10_000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(response);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  return {
    child,
    request,
    stderr: () => stderr,
    async initialize() {
      const reply = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "harnesshub-tool-pack-test", version: "1" },
      });
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      return reply;
    },
    /** Calls one tool and returns its parsed JSON text content. */
    async call(name: string, args: unknown = {}) {
      const reply = await request("tools/call", { name, arguments: args });
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      return {
        isError: reply.result?.isError === true,
        text: reply.result!.content![0]!.text,
      };
    },
    /** Ends stdin and waits for a clean exit. */
    async close() {
      child.stdin.end();
      return exited;
    },
    exited,
  };
}
