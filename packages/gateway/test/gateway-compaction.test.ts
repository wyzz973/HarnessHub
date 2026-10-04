// SPDX-License-Identifier: MIT
/**
 * Conversation compaction: recognizing agents' compaction requests, Codex's
 * compaction served by the gateway, and sealed items an upstream refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { WireProtocol } from "@harnesshub/core/model-plane";
import {
  CODEX_COMPACT_PROMPT,
  CODEX_SUMMARY_PREFIX,
  CompactionReply,
  codexInput,
  isCompactionRequest,
  refusesSeal,
  unsealed,
  withoutOwnReasoning,
} from "../src/compacting.js";
import { encodeReasoning } from "../src/reasoning.js";

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

/** One compaction request per agent, as each sends it (prompts from their releases). */
const AGENTS: [string, WireProtocol, Record<string, unknown>][] = [
  [
    "Claude Code (auto-compact system prompt)",
    "anthropic",
    {
      system: [
        {
          type: "text",
          text: "You are a helpful AI assistant tasked with summarizing conversations.",
        },
      ],
      messages: [{ role: "user", content: "Summarize." }],
    },
  ],
  [
    "Claude Code /compact",
    "anthropic",
    {
      system: "You are Claude Code.",
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests.",
            },
          ],
        },
      ],
    },
  ],
  [
    "OpenCode",
    "chat",
    {
      messages: [
        {
          role: "system",
          content:
            "You are a context summarization agent. Produce a summary of the session.",
        },
        { role: "user", content: "go" },
      ],
    },
  ],
  [
    "Pi",
    "chat",
    {
      messages: [
        {
          role: "system",
          content: "You are a context summarization assistant.",
        },
        { role: "user", content: "<conversation>…</conversation>" },
      ],
    },
  ],
  [
    "Gemini CLI",
    "gemini",
    {
      systemInstruction: {
        parts: [
          {
            text: "You are a specialized system component responsible for distilling chat history into a structured XML <state_snapshot>.",
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: "First, reason." }] }],
    },
  ],
  [
    "Qwen Code",
    "chat",
    {
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "You are the component that summarizes a conversation when its context window is about to overflow.",
            },
          ],
        },
        { role: "user", content: "go" },
      ],
    },
  ],
  [
    "Codex (local compaction)",
    "responses",
    {
      instructions: "You are Codex.",
      input: [user("fix it"), assistant("Fixed."), user(CODEX_COMPACT_PROMPT)],
    },
  ],
  [
    "Codex (compaction_trigger)",
    "responses",
    { input: [user("fix it"), { type: "compaction_trigger" }] },
  ],
  [
    "Kimi Code",
    "chat",
    {
      messages: [
        { role: "system", content: "You are Kimi." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        {
          role: "user",
          content:
            "You are now given a task to compact this conversation context according to specific priorities.",
        },
      ],
    },
  ],
];

void test("each agent's compaction request is recognized, by its system prompt or its last user message", () => {
  for (const [agent, protocol, raw] of AGENTS)
    assert.equal(isCompactionRequest(protocol, raw), true, agent);
});

void test("ordinary requests, and compaction prompts outside the system or last user message, are not compactions", () => {
  const ask =
    "Your task is to create a detailed summary of the conversation so far";
  const cases: [string, WireProtocol, Record<string, unknown>][] = [
    [
      "a chat turn",
      "chat",
      { messages: [{ role: "user", content: "summarize this file" }] },
    ],
    [
      "the ask in an earlier user message",
      "anthropic",
      {
        messages: [
          { role: "user", content: ask },
          { role: "assistant", content: "Summary." },
          { role: "user", content: "thanks, now continue" },
        ],
      },
    ],
    [
      "the ask written by the assistant",
      "chat",
      {
        messages: [
          { role: "user", content: "what do you do?" },
          { role: "assistant", content: ask },
        ],
      },
    ],
    [
      "a Gemini model turn",
      "gemini",
      { contents: [{ role: "model", parts: [{ text: ask }] }] },
    ],
    [
      "Responses text input",
      "responses",
      { input: "hello", instructions: "You are Codex." },
    ],
    ["malformed messages", "chat", { messages: "not a list" }],
    ["no body", "gemini", {}],
  ];
  for (const [what, protocol, raw] of cases)
    assert.equal(isCompactionRequest(protocol, raw), false, what);
});

