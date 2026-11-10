import assert from "node:assert/strict";
import test from "node:test";
import { RELAY_WINDOW_RETENTION_MS, type BindingRelayState, type RelayWindow } from "../../src/contracts/relay.js";
import { RELAY_BUDGET, resolveRelayBudget } from "../../src/contexts/session/domain/relay/budget.js";
import {
  ASSUMED_PREFILL, RETURN_PRIOR, RETURN_THRESHOLDS, cacheLifeMs, estimateReturn, packetCost, returnChoice, returnPreference, survivalEstimate, warm, type ReturnInput,
} from "../../src/contexts/session/domain/relay/return-policy.js";
import {
  ASSUMED_WINDOW, FIXED_PREFIX_DEFAULT, FULL_TIER_CAP, MIN_PACKET, WINDOW_RESERVE, cacheAfter, fitsMinPacket, hardCap, packetBudget, packetFamily, resolveWindow, vendorKind, windowRow,
} from "../../src/contexts/session/domain/relay/windows.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/migrate.js";

// G072-C11 (ADR-055 §7.3, §6.2, §11.1; relay-architecture §17 G072): the return decision's pure parts — the four (R, k) points of
// a packet's cost, the survival estimate of requests per handoff, warmth read from the last request's start, the side-by-side
// conditions and the preferences — and windows.ts, the window's sources, the hard cap and MIN_PACKET. Hand-written inputs, no
// Runtime, no Store.

const NOW = 1_800_000_000_000;
const relay = (cache: Partial<BindingRelayState["cache"]> = {}): BindingRelayState => ({ ...initialBindingRelay([], "alpha", "alpha-acp", "new"), cache: { lastRequestStartedAt: null, contextUsed: null, contextSize: null, ...cache } });
const PRICE = { write: 3 / 1e6, read: 0.3 / 1e6 };

test("G072-C11 a packet's cost over a window (§11.1, C = T·[p_w(1+k) + p_r(R−1−k)]): the four table points (R, k) ∈ {(80,0), (80,5), (300,0), (300,15)}", () => {
  const T = 8000;
  const points: readonly (readonly [number, number, number])[] = [[80, 0, T * (PRICE.write + PRICE.read * 79)], [80, 5, T * (PRICE.write * 6 + PRICE.read * 74)],
    [300, 0, T * (PRICE.write + PRICE.read * 299)], [300, 15, T * (PRICE.write * 16 + PRICE.read * 284)]];
  for (const [requests, misses, expected] of points) assert.ok(Math.abs(packetCost(T, requests, misses, PRICE) - expected) < 1e-12, requests + "," + misses);
  assert.equal(packetCost(T, 1, 5, PRICE), T * PRICE.write, "misses never exceed the requests after the first");
});

test("G072-C11 survival estimate (§7.3): below 20 known windows the prior (R=80, k=0); a Kaplan–Meier median with open windows censored; the largest observation when the curve never reaches 0.5", () => {
  assert.deepEqual(survivalEstimate([]), { requests: RETURN_PRIOR.requests, misses: 0, prior: true });
  assert.deepEqual(survivalEstimate(Array.from({ length: 19 }, () => ({ requests: 3, misses: 0, closed: true }))), { requests: 80, misses: 0, prior: true });
  // 20 closed windows at 1..20 requests: S drops below 0.5 at the 10th.
  const closed = Array.from({ length: 20 }, (_, index) => ({ requests: index + 1, misses: index % 3, closed: true }));
  assert.equal(survivalEstimate(closed).requests, 10); assert.equal(survivalEstimate(closed).prior, false);
  // Censoring: the same plus 20 windows still open at 30 requests push the median later than the closed ones alone.
  const censored = [...closed, ...Array.from({ length: 20 }, () => ({ requests: 30, misses: 0, closed: false }))];
  const later = survivalEstimate(censored.slice(-50));
  assert.ok(later.requests > 10, "an open window counts as surviving at least its requests: " + later.requests);
  // Every window open: no event, the largest observation.
  assert.equal(survivalEstimate(Array.from({ length: 25 }, (_, index) => ({ requests: 5 + index, misses: 0, closed: false }))).requests, 29);
  // Only the latest 50 count.
  const old = Array.from({ length: 50 }, () => ({ requests: 2, misses: 0, closed: true })), recent = Array.from({ length: 50 }, () => ({ requests: 200, misses: 9, closed: true }));
  assert.deepEqual(survivalEstimate([...old, ...recent]), { requests: 200, misses: 9, prior: false });
});

