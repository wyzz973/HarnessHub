import assert from "node:assert/strict";
import test from "node:test";
import { HUB_PROGRESS_INSTRUCTIONS } from "../../src/contracts/table.js";
import { scriptedWorld } from "../fixtures/scripted-world.js";

// What the Runtime tells a Driver to add to its session's system prompt (HarnessControl.setSessionInstructions) before it opens a
// native session: how to show the task list and the wrap-up, only for a process that has the Hub's tools and only while the user
// leaves `hub.progress` on. The user's words go to the Harness as they were written. Only the Harness is made up.

test("a process with the Hub's tools is told how to show its progress when its session opens, and the user's words are not touched", async t => {
  const told: (string | null)[] = [], heard: string[] = [];
  const world = await scriptedWorld(t, (_turn, text) => { heard.push(text); return []; }, { process: { hubTools: true, told: text => told.push(text) } });
  await world.send("修一下登录");
  assert.deepEqual(told, [HUB_PROGRESS_INSTRUCTIONS]);
  assert.deepEqual(heard, ["修一下登录"], "nothing is put into the message");
  // Off: the next session that opens is told nothing.
  world.store.setPref("hub.progress", "off");
  const second = await world.app.create(world.configuration, { harnessId: "alpha" }, "create-second");
  world.app.send(second.id, "再看一下", "send-second"); await world.app.wait(second.id);
  assert.deepEqual(told, [HUB_PROGRESS_INSTRUCTIONS, null]);
  // On again.
  world.store.setPref("hub.progress", "on");
  const third = await world.app.create(world.configuration, { harnessId: "alpha" }, "create-third");
  world.app.send(third.id, "第三个", "send-third"); await world.app.wait(third.id);
  assert.deepEqual(told, [HUB_PROGRESS_INSTRUCTIONS, null, HUB_PROGRESS_INSTRUCTIONS]);
});

test("a process without the Hub's tools is told nothing, whatever the setting", async t => {
  const told: (string | null)[] = [];
  const world = await scriptedWorld(t, () => [], { process: { told: text => told.push(text) } });
  await world.send("你好");
  assert.deepEqual(told, [null]);
});