void test("a compaction_trigger becomes Codex's prompt without tools; the gateway's compactions become their summary", () => {
  const summary = "SUMMARY: the user asked for a fix.";
  const ours = {
    type: "compaction",
    id: "cmp_1",
    encrypted_content: `hh1:${Buffer.from(summary).toString("base64")}`,
  };
  const openai = {
    type: "compaction",
    id: "cmp_2",
    encrypted_content: "gAAAA-openai-sealed",
  };
  const raw = {
    model: "deepseek/deepseek-chat",
    tools: [{ type: "function", name: "shell" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    input: [ours, openai, user("go on"), { type: "compaction_trigger" }],
  };
  const served = codexInput(raw, true);
  assert.ok(served);
  assert.equal(served.summary, true);
  assert.equal(served.restored, 1);
  assert.deepEqual(served.raw, {
    model: "deepseek/deepseek-chat",
    input: [
      user(`${CODEX_SUMMARY_PREFIX}\n${summary}`),
      openai,
      user("go on"),
      user(CODEX_COMPACT_PROMPT),
    ],
  });
  // The trigger belongs to ChatGPT's backend for ChatGPT's own models.
  const relayed = codexInput(raw, false);
  assert.ok(relayed);
  assert.equal(relayed.summary, false);
  assert.deepEqual(relayed.raw.input, [
    user(`${CODEX_SUMMARY_PREFIX}\n${summary}`),
    openai,
    user("go on"),
    { type: "compaction_trigger" },
  ]);
  assert.deepEqual(relayed.raw.tools, raw.tools);
  assert.equal(codexInput({ input: [openai, user("hi")] }, true), undefined);
  assert.equal(codexInput({ input: "hi" }, true), undefined);
});

/** Server-sent events of a text, as `[type, data]`. */
function events(text: string): [string, Record<string, unknown>][] {
  return text
    .split("\n\n")
    .filter((block) => block.includes("data:"))
    .map((block) => {
      const data = JSON.parse(
        block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n"),
      ) as Record<string, unknown>;
      return [String(data.type), data];
    });
}

function frame(data: Record<string, unknown>): string {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

const USAGE = { input_tokens: 900, output_tokens: 40, total_tokens: 940 };
const STREAM = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp_abc", status: "in_progress", output: [] },
  },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: { id: "msg_1", type: "message", role: "assistant", content: [] },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 2,
    item_id: "msg_1",
    delta: "SUMMARY: ",
  },
  {
    type: "response.in_progress",
    sequence_number: 3,
    response: { id: "resp_abc", status: "in_progress", output: [] },
  },
  {
    type: "response.output_item.done",
    sequence_number: 4,
    output_index: 0,
    item: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "SUMMARY: fixed the bug." }],
    },
  },
  {
    type: "response.completed",
    sequence_number: 5,
    response: {
      id: "resp_abc",
      object: "response",
      status: "completed",
      model: "deepseek-chat",
      output: [],
      usage: USAGE,
    },
  },
];

void test("a streamed summary goes back as one hh1 compaction item; the stream's start and keepalives pass at once", () => {
  const reply = new CompactionReply("sse");
  const text = STREAM.map(frame).join("") + ": comment\n\n";
  let out = "";
  // Odd chunk boundaries, as bytes.
  const bytes = Buffer.from(text);
  for (let index = 0; index < bytes.length; index += 37)
    out += reply.push(bytes.subarray(index, index + 37));
  const early = out;
  out += reply.end();
  assert.deepEqual(
    events(early).map(([type]) => type),
    ["response.created", "response.in_progress"],
  );
  assert.match(early, /: comment\n\n/);
  const all = events(out);
  assert.deepEqual(
    all.map(([type]) => type),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ],
  );
  const item = {
    type: "compaction",
    id: "cmp_abc",
    encrypted_content: `hh1:${Buffer.from("SUMMARY: fixed the bug.").toString("base64")}`,
  };
  assert.deepEqual(all[2]![1], {
    type: "response.output_item.added",
    sequence_number: 6,
    output_index: 0,
    item,
  });
  assert.deepEqual(all[3]![1].item, item);
  const completed = all[4]![1].response as Record<string, unknown>;
  assert.deepEqual(completed.output, [item]);
  assert.deepEqual(completed.usage, USAGE);
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, "resp_abc");
  assert.equal(all[4]![1].sequence_number, 8);
});

