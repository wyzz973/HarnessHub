// SPDX-License-Identifier: MIT
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

// An engine substitute for the daemon's shared model gateway. It finds the
// gateway only in the native configuration prepareConfiguration wrote for its
// adapter, like the real engine: OpenCode speaks Chat, Claude Code speaks
// Anthropic Messages. A prompt containing BOTH also makes a Chat call with
// the same key. Upstream errors end the turn without text.
const adapter = process.argv[2] ?? "";
interface Endpoint {
  /** Chat base URL (with /v1) or Anthropic base URL (without). */
  url: string;
  token: string;
  model: string;
}
function endpoint(): Endpoint {
  switch (adapter) {
    case "opencode": {
      const config = JSON.parse(
        process.env.OPENCODE_CONFIG_CONTENT ?? "{}",
      ) as {
        model: string;
        provider: { harnesshub: { options: { baseURL: string } } };
      };
      return {
        url: config.provider.harnesshub.options.baseURL,
        token: process.env.HARNESSHUB_PROVIDER_KEY ?? "",
        model: config.model.slice("harnesshub/".length),
      };
    }
    case "claude":
      return {
        url: process.env.ANTHROPIC_BASE_URL ?? "",
        token: process.env.ANTHROPIC_AUTH_TOKEN ?? "",
        model: process.env.ANTHROPIC_MODEL ?? "",
      };
    default:
      throw new Error("Unknown fixture adapter");
  }
}

async function chat(base: string, token: string, model: string, text: string) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return body.choices[0]?.message.content ?? "";
}
async function messages(
  base: string,
  token: string,
  model: string,
  text: string,
) {
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { content: { text?: string }[] };
  return body.content.map((block) => block.text ?? "").join("");
}

new AgentSideConnection(
  (connection) => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {},
    }),
    authenticate: async () => ({}),
    newSession: async () => {
      const target = endpoint();
      await writeFile(
        join(process.cwd(), `shared-peer-${adapter}-${process.pid}.json`),
        JSON.stringify({
          adapter,
          pid: process.pid,
          ...target,
          env: Object.keys(process.env),
        }),
      );
      // Like the real engines, advertise the natively configured selection.
      const selected =
        adapter === "opencode" ? `harnesshub/${target.model}` : target.model;
      return {
        sessionId: `shared-peer-${adapter}`,
        models: {
          currentModelId: selected,
          availableModels: [{ modelId: selected, name: target.model }],
        },
      };
    },
    cancel: async () => undefined,
    prompt: async (request) => {
      const text = request.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.includes("NO_MODEL")) return { stopReason: "end_turn" };
      const target = endpoint();
      const answers =
        adapter === "claude"
          ? [
              await messages(target.url, target.token, target.model, text),
              ...(text.includes("BOTH")
                ? [
                    await chat(
                      `${target.url}/v1`,
                      target.token,
                      target.model,
                      text,
                    ),
                  ]
                : []),
            ]
          : [await chat(target.url, target.token, target.model, text)];
      if (answers.some((answer) => answer === undefined))
        return { stopReason: "end_turn" };
      await connection.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: answers.join("") },
        },
      });
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
