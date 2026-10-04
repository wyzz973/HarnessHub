// SPDX-License-Identifier: MIT
/**
 * Tool calls in all 16 directions, streamed and not, with each inbound
 * protocol's official SDK (03 section 11): a single call after reasoning,
 * whose signature the upstream requires back with the result; two parallel
 * calls, also with their argument deltas interleaved by the upstream; and
 * Responses custom (freeform) tools against every upstream. Each round trip
 * ends in a text answer that only the right tool results unlock.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ToolSpec } from "./clients.js";
import {
  answeredBy,
  assertNoViolations,
  DIRECTIONS,
  Script,
  talk,
  UPSTREAMS,
  VENDOR_FIELDS,
} from "./suite.js";
import { startTarget, type Target } from "./target.js";

const READ: ToolSpec = {
  name: "read_file",
  description: "Read a file of the workspace.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};
const PATCH = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";

const script = new Script();
const cases: { name: string; run: (target: Target) => Promise<void> }[] = [];

for (const direction of DIRECTIONS)
  for (const stream of [false, true]) {
    const label = `${direction.name}, ${stream ? "streamed" : "not streamed"}`;

    const single = script.marker("single-tool");
    const token = "NOTE-7731";
    script.add({
      when: { contains: single, toolResult: false },
      repeat: true,
      reasoning: "The answer is in notes.txt.",
      toolCalls: [{ name: "read_file", arguments: { path: "notes.txt" } }],
    });
    const singleResult = script.add({
      when: { contains: single, toolResultContains: token },
      repeat: true,
      text: `The note says ${token}.`,
    });
    cases.push({
      name: `${label}: one tool call after reasoning, its signature sent back with the result`,
      async run(target) {
        const chat = talk(target, direction);
        const call = await chat.ask({
          stream,
          text: `${single} What does the note say?`,
          tools: [READ],
          reasoning: true,
        });
        assert.equal(call.finish, "tool_calls");
        assert.deepEqual(
          call.toolCalls.map((each) => [each.name, JSON.parse(each.arguments)]),
          [["read_file", { path: "notes.txt" }]],
        );
        const done = await chat.answer(
          [{ call: call.toolCalls[0]!, output: token }],
          {
            stream,
            tools: [READ],
            reasoning: true,
          },
        );
        assert.equal(done.text, `The note says ${token}.`);
        assert.equal(done.finish, "stop");
        for (const record of await answeredBy(target, singleResult))
          assert.ok(
            record.reasoningEcho === undefined || record.reasoningEcho === true,
            `the upstream got its own reasoning back (${String(record.reasoningEcho)})`,
          );
      },
    });

    for (const interleaved of [false, true]) {
      const parallel = script.marker(interleaved ? "interleaved" : "parallel");
      script.add({
        when: { contains: parallel, toolResult: false },
        repeat: true,
        reasoning: "Both files are needed.",
        toolCalls: [
          { name: "read_file", arguments: { path: "alpha.txt" } },
          { name: "read_file", arguments: { path: "beta.txt" } },
        ],
        ...(interleaved ? { quirks: { interleavedToolArgs: true } } : {}),
      });
      script.add({
        when: { contains: parallel, toolResultContains: "BETA-CONTENT" },
        repeat: true,
        text: "Read both.",
      });
      cases.push({
        name: `${label}: two parallel tool calls${interleaved ? " with interleaved argument deltas" : ""}`,
        async run(target) {
          const chat = talk(target, direction);
          const calls = await chat.ask({
            stream,
            text: `${parallel} Read both files.`,
            tools: [READ],
            reasoning: true,
          });
          assert.equal(calls.finish, "tool_calls");
          assert.deepEqual(
            calls.toolCalls.map((each) => JSON.parse(each.arguments)),
            [{ path: "alpha.txt" }, { path: "beta.txt" }],
          );
          if (direction.inbound !== "gemini")
            assert.equal(
              new Set(calls.toolCalls.map((each) => each.id)).size,
              2,
              "each call has its own id",
            );
          const done = await chat.answer(
            [
              { call: calls.toolCalls[0]!, output: "ALPHA-CONTENT" },
              { call: calls.toolCalls[1]!, output: "BETA-CONTENT" },
            ],
            { stream, tools: [READ], reasoning: true },
          );
          assert.equal(done.text, "Read both.");
        },
      });
    }

    if (direction.inbound === "responses") {
      const custom = script.marker("custom-tool");
      script.add({
        when: { contains: custom, toolResult: false },
        repeat: true,
        toolCalls: [
          direction.upstream === "responses"
            ? { name: "apply_patch", input: PATCH }
            : // Other upstreams see the tool as a function taking the raw input.
              { name: "apply_patch", arguments: { input: PATCH } },
        ],
      });
      script.add({
        when: { contains: custom, toolResultContains: "PATCH-APPLIED" },
        repeat: true,
        text: "Patched.",
      });
      cases.push({
        name: `${label}: a custom tool call with freeform input`,
        async run(target) {
          const chat = talk(target, direction);
          const call = await chat.ask({
            stream,
            text: `${custom} Add hello.txt.`,
            customTools: [
              {
                name: "apply_patch",
                description: "Apply a patch to the workspace.",
              },
            ],
          });
          assert.equal(call.finish, "tool_calls");
          assert.deepEqual(
            call.toolCalls.map(({ name, arguments: input, custom }) => ({
              name,
              input,
              custom,
            })),
            [{ name: "apply_patch", input: PATCH, custom: true }],
          );
          const done = await chat.answer(
            [{ call: call.toolCalls[0]!, output: "PATCH-APPLIED" }],
            {
              stream,
              customTools: [
                {
                  name: "apply_patch",
                  description: "Apply a patch to the workspace.",
                },
              ],
            },
          );
          assert.equal(done.text, "Patched.");
        },
      });
    }
  }

let target: Target;
before(async () => {
  target = await startTarget({
    script: { turns: script.turns },
    providers: [...UPSTREAMS],
    fields: VENDOR_FIELDS,
  });
});
after(async () => {
  await target?.close();
});

void describe("tool calls in 16 directions", { concurrency: 16 }, () => {
  for (const each of cases) void test(each.name, () => each.run(target));
});

void test("the strict upstream recorded no field violations", async () => {
  await assertNoViolations(target);
});
