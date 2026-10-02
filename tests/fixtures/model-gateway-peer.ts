import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";

// A Chat-protocol engine substitute. It finds the model endpoint only in the
// native configuration that prepareConfiguration wrote for its adapter, like
// the real engine would, and behaves like OpenCode/Pi on upstream errors: the
// turn ends normally without text.
const adapter = process.argv[2] ?? "";
// Diagnostics fixture mode: stderr lines (one carrying the Session token as plain
// text, one multibyte) and ACP tool_call status updates for the engine log tests.
const logCanary = process.argv[3] === "log-canary";
interface Endpoint {
  url: string;
  token: string;
  model: string;
}
async function endpoint(): Promise<Endpoint> {
  const token = process.env.HARNESSHUB_PROVIDER_KEY ?? "";
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
        token,
        model: config.model.slice("harnesshub/".length),
      };
    }
    case "qwen":
      return {
        url: process.env.OPENAI_BASE_URL ?? "",
        token: process.env.OPENAI_API_KEY ?? "",
        model: process.env.OPENAI_MODEL ?? "",
      };
    case "pi": {
      const models = JSON.parse(
        await readFile(
          join(process.env.PI_CODING_AGENT_DIR ?? "", "models.json"),
          "utf8",
        ),
      ) as {
        providers: {
          harnesshub: {
            baseUrl: string;
            apiKey: string;
            models: { id: string }[];
          };
        };
      };
      const provider = models.providers.harnesshub;
      return {
        url: provider.baseUrl,
        token: process.env[provider.apiKey.replace(/^\$/, "")] ?? "",
        model: provider.models[0]!.id,
      };
    }
    default:
      throw new Error("Unknown fixture adapter");
  }
}
interface Completion {
  content: string;
  calls: { id: string; name: string; arguments: string }[];
}
async function completion(response: Response): Promise<Completion> {
  const text = await response.text();
  const result: Completion = { content: "", calls: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const chunk = JSON.parse(data) as {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    for (const choice of chunk.choices ?? []) {
      result.content += choice.delta?.content ?? "";
      for (const call of choice.delta?.tool_calls ?? []) {
        const target = (result.calls[call.index] ??= {
          id: "",
          name: "",
          arguments: "",
        });
        target.id += call.id ?? "";
        target.name += call.function?.name ?? "";
        target.arguments += call.function?.arguments ?? "";
      }
    }
  }
  return result;
}

let controller: AbortController | undefined;
let mcpCount = 0;
new AgentSideConnection(
  (connection) => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
    }),
    authenticate: async () => ({}),
    newSession: async (request) => {
      if (adapter === "auth-failure")
        throw RequestError.authRequired(
          { message: "fixture engine has no native login" },
          "use the configured gateway",
        );
      mcpCount = request.mcpServers.length;
      const target = await endpoint();
      if (logCanary)
        process.stderr.write(
          `fixture diagnostics: gateway credential in use ${target.token}\n诊断 stderr 多字节行\n`,
        );
      await writeFile(
        join(process.cwd(), `gateway-peer-${adapter}-${process.pid}.json`),
        JSON.stringify({
          adapter,
          pid: process.pid,
          url: target.url,
          token: target.token,
          model: target.model,
          home: process.env.HOME ?? process.env.USERPROFILE ?? "",
          env: Object.keys(process.env),
          mcp: request.mcpServers.map((server) =>
            "url" in server
              ? [server.url]
              : "command" in server
                ? [server.command, ...server.args]
                : [server.name],
          ),
        }),
      );
      // Like the real engines, advertise the natively configured selection.
      const selected =
        adapter === "qwen"
          ? `$runtime|openai|${target.model}(openai)`
          : `harnesshub/${target.model}`;
      return {
        sessionId: `gateway-peer-${adapter}`,
        models: {
          currentModelId: selected,
          availableModels: [{ modelId: selected, name: target.model }],
        },
      };
    },
    cancel: async () => {
      controller?.abort();
    },
    prompt: async (request) => {
      controller = new AbortController();
      const text = request.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.includes("NO_MODEL")) return { stopReason: "end_turn" };
      const target = await endpoint();
      const messages: Record<string, unknown>[] = [
        { role: "user", content: `${text} MCP_COUNT=${mcpCount}` },
      ];
      const invoke = () =>
        fetch(`${target.url}/chat/completions`, {
          method: "POST",
          signal: controller!.signal,
          headers: {
            authorization: `Bearer ${target.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: target.model,
            messages,
            stream: true,
            tools: [
              {
                type: "function",
                function: {
                  name: "fixture_write",
                  parameters: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                  },
                },
              },
            ],
          }),
        });
      try {
        let response = await invoke();
        // Like OpenCode/Pi: a rejected model request ends the turn without text.
        if (!response.ok) {
          await response.text();
          return { stopReason: "end_turn" };
        }
        let result = await completion(response);
        const call = result.calls[0];
        if (call) {
          if (logCanary)
            await connection.sessionUpdate({
              sessionId: request.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: call.id,
                title: "Write fixture artifact",
                kind: "edit",
                status: "pending",
              },
            });
          const decision = await connection.requestPermission({
            sessionId: request.sessionId,
            toolCall: { toolCallId: call.id, title: "Write fixture artifact" },
            options: [
              { optionId: "write-once", kind: "allow_once", name: "Write" },
              { optionId: "reject", kind: "reject_once", name: "Reject" },
            ],
          });
          if (
            decision.outcome.outcome !== "selected" ||
            decision.outcome.optionId !== "write-once"
          )
            return { stopReason: "refusal" };
          const args = JSON.parse(call.arguments) as { text: string };
          await writeFile(
            join(process.cwd(), `${adapter}-proof.txt`),
            args.text,
          );
          if (logCanary)
            await connection.sessionUpdate({
              sessionId: request.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: call.id,
                status: "completed",
              },
            });
          messages.push(
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                },
              ],
            },
            { role: "tool", tool_call_id: call.id, content: "written" },
          );
          response = await invoke();
          if (!response.ok) {
            await response.text();
            return { stopReason: "end_turn" };
          }
          result = await completion(response);
        }
        if (result.content)
          await connection.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: result.content },
            },
          });
        return { stopReason: "end_turn" };
      } catch (error) {
        if (controller.signal.aborted) return { stopReason: "cancelled" };
        throw error;
      }
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
