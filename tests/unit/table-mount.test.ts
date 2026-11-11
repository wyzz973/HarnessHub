import assert from "node:assert/strict";
import test from "node:test";
import { sessionId } from "../../src/contracts/session.js";
import { readTableEnv, TABLE_ENV, type TableGrant } from "../../src/contracts/table.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { TableMount } from "../../src/infrastructure/table/mount.js";

const ONE = sessionId("session-one"), TWO = sessionId("session-two");
const grant = (id = ONE, harnessId = "claude"): TableGrant => ({ sessionId: id, harnessId, controlId: harnessId + "-acp" });

test("tokens are unguessable, resolve to what they were minted for, and go by Session", () => {
  const grants = new MemoryTableGrants();
  const a = grants.mint(grant(ONE, "claude")), b = grants.mint(grant(ONE, "codex")), c = grants.mint(grant(TWO, "claude"));
  assert.equal(new Set([a, b, c]).size, 3);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/u, "32 random bytes");
  assert.deepEqual(grants.resolve(a), grant(ONE, "claude"));
  assert.deepEqual(grants.resolve(b), grant(ONE, "codex"));
  grants.revoke(ONE);
  assert.deepEqual([grants.resolve(a), grants.resolve(b)], [null, null]);
  assert.deepEqual(grants.resolve(c), grant(TWO, "claude"), "another Session's token stays");
  assert.deepEqual([grants.resolve(""), grants.resolve("x".repeat(10_000))], [null, null]);
  grants.revoke(ONE);
});

test("the oldest tokens give way past the bound, so a leak cannot grow without limit", () => {
  const grants = new MemoryTableGrants(), first = grants.mint(grant());
  let last = first;
  for (let index = 0; index < 4096; index++) last = grants.mint(grant(TWO));
  assert.equal(grants.resolve(first), null);
  assert.equal(grants.resolve(last)?.sessionId, TWO);
});

test("a mount without an address gives a process nothing; with one, the address and a token of its own", () => {
  const mount = new TableMount();
  assert.equal(mount.attach(grant()), null);
  mount.listening("http://127.0.0.1:4317");
  const attached = mount.attach(grant())!;
  assert.deepEqual(Object.keys(attached.env).sort(), [TABLE_ENV.session, TABLE_ENV.url].sort());
  assert.equal(attached.env[TABLE_ENV.url], "http://127.0.0.1:4317");
  assert.deepEqual(mount.grants.resolve(attached.env[TABLE_ENV.session]!), grant());
  assert.deepEqual(readTableEnv(attached.env), { url: "http://127.0.0.1:4317", session: attached.env[TABLE_ENV.session] }, "what the mount sets is what the tool accepts");
  mount.listening(null);
  assert.equal(mount.attach(grant()), null, "a Hub that stopped listening starts nothing with the table");
  assert.deepEqual(mount.grants.resolve(attached.env[TABLE_ENV.session]!), grant(), "a process already started keeps its token until it ends");
  attached.detach();
  assert.equal(mount.grants.resolve(attached.env[TABLE_ENV.session]!), null);
});

test("a Session's tokens go with its last process, not with the first to end; detaching twice changes nothing", () => {
  const mount = new TableMount(); mount.listening("http://127.0.0.1:4317");
  const kept = mount.attach(grant(ONE, "claude"))!, switching = mount.attach(grant(ONE, "codex"))!, other = mount.attach(grant(TWO, "claude"))!;
  const token = (attachment: typeof kept) => attachment.env[TABLE_ENV.session]!;
  switching.detach(); switching.detach();
  assert.equal(mount.grants.resolve(token(kept))?.harnessId, "claude", "the kept process of the same Session still has its token");
  assert.equal(mount.grants.resolve(token(switching))?.harnessId, "codex", "the token of the one that ended goes with the Session's last, which the contract revokes by Session");
  kept.detach();
  assert.deepEqual([mount.grants.resolve(token(kept)), mount.grants.resolve(token(switching))], [null, null]);
  assert.equal(mount.grants.resolve(token(other))?.sessionId, TWO);
  kept.detach(); other.detach();
  assert.equal(mount.grants.resolve(token(other)), null);
  // A Session that starts again after all ended is counted afresh.
  const again = mount.attach(grant(ONE, "claude"))!;
  assert.equal(mount.grants.resolve(token(again))?.sessionId, ONE);
  again.detach();
  assert.equal(mount.grants.resolve(token(again)), null);
});

test("the tool reads a Hub Session's environment and nothing else: absent, empty, not loopback and an unexpanded reference are all outside the Hub", () => {
  const good = { [TABLE_ENV.url]: "http://127.0.0.1:4317", [TABLE_ENV.session]: "Abc_def-0123456789xyzABCDEFG" };
  assert.deepEqual(readTableEnv(good), { url: "http://127.0.0.1:4317", session: good[TABLE_ENV.session] });
  const without = (name: string) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));
  assert.equal(readTableEnv({}), null);
  assert.equal(readTableEnv(without(TABLE_ENV.session)), null); assert.equal(readTableEnv(without(TABLE_ENV.url)), null);
  assert.equal(readTableEnv({ ...good, [TABLE_ENV.session]: "" }), null);
  // Claude Code leaves a reference to a variable it was not given as that text.
  assert.equal(readTableEnv({ [TABLE_ENV.url]: "${" + TABLE_ENV.url + "}", [TABLE_ENV.session]: "${" + TABLE_ENV.session + "}" }), null);
  assert.equal(readTableEnv({ ...good, [TABLE_ENV.url]: "https://example.com" }), null, "a token goes to this machine's Hub only");
  assert.equal(readTableEnv({ ...good, [TABLE_ENV.url]: "http://127.0.0.1:4317/x" }), null);
  assert.equal(readTableEnv({ ...good, [TABLE_ENV.url]: "http://localhost:4317" }), null);
  assert.equal(readTableEnv({ ...good, [TABLE_ENV.session]: "short" }), null);
});
