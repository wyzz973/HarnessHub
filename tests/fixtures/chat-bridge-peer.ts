import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import {
  object,
  array,
  string,
} from "../../src/drivers/chat-completions/protocol.js";

const wire = process.argv[2];
let baseUrl = process.env.GOOGLE_GEMINI_BASE_URL ?? "";
if (wire === "codex") {
  const config = await readFile(
    join(process.env.CODEX_HOME!, "config.toml"),
    "utf8",
  );
  const line = config
    .split("\n")
    .find((line) => line.startsWith("base_url = "));
  if (!line) throw new Error("Missing bridge URL");
  baseUrl = JSON.parse(line.slice(11)) as string;
}
const token = process.env.HARNESSHUB_PROVIDER_KEY!;
await writeFile(
  join(process.cwd(), `peer-${process.pid}.json`),
  JSON.stringify({ url: baseUrl, pid: process.pid }),
);
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
      mcpCount = request.mcpServers.length;
      return {
        sessionId: "bridge-peer",
        models: {
          currentModelId: "fixture",
          availableModels: [{ modelId: "fixture", name: "Fixture" }],
        },
      };
    },
    setSessionModel: async () => ({}),
    cancel: async () => {
      controller?.abort();
    },
    prompt: async (request) => {
      controller = new AbortController();
      const text =
        request.prompt
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") + ` MCP_COUNT=${mcpCount}`;
      const input: Record<string, unknown>[] =
        wire === "codex"
          ? [{ role: "user", content: text }]
          : [{ role: "user", parts: [{ text }] }];
      const invoke = async () => {
        const response = await fetch(
          baseUrl +
            (wire === "codex"
              ? "/responses"
              : "/v1beta/models/fixture:generateContent"),
          {
            method: "POST",
            signal: controller!.signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(
              wire === "codex"
                ? {
                    model: "fixture",
                    input,
                    stream: false,
                    tools: [
                      {
                        type: "function",
                        name: "fixture_write",
                        parameters: {
                          type: "object",
                          properties: { text: { type: "string" } },
                          required: ["text"],
                        },
                      },
                    ],
                  }
                : {
                    contents: input,
                    tools: [
                      {
                        functionDeclarations: [
                          {
                            name: "fixture_write",
                            parameters: {
                              type: "OBJECT",
                              properties: { text: { type: "STRING" } },
                              required: ["text"],
                            },
                          },
                        ],
                      },
                    ],
                  },
            ),
          },
        );
        if (!response.ok) throw new Error("Bridge fixture request failed");
        return object(await response.json());
      };
      try {
        const response = await invoke();
        let name: string, id: string, args: Record<string, unknown>;
        if (wire === "codex") {
          const call = object(
            array(response.output).find(
              (item) => object(item).type === "function_call",
            ),
          );
          name = string(call.name);
          id = string(call.call_id);
          args = object(JSON.parse(string(call.arguments)));
        } else {
          const candidate = object(array(response.candidates)[0]);
          const parts = array(object(candidate.content).parts);
          const google = object(
            object(parts.find((p) => object(p).functionCall)).functionCall,
          );
          name = string(google.name);
          id = string(google.id);
          args = object(google.args);
        }
        const decision = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: id, title: "Write fixture artifact" },
          options: [
            { optionId: "write-once", kind: "allow_once", name: "Write once" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
        });
        if (
          decision.outcome.outcome !== "selected" ||
          decision.outcome.optionId !== "write-once"
        )
          return { stopReason: "refusal" };
        await writeFile(
          join(process.cwd(), `${wire}-proof.txt`),
          string(args.text),
        );
        if (wire === "codex")
          input.push(
            {
              type: "function_call",
              name,
              call_id: id,
              arguments: JSON.stringify(args),
            },
            { type: "function_call_output", call_id: id, output: "written" },
          );
        else
          input.push(
            { role: "model", parts: [{ functionCall: { name, id, args } }] },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name,
                    id,
                    response: { output: "written" },
                  },
                },
              ],
            },
          );
        const final = await invoke();
        const output =
          wire === "codex"
            ? string(
                object(array(object(array(final.output)[0]).content)[0]).text,
              )
            : string(
                object(
                  array(
                    object(object(array(final.candidates)[0]).content).parts,
                  )[0],
                ).text,
              );
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: output },
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