test("G072-C11 warmth by the last request's start (VF2-16): under 0.8 of the cache's life; never without a known start or life; auth-dependent is the shorter life unless an account", () => {
  assert.equal(cacheLifeMs("5m", null), 300_000); assert.equal(cacheLifeMs("unknown", "account"), null);
  assert.equal(cacheLifeMs("auth_dependent", "api_key"), 300_000); assert.equal(cacheLifeMs("auth_dependent", "account"), 3_600_000);
  const at = (ms: number) => relay({ lastRequestStartedAt: NOW - ms }).cache;
  assert.equal(warm(at(239_999), "5m", null, NOW), true); assert.equal(warm(at(240_000), "5m", null, NOW), false, "0.8 × 5 minutes");
  assert.equal(warm(relay().cache, "1h", null, NOW), false, "no request known");
  assert.equal(warm(at(1000), "unknown", null, NOW), false, "a life that cannot be told is never warm");
  assert.equal(warm({ ...at(0), lastRequestStartedAt: NOW + 5 }, "5m", null, NOW), false, "a start after now is no evidence");
});

const base: ReturnInput = { cache: { lastRequestStartedAt: null, contextUsed: 150_000, contextSize: 200_000 }, cacheTtl: "5m", authKind: "api_key", now: NOW,
  delta: 1500, packet: 8000, input: 50, fixedPrefix: 8000, window: 200_000, price: PRICE, prefill: ASSUMED_PREFILL, requests: { requests: 80, misses: 0 } };

test("G072-C11 the return's two paths and the side-by-side conditions (§7.3, D9): cost difference ≥ $0.10, latency difference ≥ 10 s, or N/W ≥ 0.85; without a price only time and the window decide", () => {
  const cold = estimateReturn(base);
  assert.equal(cold.warm, false);
  // Native: N written cold, then N + Δ + S_new read per later request; fresh: S_A + T + S_new.
  assert.ok(Math.abs(cold.native.firstRequest! - (150_000 * PRICE.write + 1550 * PRICE.write)) < 1e-9);
  assert.ok(Math.abs(cold.fresh.firstRequest! - 16_050 * PRICE.write) < 1e-9);
  assert.ok(Math.abs(cold.perRequestDiff! - (150_000 + 1500 - 8000 - 8000) * PRICE.read) < 1e-12);
  assert.ok(Math.abs(cold.wholeDiff! - ((cold.native.firstRequest! - cold.fresh.firstRequest!) + 79 * cold.perRequestDiff!)) < 1e-9);
  assert.equal(cold.sideBySide, true, "a long native context costs far more over its life");
  // Small native context, warm: nothing worth showing beside.
  const small = estimateReturn({ ...base, cache: { lastRequestStartedAt: NOW - 1000, contextUsed: 9000, contextSize: 200_000 } });
  assert.equal(small.warm, true); assert.equal(small.sideBySide, false);
  // Latency alone: 100k cold tokens at 8k tok/s is 12.5 s more than a 16k fresh start.
  const timed = estimateReturn({ ...base, price: null, cache: { lastRequestStartedAt: null, contextUsed: 100_000, contextSize: 1_000_000 }, window: 1_000_000 });
  assert.equal(timed.wholeDiff, null, "no dollars without a price (a subscription)"); assert.ok(timed.latencyDiffS >= RETURN_THRESHOLDS.latencyS); assert.equal(timed.sideBySide, true);
  // The window share alone.
  const full = estimateReturn({ ...base, price: null, cache: { lastRequestStartedAt: NOW - 1000, contextUsed: 17_000, contextSize: 20_000 }, window: 20_000 });
  assert.ok(full.windowShare >= 0.85); assert.equal(full.sideBySide, true);
  const roomy = estimateReturn({ ...base, price: null, cache: { lastRequestStartedAt: NOW - 1000, contextUsed: 16_000, contextSize: 20_000 }, window: 20_000 });
  assert.equal(roomy.sideBySide, false, "0.80 of the window, warm, no price");
});

