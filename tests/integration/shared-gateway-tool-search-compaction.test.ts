// SPDX-License-Identifier: MIT
/**
 * Codex's tool search and compaction, Claude Code's ToolSearch results and
 * sealed reasoning, through the daemon's real gateway to the strict fake
 * provider in whitelist mode: a Responses item or tool field the upstream
 * does not know (`execution`, `tools`, `defer_loading`) is a violation there,
 * and a seal it did not issue is refused as OpenAI refuses it.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "synthetic-toolsearch-upstream-canary-71c4";
const MODEL = "upstream-sim";
/** Has only a Responses endpoint: Responses requests pass through. */
const RESPONSES = `up-responses/${MODEL}`;
/** Has only a Chat endpoint: Responses and Anthropic requests are translated. */
const CHAT = `up-chat/${MODEL}`;
const SUMMARY = "SUMMARY: the user wants the parser fixed.";

const SEARCH_TOOL = {
  type: "tool_search",
  execution: "client",
  description: "Search the MCP tools Codex holds back.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};
const SHELL = {
  type: "function",
  name: "shell",
  description: "Run a command.",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
const FOUND = {
  type: "function",
  name: "create_issue",
  description: "Create an issue.",
  defer_loading: true,
  parameters: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
};

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

type Json = Record<string, unknown>;

/** Data of each server-sent event of a Responses stream. */
function events(text: string): Json[] {
  return text
    .split(/\n\n/)
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Json);
}

/** The output items of a Responses answer, streamed (`output_item.done`) or whole. */
function outputItems(text: string, stream: boolean): Json[] {
  if (!stream) return (JSON.parse(text) as { output: Json[] }).output;
  return events(text)
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item as Json);
}

async function setup(t: test.TestContext) {
  const fake = await startFakeProvider({
    mode: "whitelist",
    models: [MODEL],
    keys: { upstream: UPSTREAM_KEY },
    // Translated Chat calls ask for streamed usage; declared, not hidden.
    fields: { chat: { declared: { topLevel: ["stream_options"] } } },
    chunkDelayMs: 0,
    quirks: { foreignSeals: true },
    script: {
      turns: [
        // A model that writes no summary, with or without reasoning.
        {
          when: { contains: "EMPTY-SUMMARY" },
          repeat: true,
          text: "",
          usage: { input: 500, output: 3 },
        },
        {
          when: { contains: "THINK-ONLY" },
          repeat: true,
          reasoning: "Only thinking, no summary.",
          text: "",
          usage: { input: 500, output: 3 },
        },
        // Tools sent with a compaction request would be no summary.
        {
          when: {
            contains: "CONTEXT CHECKPOINT COMPACTION",
            offersTool: "shell",
          },
          repeat: true,
          text: "TOOLS-LEAKED",
        },
        {
          when: { contains: "CONTEXT CHECKPOINT COMPACTION" },
          repeat: true,
          text: ["SUMMARY: the user wants ", "the parser fixed."],
          usage: { input: 900, output: 12 },
        },
        { when: { contains: SUMMARY }, repeat: true, text: "RESUMED" },
        // The tools a search found are offered, and its result read.
        {
          when: {
            toolResultContains:
              "These tools are now available to call: create_issue",
            offersTool: "create_issue",
          },
          repeat: true,
          toolCalls: [{ name: "create_issue", arguments: { title: "Bug" } }],
        },
        {
          when: {
            contains: "FIND-TOOLS",
            offersTool: "tool_search",
            toolResult: false,
          },
          repeat: true,
          toolCalls: [{ name: "tool_search", arguments: { query: "issues" } }],
        },
        {
          when: { offersTool: "DeferredToolPlaceholder" },
          repeat: true,
          text: "PLACEHOLDER-LEAKED",
        },
        {
          when: {
            toolResultContains:
              "Tool mcp__github__create_issue is loaded and can be called now.",
          },
          repeat: true,
          text: "LOADED",
        },
        { when: { contains: "SEALED-" }, repeat: true, text: "UNSEALED" },
      ],
    },
  });
  t.after(() => fake.close());
  const { directory, defer } = await temporaryDirectory(t, "hh-toolsearch-");
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  const models = {
    source: "manual" as const,
    list: [{ id: MODEL }],
    expose: "all" as const,
  };
  const credential = { value: UPSTREAM_KEY };
  await client.providers.create({
    id: "up-responses",
    endpoints: { responses: `${fake.url}/v1` },
    models,
    credential,
  });
  await client.providers.create({
    id: "up-chat",
    endpoints: { chat: `${fake.url}/v1` },
    models,
    credential,
  });
  const key = (
    await client.gatewayKeys.create({
      name: "toolsearch",
      modelAllow: ["up-responses/*", "up-chat/*"],
    })
  ).key;
  return { fake, hub, client, key };
}

