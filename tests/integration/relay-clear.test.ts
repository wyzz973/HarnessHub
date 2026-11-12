import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import { relayCapabilities } from "../../src/adapters/control/factory.js";
import type { HarnessSelection, PreparedSessionBinding, SelectionRequest, SessionBindingFactory, SessionConfiguration } from "../../src/contracts/session.js";
import { decisionOf, relayOf, turn, to, world } from "../fixtures/relay-fakes.js";
import { driver, gatewayOf, peerRoot, prompts, type Harness, type Peer } from "../fixtures/relay-drivers.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import { oldShape } from "../fixtures/old-shape.js";

// A clear on each of the six Drivers, through the formal Runtime and a real FileConversationStore (slim.md: "clearing is the Hub's"):
// the Drivers are the production ones, each on the relay peer as a real child process (tests/fixtures/relay-control-peer.mjs), so
// that what reached the native side is read from the peer's own trace. The conversation goes to the Harness under test with a
// packet, the user clears it, and the Runtime must read the clear as a command — it carries nothing, whatever it owes — and the
// Driver give the native session up: a new epoch, a new native session, no packet on the next message, and the earlier part
// offered once to attach. Nothing here runs a Harness.

/** The six Drivers on their peers, behind the Runtime's binding factory; the static declarations are the production ones. */
class Drivers implements SessionBindingFactory {
  constructor(private readonly t: TestContext, private readonly peers: ReadonlyMap<string, Peer>) {}
  relayCapabilities(selection: HarnessSelection) { return relayCapabilities(selection.harnessId, selection.harnessId === "codex" ? "codex-app-server" : "acp-v1"); }
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const peer = this.peers.get(selected.harnessId)!, control = driver(this.t, selected.harnessId as Harness, peer, gatewayOf(peer));
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
/** What a peer's native side was prompted with, in order: an ACP peer's text blocks joined, Codex's turn/start text. */
async function received(harness: string, peer: Peer): Promise<readonly string[]> {
  if (harness === "codex") return (await peer.sent()).filter(line => line.method === "turn/start").map(line => (line.params as { input: { text: string }[] }).input[0]!.text);
  return (await prompts(peer)).map(blocks => blocks.join(harness === "dsh" ? "" : "\n"));
}
const sessionsOpened = async (harness: string, peer: Peer): Promise<number> => (await peer.sent()).filter(line => line.method === (harness === "codex" ? "thread/start" : "session/new")).length;
const settings = (harness: string): Record<string, string> => ({ RELAY_CLOSE: "1", ...(harness === "dsh" ? { RELAY_JOIN: "" } : {}), ...(harness === "openclaw" ? { RELAY_OPENCLAW: "1" } : {}), ...(harness === "hermes" ? { RELAY_HERMES: "1" } : {}) });

for (const target of ["claude", "codex", "opencode", "dsh", "hermes", "openclaw"] as const) {
  test(`${target}: a clear is a command Turn that carries nothing, and opens a new native session in a new epoch; the earlier part is offered once and attached on request`, { timeout: 120_000 }, async t => {
    const source = target === "claude" ? "codex" : "claude";
    const peers = new Map<string, Peer>([[source, await peerRoot(t, settings(source))], [target, await peerRoot(t, settings(target))]]);
    const w = world(t, "relay-clear-"), app = w.runtime(new Drivers(t, peers)), peer = peers.get(target)!;
    const id = (await app.create(w.configuration, { harnessId: source }, "create")).id;
    assert.equal((await turn(app, id, "s1 a fact said on " + source, "k1")).status, "completed");
    await to(app, id, target, "to-target");

    // The handoff: the first message to the Harness carries what it has not seen, and is recorded.
    const x1 = await turn(app, id, "x1 the first message on " + target, "k2");
    assert.equal(x1.status, "completed", JSON.stringify(x1.error));
    const first = readRelayPrompt((await received(target, peer))[0]!);
    // A Driver that places the packet and the words as blocks of their own leaves a blank line between them.
    assert.deepEqual([first.packet, first.currentInput.text.trim(), first.history.map(row => row.user.text)], [true, "x1 the first message on " + target, ["s1 a fact said on " + source]]);
    const held = relayOf(oldShape(app, id), target);
    assert.deepEqual([held.epoch, held.pending], [1, null], "the packet reached the binding");
    assert.ok(held.mark >= 1);
    const opened = await sessionsOpened(target, peer), seen = (await received(target, peer)).length;

    // The clear: a command, so nothing is carried; the Driver sends nothing and gives the session up.
    const cleared = await turn(app, id, "/clear", "k3");
    assert.equal(cleared.status, "completed", JSON.stringify(cleared.error));
    assert.equal(cleared.relay?.packetId ?? null, null, "a command carries no packet"); assert.equal(decisionOf(w.store, id, cleared.id), undefined);
    assert.equal((await received(target, peer)).length, seen, "the clear was not sent to the native side");
    const state = oldShape(app, id), now = relayOf(state, target);
    assert.deepEqual([now.epoch, now.mark, now.pending, now.resendAll], [2, -1, null, false], "a new epoch that holds nothing");
    assert.deepEqual(state.nativeBindings!.filter(row => row.harnessId === target).map(row => row.status), ["archived", "ready"], "the native session was given up for a new one");
    const offered = app.relayAttention(id).find(row => row.harnessId === target)?.attention;
    assert.deepEqual([offered?.cause, offered?.options], ["attach_available", ["attach_full"]], "the earlier part can be attached once");

    // The next message opens a new native session and carries none of the earlier part.
    const x2 = await turn(app, id, "x2 after the clear", "k4");
    assert.equal(x2.status, "completed", JSON.stringify(x2.error));
    assert.equal(await sessionsOpened(target, peer), opened + 1, "a new native session");
    assert.equal((await received(target, peer)).at(-1), "x2 after the clear", "as typed: no packet");
    assert.equal(app.relayAttention(id).find(row => row.harnessId === target)?.attention, null, "once: the Turn that ran after the clear ends the offer");

    // Attached on request: one message with the whole history, below the clear.
    const x3 = await turn(app, id, "x3 with the earlier part", "k5", { attach: "full" });
    assert.equal(x3.status, "completed", JSON.stringify(x3.error));
    const attached = readRelayPrompt((await received(target, peer)).at(-1)!);
    assert.deepEqual([attached.packet, attached.currentInput.text.trim()], [true, "x3 with the earlier part"]);
    assert.ok(attached.history.some(row => row.user.text === "s1 a fact said on " + source), "what was said before the clear");
    assert.deepEqual(decisionOf(w.store, id, x3.id), { kind: "carry", by: "user" });
  });
}
