// SPDX-License-Identifier: MIT
/**
 * Copilot host: runs GitHub's Copilot SDK for one Copilot account of
 * HarnessHub and drives the Copilot CLI the user installed. The daemon starts
 * it (packages/daemon/src/copilot.ts) and talks JSON lines on stdin and
 * stdout; the protocol is documented there. The SDK is an optional add-on
 * that the user installs; this program imports it from the add-on directory
 * named in `start`, so it is not part of HarnessHub's own dependencies.
 *
 * Sessions identify as HarnessHub (`clientName`); nothing here copies another
 * client's identity. With `auth: "login"` the CLI uses its own sign-in, which
 * this program never reads; with `auth: "token"` the user's fine-grained token
 * goes to the SDK, which hands it to the CLI in an environment variable. No
 * token is ever written to stdout or stderr.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** SDK events this program forwards, by type, as the daemon's event shapes. */
const EVENTS = {
  "assistant.message_delta": (data) =>
    data.parentToolCallId
      ? undefined
      : { type: "delta", text: data.deltaContent ?? "" },
  "assistant.reasoning_delta": (data) => ({
    type: "reasoning",
    text: data.deltaContent ?? "",
  }),
  "assistant.message": (data) =>
    data.parentToolCallId
      ? undefined
      : {
          type: "message",
          text: data.content ?? "",
          toolRequests: (data.toolRequests ?? []).map((request) => ({
            toolCallId: request.toolCallId,
            name: request.name,
            arguments:
              typeof request.arguments === "string"
                ? request.arguments
                : JSON.stringify(request.arguments ?? {}),
          })),
        },
  "external_tool.requested": (data) => ({
    type: "tool",
    requestId: data.requestId,
    toolCallId: data.toolCallId,
  }),
  "assistant.usage": (data) =>
    data.parentToolCallId
      ? undefined
      : {
          type: "usage",
          usage: {
            ...(data.inputTokens !== undefined
              ? { input: data.inputTokens }
              : {}),
            ...(data.outputTokens !== undefined
              ? { output: data.outputTokens }
              : {}),
            ...(data.cacheReadTokens !== undefined
              ? { cacheRead: data.cacheReadTokens }
              : {}),
            ...(data.cacheWriteTokens !== undefined
              ? { cacheWrite: data.cacheWriteTokens }
              : {}),
            ...(data.reasoningTokens !== undefined
              ? { reasoning: data.reasoningTokens }
              : {}),
          },
        },
  "session.error": (data) => ({
    type: "error",
    message: String(data.message ?? "Copilot reported an error").slice(0, 1000),
    ...(typeof data.statusCode === "number" ? { status: data.statusCode } : {}),
    ...(data.errorCode || data.errorType
      ? { code: String(data.errorCode ?? data.errorType) }
      : {}),
  }),
  "session.idle": (data) => ({ type: "idle", aborted: data.aborted === true }),
  "session.shutdown": () => ({
    type: "closed",
    message: "The Copilot session shut down",
  }),
};

class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let client;
let sdk;
let start;
const sessions = new Map();

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** The SDK's ES module entry, from its package.json `exports`. */
async function importSdk(directory) {
  const root = path.join(directory, "node_modules", "@github", "copilot-sdk");
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
  } catch {
    throw new HostError(
      "sdk_missing",
      "The Copilot SDK is not installed; run hh subscription setup copilot",
    );
  }
  const main = manifest.exports?.["."];
  const entry =
    typeof main === "string"
      ? main
      : typeof main?.import === "string"
        ? main.import
        : (main?.import?.default ?? manifest.module ?? manifest.main);
  if (typeof entry !== "string")
    throw new HostError(
      "sdk_missing",
      "The Copilot SDK package has no ES module entry",
    );
  const module = await import(pathToFileURL(path.join(root, entry)).href);
  if (
    typeof module.CopilotClient !== "function" ||
    typeof module.RuntimeConnection?.forStdio !== "function"
  )
    throw new HostError(
      "sdk_missing",
      "The installed package is not a supported Copilot SDK",
    );
  return {
    module,
    version:
      typeof manifest.version === "string" ? manifest.version : undefined,
  };
}