void test("a failed stream, an error body or a reply without summary text is no compaction", () => {
  const failed = new CompactionReply("sse");
  const failure = {
    type: "response.failed",
    sequence_number: 1,
    response: { id: "resp_x", status: "failed", error: { message: "boom" } },
  };
  const text = frame(STREAM[0]!) + frame(failure);
  assert.equal(failed.push(text) + failed.end(), text);

  const error = new CompactionReply("sse");
  const body = JSON.stringify({ error: { message: "rate limited" } });
  assert.equal(error.push(body) + error.end(), body);

  const empty = new CompactionReply("sse");
  const blank = [
    STREAM[0]!,
    { ...STREAM[5]!, response: { id: "resp_abc", output: [], usage: USAGE } },
  ]
    .map(frame)
    .join("");
  const ended = events(empty.push(blank) + empty.end());
  assert.deepEqual(
    ended.map(([type]) => type),
    ["response.created", "response.failed"],
  );
  assert.deepEqual((ended[1]![1].response as Record<string, unknown>).error, {
    code: "server_error",
    message: "compaction: the model wrote no summary",
  });

  const json = new CompactionReply("json");
  const refusal = JSON.stringify({
    error: { message: "bad request", code: "invalid_prompt" },
  });
  assert.equal(json.push(refusal) + json.end(), refusal);
});

void test("a JSON summary becomes the response's only output item", () => {
  const reply = new CompactionReply("json");
  const body = {
    id: "resp_j",
    object: "response",
    status: "completed",
    output: [
      { id: "rs_1", type: "reasoning", summary: [] },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "SUMMARY" }],
      },
    ],
    usage: USAGE,
  };
  const out = JSON.parse(
    reply.push(JSON.stringify(body)) + reply.end(),
  ) as Record<string, unknown>;
  assert.deepEqual(out.output, [
    {
      type: "compaction",
      id: "cmp_j",
      encrypted_content: `hh1:${Buffer.from("SUMMARY").toString("base64")}`,
    },
  ]);
  assert.deepEqual(out.usage, USAGE);
});

void test("sealed reasoning refused as another's goes first, then sealed compactions", () => {
  assert.ok(
    refusesSeal(
      "The encrypted content for item rs_68ab could not be verified. Reason: organization mismatch.",
    ),
  );
  assert.ok(refusesSeal("Could not decrypt the provided encrypted_content"));
  assert.ok(refusesSeal("invalid_encrypted_content"));
  assert.ok(!refusesSeal("Rate limit reached"));
  assert.ok(
    !refusesSeal("Invalid 'input[3].id': expected an ID that begins with 'fc'"),
  );
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    summary: [],
    encrypted_content: "gAAAA-1",
  };
  const compaction = {
    type: "compaction",
    id: "cmp_1",
    encrypted_content: "gAAAA-2",
  };
  const raw = {
    model: "m",
    input: [compaction, user("a"), reasoning, assistant("b"), user("c")],
  };
  const first = unsealed(raw, 0);
  assert.deepEqual(first, {
    raw: {
      model: "m",
      input: [compaction, user("a"), assistant("b"), user("c")],
    },
    step: 1,
    kind: "reasoning",
  });
  const second = unsealed(first.raw, first.step);
  assert.deepEqual(second, {
    raw: { model: "m", input: [user("a"), assistant("b"), user("c")] },
    step: 2,
    kind: "compaction",
  });
  assert.equal(unsealed(second.raw, second.step), undefined);
  // Without reasoning, the compaction goes at once; with neither, nothing does.
  assert.equal(
    unsealed({ input: [compaction, user("a")] }, 0)?.kind,
    "compaction",
  );
  assert.equal(unsealed({ input: [user("a")] }, 0), undefined);
});

void test("reasoning the gateway encoded itself is never relayed to a Responses upstream", () => {
  const own = {
    type: "reasoning",
    id: "rs_hh",
    summary: [{ type: "summary_text", text: "think" }],
    encrypted_content: encodeReasoning("think"),
  };
  const sealed = { ...own, id: "rs_up", encrypted_content: "gAAAA-up" };
  const body = Buffer.from(
    JSON.stringify({ model: "m", input: [user("a"), own, sealed, user("b")] }),
  );
  const result = withoutOwnReasoning(body);
  assert.ok(result);
  assert.equal(result.dropped, 1);
  assert.deepEqual(JSON.parse(result.body.toString("utf8")), {
    model: "m",
    input: [user("a"), sealed, user("b")],
  });
  assert.equal(
    withoutOwnReasoning(Buffer.from(JSON.stringify({ input: [sealed] }))),
    undefined,
  );
});