test("G072-C11 the return's choice (§7.3): the request's relay.native decides; continue by default; new_when_cold only when cold and shown beside; ask asks only when shown beside; the preference read safely", () => {
  assert.deepEqual(returnChoice({ warm: false, sideBySide: true }, "continue", "new"), { choice: "new", ask: false, by: "request" });
  assert.deepEqual(returnChoice({ warm: false, sideBySide: true }, "new_when_cold", "continue"), { choice: "continue", ask: false, by: "request" });
  assert.deepEqual(returnChoice({ warm: false, sideBySide: true }, "continue", undefined), { choice: "continue", ask: false, by: "default" });
  assert.deepEqual(returnChoice({ warm: false, sideBySide: true }, "new_when_cold", undefined), { choice: "new", ask: false, by: "preference" });
  assert.deepEqual(returnChoice({ warm: true, sideBySide: true }, "new_when_cold", undefined).choice, "continue", "never when warm");
  assert.deepEqual(returnChoice({ warm: false, sideBySide: false }, "new_when_cold", undefined).choice, "continue", "never when not shown beside");
  assert.deepEqual(returnChoice({ warm: true, sideBySide: true }, "ask", undefined), { choice: "continue", ask: true, by: "preference" });
  assert.deepEqual(returnChoice({ warm: true, sideBySide: false }, "ask", undefined).ask, false);
  assert.equal(returnPreference({}), "continue"); assert.equal(returnPreference({ "relay.returnPreference": "ask" }), "ask"); assert.equal(returnPreference({ "relay.returnPreference": "nonsense" }), "continue");
});

test("G072 windows.ts: the window's sources in order — the session's report, a window observed in the last 30 days, an assumption by vendor kind — and the fixed prefix", () => {
  const stored: RelayWindow = { harnessId: "alpha", controlId: "alpha-acp", modelKey: "m", size: 64_000, firstTurnUsed: 9_000, observedAt: NOW - 1000 };
  assert.deepEqual(resolveWindow({ relay: relay({ contextSize: 200_000 }), report: "session_report", stored, vendor: "anthropic", fixedPrefix: null, now: NOW }), { size: 200_000, source: "session_report", fixedPrefix: 9_000 });
  assert.deepEqual(resolveWindow({ relay: relay({ contextSize: 200_000 }), report: "none", stored, vendor: "anthropic", fixedPrefix: null, now: NOW }), { size: 64_000, source: "observed_recent", fixedPrefix: 9_000 }, "a Driver that reports none: its cache is not its report");
  assert.equal(resolveWindow({ relay: relay(), report: "turn_report", stored: { ...stored, observedAt: NOW - RELAY_WINDOW_RETENTION_MS - 1 }, vendor: "openai", fixedPrefix: null, now: NOW }).source, "assumed_cloud", "older than 30 days");
  assert.deepEqual(resolveWindow({ relay: null, report: "session_report", stored: null, vendor: "gateway:api.example.com", fixedPrefix: { tokens: 12_000, basis: "measured" }, now: NOW }), { size: ASSUMED_WINDOW.gateway, source: "assumed_gateway", fixedPrefix: 12_000 });
  assert.deepEqual(resolveWindow({ relay: null, report: "session_report", stored: null, vendor: "local", fixedPrefix: null, now: NOW }), { size: 32_000, source: "assumed_local", fixedPrefix: FIXED_PREFIX_DEFAULT.local });
  assert.equal(vendorKind("unknown:alpha"), "gateway"); assert.equal(vendorKind("deepseek"), "cloud");
  assert.equal(packetFamily("openai", "gpt-5"), "o200k"); assert.equal(packetFamily("gateway:x", "claude-opus-5-5"), "claude"); assert.equal(packetFamily("deepseek", "v4"), "unknown");
});