const METHODS = {
  async start(params) {
    if (client) throw new HostError("unavailable", "Already started");
    start = params;
    sdk = await importSdk(params.sdk);
    if (!params.cli)
      throw new HostError(
        "cli_missing",
        "The Copilot CLI was not found on PATH; install it from GitHub",
      );
    const token = params.auth === "token";
    client = new sdk.module.CopilotClient({
      connection: sdk.module.RuntimeConnection.forStdio({ path: params.cli }),
      // The user's own CLI setup with its login; an isolated home with a token.
      mode: token ? "empty" : "copilot-cli",
      ...(token
        ? {
            gitHubToken: params.token,
            useLoggedInUser: false,
            baseDirectory: params.home,
          }
        : {}),
      workingDirectory: params.workDirectory,
      logLevel: "error",
    });
    try {
      await client.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      client = undefined;
      throw new HostError(
        /protocol/i.test(message) ? "cli_unsupported" : "unavailable",
        message.slice(0, 500),
      );
    }
    return { sdkVersion: sdk.version };
  },

  async status() {
    const status = await started().getAuthStatus();
    return {
      authenticated: status.isAuthenticated === true,
      ...(typeof status.login === "string" ? { login: status.login } : {}),
      ...(typeof status.host === "string" ? { host: status.host } : {}),
      ...(typeof status.authType === "string"
        ? { authType: status.authType }
        : {}),
      ...(typeof status.statusMessage === "string"
        ? { message: status.statusMessage.slice(0, 500) }
        : {}),
    };
  },

  async models() {
    const models = await started().listModels();
    return models.map((model) => ({
      id: model.id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      vision: model.capabilities?.supports?.vision === true,
      reasoning: model.capabilities?.supports?.reasoningEffort === true,
      ...(typeof model.capabilities?.limits?.max_context_window_tokens ===
      "number"
        ? { contextWindow: model.capabilities.limits.max_context_window_tokens }
        : {}),
      ...(typeof model.capabilities?.limits?.max_output_tokens === "number"
        ? { maxOutput: model.capabilities.limits.max_output_tokens }
        : {}),
      enabled: model.policy === undefined || model.policy.state === "enabled",
    }));
  },

  async quota() {
    const result = await started().rpc.account.getQuota({});
    return Object.entries(result?.quotaSnapshots ?? {}).flatMap(
      ([name, snapshot]) =>
        snapshot
          ? [
              {
                name,
                unlimited: snapshot.isUnlimitedEntitlement === true,
                remainingPercentage: snapshot.remainingPercentage,
                ...(typeof snapshot.resetDate === "string"
                  ? { resetDate: snapshot.resetDate }
                  : {}),
              },
            ]
          : [],
    );
  },

  async open(params) {
    const session = await started().createSession({
      clientName: "HarnessHub",
      model: params.model,
      ...(params.reasoningEffort
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
      streaming: true,
      // The caller's own system prompt, as the SDK documents for full control.
      systemMessage: { mode: "replace", content: params.system },
      // The caller's functions are the only tools; the caller runs them.
      tools: params.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters ?? { type: "object", properties: {} },
        overridesBuiltInTool: true,
        skipPermission: true,
        defer: "never",
      })),
      availableTools: params.tools.map((tool) => tool.name),
      workingDirectory: start.workDirectory,
      configDirectory: start.stateDirectory,
      enableConfigDiscovery: false,
      enableSessionStore: false,
      includedBuiltinSkills: [],
      infiniteSessions: { enabled: false },
      onPermissionRequest: () => ({
        kind: "denied-no-approval-rule-and-could-not-request-from-user",
      }),
    });
    const id = session.sessionId;
    sessions.set(id, session);
    session.on((event) => {
      if (event.agentId) return;
      const data = EVENTS[event.type]?.(event.data ?? {});
      if (data) write({ event: "session", session: id, data });
    });
    return { session: id };
  },

  async send(params) {
    await session(params.session).send({
      prompt: params.prompt,
      ...(params.attachments?.length
        ? {
            attachments: params.attachments.map((item) => ({
              type: "blob",
              data: item.data,
              mimeType: item.mimeType,
            })),
          }
        : {}),
    });
    return {};
  },

  async answer(params) {
    await session(params.session).rpc.tools.handlePendingToolCall({
      requestId: params.requestId,
      ...(params.error !== undefined
        ? { error: params.error }
        : { result: params.text ?? "" }),
    });
    return {};
  },

  async abort(params) {
    await session(params.session).abort();
    return {};
  },

  async close(params) {
    const found = sessions.get(params.session);
    sessions.delete(params.session);
    if (found) await found.disconnect();
    return {};
  },
};

function started() {
  if (!client)
    throw new HostError("unavailable", "The Copilot client is not started");
  return client;
}

function session(id) {
  const found = sessions.get(id);
  if (!found) throw new HostError("unavailable", "No such Copilot session");
  return found;
}

async function stop() {
  const current = client;
  client = undefined;
  if (current) await current.stop().catch(() => undefined);
  process.exit(0);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const method = METHODS[request?.method];
  if (!method) {
    write({
      id: request?.id,
      error: { code: "unavailable", message: "Unknown method" },
    });
    return;
  }
  Promise.resolve()
    .then(() => method(request.params ?? {}))
    .then(
      (result) => write({ id: request.id, result }),
      (error) =>
        write({
          id: request.id,
          error: {
            code: error instanceof HostError ? error.code : "unavailable",
            message: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 500),
          },
        }),
    );
});
lines.on("close", () => void stop());