async function call(
  url: string,
  key: string,
  route: string,
  body: Json,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url + route, {
    method: "POST",
    headers:
      route === "/v1/messages"
        ? {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          }
        : {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/** The newest ledger entry. */
async function latest(client: HarnessHubClient) {
  const entry = (await client.modelCalls.list({ limit: 1 })).items[0];
  assert.ok(entry);
  return entry;
}

void test(
  "Codex's tool search, its compaction and sealed reasoning reach strict upstreams as they can take them",
  { timeout: 120_000 },
  async (t) => {
    const { fake, hub, client, key } = await setup(t);

    for (const [model, stream] of [
      [RESPONSES, true],
      [RESPONSES, false],
      [CHAT, true],
      [CHAT, false],
    ] as const) {
      const where = `${model} stream=${stream}`;
      await t.test(`tool search: ${where}`, async () => {
        const first = {
          model,
          stream,
          tools: [SHELL, SEARCH_TOOL],
          input: [user("FIND-TOOLS for issues")],
        };
        const searched = await call(hub.url, key, "/v1/responses", first);
        assert.equal(searched.status, 200, searched.text);
        const items = outputItems(searched.text, stream);
        const search = items.find((item) => item.type === "tool_search_call");
        assert.ok(search, `${where}: ${searched.text}`);
        assert.equal(search.execution, "client");
        assert.deepEqual(search.arguments, { query: "issues" });
        assert.equal(search.name, undefined);
        assert.ok(
          !items.some((item) => item.type === "function_call"),
          "no function call is left for Codex to run",
        );
        if (model === CHAT) assert.match(String(search.id), /^tsc_/);
        const entry = await latest(client);
        assert.equal(
          entry.mode,
          model === RESPONSES ? "passthrough" : "translated",
        );
        if (model === RESPONSES)
          assert.ok(entry.patches.includes("tool-search:function"), where);

        // Codex ran the search and found a deferred tool.
        const callId = String(search.call_id);
        const followed = await call(hub.url, key, "/v1/responses", {
          ...first,
          input: [
            ...first.input,
            {
              type: "tool_search_call",
              id: search.id,
              call_id: callId,
              status: "completed",
              execution: "client",
              arguments: search.arguments,
            },
            {
              type: "tool_search_output",
              call_id: callId,
              status: "completed",
              execution: "client",
              tools: [FOUND],
            },
          ],
        });
        assert.equal(followed.status, 200, followed.text);
        const calls = outputItems(followed.text, stream).filter(
          (item) => item.type === "function_call",
        );
        assert.deepEqual(
          calls.map((item) => [item.name, JSON.parse(String(item.arguments))]),
          [["create_issue", { title: "Bug" }]],
          where,
        );
      });

      await t.test(`compaction: ${where}`, async () => {
        const compacted = await call(hub.url, key, "/v1/responses", {
          model,
          stream,
          tools: [SHELL],
          tool_choice: "auto",
          parallel_tool_calls: true,
          input: [
            user("fix the parser"),
            assistant("On it."),
            { type: "compaction_trigger" },
          ],
        });
        assert.equal(compacted.status, 200, compacted.text);
        const items = outputItems(compacted.text, stream);
        assert.deepEqual(items.length, 1, compacted.text);
        const item = items[0]!;
        assert.equal(item.type, "compaction");
        assert.match(String(item.id), /^cmp_/);
        assert.equal(
          item.encrypted_content,
          `hh1:${Buffer.from(SUMMARY).toString("base64")}`,
        );
        if (stream) {
          const seen = events(compacted.text);
          assert.equal(seen[0]!.type, "response.created");
          assert.ok(
            !seen.some((event) => event.type === "response.output_text.delta"),
            "the summary is not shown as a message",
          );
          const completed = seen.at(-1)!;
          assert.equal(completed.type, "response.completed");
          const response = completed.response as Json;
          assert.deepEqual(response.output, [item]);
          assert.equal((response.usage as Json).output_tokens, 12);
        }
        const entry = await latest(client);
        assert.ok(entry.patches.includes("compaction:summary"), where);
        assert.equal(entry.usage?.output, 12);

        // Codex resumes from the compaction it got.
        const resumed = await call(hub.url, key, "/v1/responses", {
          model,
          stream,
          input: [item, user("continue")],
        });
        assert.equal(resumed.status, 200, resumed.text);
        const reply = outputItems(resumed.text, stream).find(
          (output) => output.type === "message",
        );
        assert.deepEqual(
          (reply?.content as Json[] | undefined)?.map((part) => part.text),
          ["RESUMED"],
          resumed.text,
        );
        assert.ok(
          (await latest(client)).patches.includes("compaction:restored:1"),
        );
      });

      await t.test(`compaction without a summary: ${where}`, async () => {
        for (const marker of ["EMPTY-SUMMARY", "THINK-ONLY"]) {
          const failed = await call(hub.url, key, "/v1/responses", {
            model,
            stream,
            input: [user(`${marker} fix it`), { type: "compaction_trigger" }],
          });
          // Failed before any byte went out, or in the stream after.
          const error =
            failed.status === 502
              ? (JSON.parse(failed.text) as { error: Json }).error
              : ((
                  events(failed.text).find(
                    (event) => event.type === "response.failed",
                  )?.response as Json | undefined
                )?.error as Json | undefined);
          assert.ok(
            failed.status === 502 || (stream && failed.status === 200),
            `${marker}: ${failed.status} ${failed.text}`,
          );
          assert.equal(
            error?.message,
            "compaction: the model wrote no summary",
            `${marker}: ${failed.text}`,
          );
          assert.doesNotMatch(failed.text, /"type":"compaction"/);
          const entry = await latest(client);
          assert.deepEqual(
            [entry.status, entry.errorClass, entry.errorSource],
            [502, "compaction_empty", "gateway"],
            marker,
          );
          assert.equal(entry.error, "compaction: the model wrote no summary");
          assert.equal(entry.usage?.output, 3, "the upstream's usage counts");
          assert.ok(entry.patches.includes("compaction:summary"));
        }
      });
    }

    await t.test(
      "sealed reasoning and compactions refused as another's are left out and asked again",
      async () => {
        const cases = [
          {
            marker: "SEALED-REASONING",
            history: [
              user("first"),
              {
                type: "reasoning",
                id: "rs_other",
                summary: [],
                encrypted_content: "gAAAA-another-account",
              },
              assistant("done"),
            ],
            patch: "sealed:reasoning",
            attempts: 2,
          },
          {
            marker: "SEALED-COMPACTION",
            history: [
              {
                type: "compaction",
                id: "cmp_openai",
                encrypted_content: "gAAAA-openai-compaction",
              },
            ],
            patch: "sealed:compaction",
            attempts: 2,
          },
          {
            // Reasoning a translated answer carried never goes upstream.
            marker: "SEALED-OWN",
            history: [
              user("first"),
              {
                type: "reasoning",
                id: "rs_hh",
                summary: [{ type: "summary_text", text: "think" }],
                encrypted_content: `hh-r1.${Buffer.from("think").toString("base64url")}`,
              },
              assistant("done"),
            ],
            patch: "reasoning:dropped:1",
            attempts: 1,
          },
        ];
        for (const { marker, history, patch, attempts } of cases) {
          const before = fake.records().length;
          const answer = await call(hub.url, key, "/v1/responses", {
            model: RESPONSES,
            stream: true,
            input: [...history, user(marker)],
          });
          assert.equal(answer.status, 200, answer.text);
          assert.match(answer.text, /UNSEALED/, marker);
          const entry = await latest(client);
          assert.ok(
            entry.patches.includes(patch),
            `${marker}: ${entry.patches.join()}`,
          );
          assert.equal(entry.attempts.length, attempts, marker);
          await fake.idle();
          const records = fake.records().slice(before);
          assert.deepEqual(
            records.map((record) => [record.status, record.turn]),
            attempts === 2
              ? [
                  [400, "foreign-seal"],
                  [200, "script"],
                ]
              : [[200, "script"]],
            marker,
          );
          if (attempts === 2) {
            assert.equal(entry.attempts[0]!.status, 400);
            assert.equal(entry.attempts[0]!.decision, "retry");
            assert.equal(entry.attempts[1]!.decision, "success");
          }
        }
      },
    );

    await t.test(
      "Claude Code's ToolSearch results reach a Chat upstream as text",
      async () => {
        const answer = await call(hub.url, key, "/v1/messages", {
          model: CHAT,
          max_tokens: 256,
          stream: false,
          tools: [
            {
              name: "ToolSearch",
              description: "Load deferred tools.",
              input_schema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
            {
              name: "mcp__github__create_issue",
              description: "Create an issue.",
              input_schema: { type: "object", properties: {} },
              defer_loading: true,
            },
            {
              name: "DeferredToolPlaceholder",
              description: "",
              input_schema: { type: "object", properties: {} },
            },
          ],
          messages: [
            { role: "user", content: "file an issue" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "ToolSearch",
                  input: { query: "select:mcp__github__create_issue" },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_1",
                  content: [
                    {
                      type: "tool_reference",
                      tool_name: "mcp__github__create_issue",
                    },
                  ],
                },
              ],
            },
          ],
        });
        assert.equal(answer.status, 200, answer.text);
        const content = (JSON.parse(answer.text) as { content: Json[] })
          .content;
        assert.deepEqual(
          content.map((block) => block.text),
          ["LOADED"],
        );
      },
    );

    await t.test(
      "/v1/responses/compact is refused with a pointer to compaction_trigger",
      async () => {
        const before = fake.records().length;
        const answer = await call(hub.url, key, "/v1/responses/compact", {
          model: RESPONSES,
          input: [user("hi")],
        });
        assert.equal(answer.status, 400);
        const error = (JSON.parse(answer.text) as { error: Json }).error;
        assert.equal(error.code, "compact_unsupported");
        assert.equal(
          error.message,
          "/responses/compact is not supported for HarnessHub models; use a compaction_trigger on /responses",
        );
        const entry = await latest(client);
        assert.equal(entry.rejected, true);
        assert.equal(entry.inbound.path, "/v1/responses/compact");
        await fake.idle();
        assert.equal(fake.records().length, before, "nothing went upstream");
      },
    );

    await fake.idle();
    assert.deepEqual(fake.violations(), []);
  },
);