test("G072 windows.ts: hardCap = min(capWindow, capChannel, T_full) and MIN_PACKET (§6.2): only a small window or a full channel blocks; the history's length never enters", () => {
  const window = (size: number, fixedPrefix = 8000) => ({ size, source: "session_report" as const, fixedPrefix });
  assert.equal(hardCap(window(200_000), 50, null, 50), 10_000, "5% of the window");
  assert.equal(hardCap(window(2_000_000), 50, null, 50), FULL_TIER_CAP, "never above the largest tier");
  assert.equal(hardCap(window(16_000), 50, null, 50), 800, "a 16k local model: 5% is 800");
  assert.equal(fitsMinPacket(800, "unknown"), false); assert.equal(fitsMinPacket(900, "o200k"), true); assert.equal(fitsMinPacket(1349, "claude"), false);
  // The boundary of §6.2's prose: W just under 27k blocks the Claude family, 18k the o200k family.
  assert.equal(fitsMinPacket(hardCap(window(26_999), 10, null, 10), "claude"), false); assert.equal(fitsMinPacket(hardCap(window(27_000), 10, null, 10), "claude"), true);
  assert.equal(fitsMinPacket(hardCap(window(17_999), 10, null, 10), "o200k"), false); assert.equal(fitsMinPacket(hardCap(window(18_000), 10, null, 10), "o200k"), true);
  // What remains after the fixed prefix, the words and the reserve.
  assert.equal(hardCap(window(32_000, 25_000), 3000, null, 3000), 0);
  assert.equal(hardCap(window(32_000), 100, null, 100), 1600, "the assumed gateway window still fits the smallest packet");
  // The channel: its bound less the Turn's own size and the reserve, at 3.2 units a token.
  assert.equal(hardCap(window(1_000_000), 10, { limit: 20_000 }, 10_000), Math.floor((20_000 - 10_000 - WINDOW_RESERVE) / 3.2));
  assert.equal(hardCap(window(1_000_000), 10, { limit: 10_000 }, 9_000), 0);
  assert.equal(MIN_PACKET.o200k, 900); assert.equal(MIN_PACKET.claude, 1350); assert.equal(MIN_PACKET.unknown, 1350);
});

test("G072 windows.ts: the packet's budget — the renderer's own for an assumed window (rendering unchanged), the observed window's otherwise, never above the hard cap; the cache and window row a Turn's usage gives", () => {
  const assumed = { size: 32_000, source: "assumed_gateway" as const, fixedPrefix: 8000 }, observed = { size: 64_000, source: "observed_recent" as const, fixedPrefix: 8000 };
  assert.deepEqual(packetBudget(assumed, Number.POSITIVE_INFINITY), resolveRelayBudget(null));
  assert.deepEqual(packetBudget(observed, Number.POSITIVE_INFINITY), resolveRelayBudget(64_000));
  const capped = packetBudget(observed, 1500);
  assert.deepEqual([capped.cap, capped.untrusted, capped.user], [1500, Math.floor(RELAY_BUDGET.untrustedRatio * 1500), 750]);
  // The cache: from usage only; a Turn that reported none keeps what was known; the start is the dispatch.
  const before = relay({ contextUsed: 10, contextSize: 100_000 }).cache;
  assert.deepEqual(cacheAfter(before, { context: { used: 40_000, size: 200_000 } }, NOW), { lastRequestStartedAt: NOW, contextUsed: 40_000, contextSize: 200_000 });
  assert.deepEqual(cacheAfter(before, { turn: { input: 5 } }, NOW), { lastRequestStartedAt: NOW, contextUsed: 10, contextSize: 100_000 });
  assert.deepEqual(cacheAfter(before, { context: { used: -1, size: 0 } }, null), before, "what is not a count is not taken");
  assert.deepEqual(windowRow("alpha", "alpha-acp", "m", { context: { used: 9000, size: 200_000 } }, true, NOW), { harnessId: "alpha", controlId: "alpha-acp", modelKey: "m", size: 200_000, firstTurnUsed: 9000, observedAt: NOW });
  assert.equal(windowRow("alpha", "alpha-acp", "m", { context: { used: 9000, size: 200_000 } }, false, NOW)?.firstTurnUsed, null, "only a native session's first Turn tells the fixed prefix");
  assert.equal(windowRow("alpha", "alpha-acp", "m", { turn: { input: 1 } }, true, NOW), null, "no size, no row");
});
