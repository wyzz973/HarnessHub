// SPDX-License-Identifier: MIT
/**
 * Text conversations in all 16 directions, streamed and not, with each
 * inbound protocol's official SDK: single and multi-turn text, reasoning,
 * an image, usage with cache reads, and the stop reasons other than tool
 * calls (03 section 11). The strict upstream runs in whitelist mode, and the
 * last test fails on any field it rejected.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  answeredBy,
  assertNoViolations,
  DIRECTIONS,
  PNG,
  Script,
  talk,
  UPSTREAMS,
  VENDOR_FIELDS,
} from "./suite.js";
import { startTarget, type Target } from "./target.js";

const script = new Script();
const cases: { name: string; run: (target: Target) => Promise<void> }[] = [];
const USAGE = { input: 100, output: 20, cached: 60 };

for (const direction of DIRECTIONS)
  for (const stream of [false, true]) {
    const label = `${direction.name}, ${stream ? "streamed" : "not streamed"}`;

    const single = script.marker("single");
    script.add({
      when: { contains: single },
      repeat: true,
      text: ["Hello", " from", " the upstream"],
      usage: USAGE,
    });
    cases.push({
      name: `${label}: one turn of text with usage and cache reads`,
      async run(target) {
        const turn = await talk(target, direction).ask({
          stream,
          text: `${single} Say hello.`,
        });
        assert.equal(turn.text, "Hello from the upstream");
        assert.equal(turn.finish, "stop");
        assert.deepEqual(turn.usage, USAGE);
      },
    });

    const first = script.marker("first");
    const second = script.marker("second");
    script.add({
      when: { contains: first },
      repeat: true,
      text: "First answer.",
    });
    const secondTurn = script.add({
      when: { contains: second },
      repeat: true,
      text: "Second answer.",
    });
    cases.push({
      name: `${label}: two turns, the second with the first in its history`,
      async run(target) {
        const chat = talk(target, direction);
        assert.equal(
          (await chat.ask({ stream, text: `${first} One.` })).text,
          "First answer.",
        );
        assert.equal(
          (await chat.ask({ stream, text: `${second} Two.` })).text,
          "Second answer.",
        );
        const records = await answeredBy(target, secondTurn);
        assert.deepEqual(
          records.map((record) => record.messages),
          [3],
          "the upstream received the user, assistant and user messages",
        );
      },
    });

    const thinking = script.marker("reasoning");
    script.add({
      when: { contains: thinking },
      repeat: true,
      reasoning: ["Weighing ", "the question."],
      text: "Decided.",
    });
    cases.push({
      name: `${label}: reasoning before the answer`,
      async run(target) {
        const turn = await talk(target, direction).ask({
          stream,
          text: `${thinking} Think first.`,
          reasoning: true,
        });
        assert.equal(turn.text, "Decided.");
        assert.equal(turn.reasoning, "Weighing the question.");
      },
    });

    const image = script.marker("image");
    const imageTurn = script.add({
      when: { contains: image },
      repeat: true,
      text: "A pixel.",
    });
    cases.push({
      name: `${label}: an image reaches the upstream`,
      async run(target) {
        const turn = await talk(target, direction).ask({
          stream,
          text: `${image} What is this?`,
          image: PNG,
        });
        assert.equal(turn.text, "A pixel.");
        const records = await answeredBy(target, imageTurn);
        assert.deepEqual(
          records.map((record) => record.images),
          [1],
          "one image part reached the upstream",
        );
      },
    });

    for (const finish of ["length", "content_filter"]) {
      const marker = script.marker(finish);
      script.add({
        when: { contains: marker },
        repeat: true,
        text: "Cut sho",
        finish,
      });
      cases.push({
        name: `${label}: stop reason ${finish}`,
        async run(target) {
          const turn = await talk(target, direction).ask({
            stream,
            text: `${marker} Go on.`,
          });
          assert.equal(turn.text, "Cut sho");
          assert.equal(turn.finish, finish);
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

void describe("conversations in 16 directions", { concurrency: 16 }, () => {
  for (const each of cases) void test(each.name, () => each.run(target));
});

void test("the strict upstream recorded no field violations", async () => {
  await assertNoViolations(target);
});
