import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSON5 from "json5";
import { CapabilityChanges } from "../../src/infrastructure/capabilities/changes.js";

// The user's own OpenClaw (the first on PATH) with a private home and state directory, under the sandbox HarnessHub uses:
// it may write only that state directory and its temporary one, and every network operation is denied. Nothing here
// reads or writes the real ~/.openclaw, and the real Gateway is neither contacted nor restarted.
test("G064-W4 OpenClaw's own config set and unset switch a skill off and back on in a sandbox without the network, as predicted on a private copy first", { timeout: 180000 }, async t => {
  assert.equal(process.platform, "darwin", "OpenClaw's skill switch runs under macOS's sandbox");
  const root = await realpath(await mkdtemp(join(tmpdir(), "openclaw-switch-real-"))), home = join(root, "home"), state = join(home, ".openclaw");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(state, "skills", "real-switch"), { recursive: true }); await mkdir(join(root, "data"));
  await writeFile(join(state, "skills", "real-switch", "SKILL.md"), "---\nname: real-switch\ndescription: A skill for the switch acceptance\n---\nBody.\n");
  const config = join(state, "openclaw.json"), original = "{\n  // JSON5, as written by hand\n  skills: { entries: {} },\n}\n";
  await writeFile(config, original, { mode: 0o600 });
  const environment = { home, values: { HOME: home, OPENCLAW_STATE_DIR: state, PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin", LANG: "en_US.UTF-8" } };
  const changes = new CapabilityChanges({ root: join(root, "data"), generation: 1, assertOwner: () => {}, environment, homes: [home], processes: async () => "" });
  t.after(() => changes.close());
  const installed = [{ harnessId: "openclaw", name: "OpenClaw", version: "2026.3.23-2" }];
  const off = await changes.checkSkillSwitch({ harnessId: "openclaw", name: "real-switch", enabled: false, via: null }, installed);
  assert.equal(off.blocked, null, "the run on a private copy passes");
  assert.equal(off.command, "openclaw config set skills.entries.real-switch.enabled false --strict-json");
  // The diff shown is what OpenClaw wrote to a private copy, its own defaults included; the real file is untouched.
  assert.ok(off.diff?.includes("\"real-switch\": {") && off.diff.includes("\"enabled\": false"), off.diff ?? "");
  assert.ok(off.notes.some(note => note.includes("注释")), "the comments it would drop are said");
  assert.equal(off.rewrite?.target, "skills.entries.real-switch.enabled"); assert.deepEqual([off.rewrite?.before, off.rewrite?.after, off.rewrite?.commentLines], [null, "false", 1]);
  assert.ok(off.rewrite?.added.includes("commands") && off.rewrite.added.includes("meta"), "the defaults OpenClaw adds are named: " + JSON.stringify(off.rewrite));
  assert.equal(await readFile(config, "utf8"), original, "the run on a copy wrote nothing here");
  const applied = await changes.apply(off.fingerprint, "real-switch-off");
  assert.equal(applied.status, "applied", JSON.stringify(applied.error));
  assert.equal(JSON5.parse<{ skills: { entries: Record<string, { enabled?: boolean }> } }>(await readFile(config, "utf8")).skills.entries["real-switch"]?.enabled, false);
  assert.notEqual(applied.backupId, null);
  const on = await changes.checkSkillSwitch({ harnessId: "openclaw", name: "real-switch", enabled: true, via: null }, installed);
  assert.deepEqual([on.blocked, on.current, on.command], [null, "harnesshub", "openclaw config unset skills.entries.real-switch.enabled"]);
  assert.equal((await changes.apply(on.fingerprint, "real-switch-on")).status, "applied");
  assert.notEqual(JSON5.parse<{ skills: { entries: Record<string, { enabled?: boolean }> } }>(await readFile(config, "utf8")).skills.entries["real-switch"]?.enabled, false);
  // The original file, comments included, is one restore away.
  const restore = await changes.checkRestore(applied.backupId!);
  assert.equal((await changes.restore(restore.fingerprint, "real-switch-restore")).status, "applied");
  assert.equal(await readFile(config, "utf8"), original);
});
