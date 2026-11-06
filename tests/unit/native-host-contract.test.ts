import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";
import { CONSERVATIVE_HOST_CAPABILITIES, HOST_BUDGET_BOUNDS, HOST_CLASS_CAP_BOUNDS, MIN_HOST_MEMORY_BUDGET_BYTES, MIN_PHYSICAL_MEMORY_BYTES, hostClassKey, hostId, hostKind,
  parseHostCapabilities, resolveHostBudgets, sessionLeaseId, type HostCapabilities, type HostKind } from "../../src/contracts/native-host.js";
import { MAX_PARALLEL_CONVERSATIONS, SessionError } from "../../src/contracts/session.js";

// The host and session-lease contract of ADR-056 (design §4.2, §4.3; G078). Nothing here starts a program or reads a store:
// every parser is checked against its own rule, and every refusal is a refusal, never an adjusted value.

const MIB = 1024 * 1024, GIB = 1024 * MIB, MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
function refused(run: () => unknown, label: string): void {
  assert.throws(run, error => error instanceof SessionError && error.code === "INVALID_INPUT", label);
}

test("G078-C01 host, lease and class identities are parsed; empty, too long, control characters, other prefixes and other types are refused", () => {
  for (const [parse, prefix] of [[hostId, "host"], [sessionLeaseId, "lease"]] as const) {
    assert.equal(parse(prefix + "-1f2e3d4c-aaaa-4bbb-8ccc-0123456789ab"), prefix + "-1f2e3d4c-aaaa-4bbb-8ccc-0123456789ab");
    assert.equal(parse(prefix + "-" + "a".repeat(96)), prefix + "-" + "a".repeat(96), "96 characters after the prefix is the bound");
    for (const value of ["", prefix, prefix + "-", prefix + "-" + "a".repeat(97), prefix + "-a\nb", prefix + "-a\0", prefix + "-a\u0007", prefix + "-a b", prefix + "-中",
      prefix + "-a/b", (prefix === "host" ? "lease" : "host") + "-a", " " + prefix + "-a", prefix + "-a ", null, undefined, 1, {}, [prefix + "-a"]]) refused(() => parse(value), prefix + " " + JSON.stringify(value));
  }
  const key = "0123456789abcdef".repeat(4);
  assert.equal(hostClassKey(key), key);
  for (const value of ["", key.slice(1), key + "0", key.toUpperCase(), key.slice(1) + "g", key.slice(1) + "\n", key.slice(1) + "\0", " ".repeat(64), null, 64, { key }])
    refused(() => hostClassKey(value), "class key " + JSON.stringify(value));
});

test("G078-C01 a declaration's missing fields take the most conservative values, and only those", () => {
  const empty = parseHostCapabilities({});
  assert.deepEqual(empty, CONSERVATIVE_HOST_CAPABILITIES);
  // The values the plan names, one by one.
  assert.equal(empty.sessions, "one_per_process"); assert.equal(empty.sessionCwd, "launch_cwd_only"); assert.equal(empty.reopen.cost, "unknown");
  assert.equal(empty.idleActivity, "unknown"); assert.equal(empty.foreignTurns, "undetectable"); assert.equal(empty.probed, false);
  // And the rest: replay only, nothing known of memory or release, every selection a launch parameter, gateway execution
  // (an exit is no evidence of quiescence), unknown initialize effects, no concurrent Turns.
  assert.equal(empty.reopen.byLoadOnly, true); assert.equal(empty.sessionMemory, "unknown"); assert.equal(empty.sessionRelease, "unknown");
  assert.deepEqual(empty.launchBound, ["model", "options", "collaboration_mode", "provider"]); assert.equal(empty.execution, "gateway");
  assert.equal(empty.initializeSideEffects, "unknown"); assert.equal(empty.concurrentTurns, false);
  assert.equal(hostKind(empty), "single", "an unknown declaration gets one process per conversation");
  // A partial declaration keeps what it says and defaults the rest, nested fields included.
  const partial = parseHostCapabilities({ sessions: "concurrent", sessionMemory: "light", reopen: { cost: "replay" }, launchBound: [] });
  assert.deepEqual(partial, { ...CONSERVATIVE_HOST_CAPABILITIES, sessions: "concurrent", sessionMemory: "light", reopen: { cost: "replay", byLoadOnly: true }, launchBound: [] });
  // A complete declaration is kept as it is, and the result shares nothing with its input.
  const full: HostCapabilities = { sessions: "concurrent", sessionCwd: "per_session", reopen: { cost: "reference", byLoadOnly: false }, sessionMemory: "heavy", sessionRelease: "in_process",
    launchBound: ["collaboration_mode"], execution: "process", idleActivity: "background_possible", initializeSideEffects: "none", concurrentTurns: true, foreignTurns: "detectable_by_listing", probed: true };
  const input = JSON.parse(JSON.stringify(full)) as { launchBound: string[] }, parsed = parseHostCapabilities(input);
  assert.deepEqual(parsed, full); input.launchBound.push("model"); assert.deepEqual(parsed.launchBound, ["collaboration_mode"]);
});

test("G078-C01 a declaration with an unknown value or field, a wrong type, a repeated selection or a contradiction is refused, not repaired", () => {
  const invalid: unknown[] = [null, [], "concurrent", 1, true, Object.create({ sessions: "concurrent" }),
    { sessions: "many" }, { sessions: "" }, { sessions: 1 }, { sessionCwd: "anywhere" }, { sessionMemory: "medium" }, { sessionRelease: "never" }, { execution: "daemon" },
    { idleActivity: "maybe" }, { initializeSideEffects: "spawns" }, { foreignTurns: "sometimes" }, { probed: "true" }, { probed: 1 }, { concurrentTurns: "false" },
    { reopen: null }, { reopen: [] }, { reopen: "replay" }, { reopen: { cost: "free" } }, { reopen: { byLoadOnly: "yes" } }, { reopen: { cost: "replay", extra: true } },
    { launchBound: "model" }, { launchBound: ["speed"] }, { launchBound: ["model", "model"] }, { launchBound: [1] }, { launchBound: ["model", "options", "collaboration_mode", "provider", "model"] },
    { extra: true }, { __proto__: { sessions: "concurrent" }, sessions: "concurrent" },
    // Concurrent Turns need a host that carries sessions at once; a reopen that only replay can do cannot cost a reference,
    // which is also what a reference cost with byLoadOnly left to its default says.
    { sessions: "switchable", concurrentTurns: true }, { concurrentTurns: true }, { reopen: { cost: "reference", byLoadOnly: true } }, { reopen: { cost: "reference" } }];
  for (const value of invalid) refused(() => parseHostCapabilities(value), JSON.stringify(value) ?? String(value));
});

test("G078-C01 a class's budget kind follows sessions, sessionMemory and sessionRelease alone, and the unknown gets the strictest kind", () => {
  let combinations = 0;
  for (const sessions of ["one_per_process", "switchable", "concurrent"] as const) for (const sessionMemory of ["light", "heavy", "unknown"] as const)
    for (const sessionRelease of ["in_process", "process_only", "unknown"] as const) {
      const stated: HostKind = sessions !== "concurrent" ? "single" : sessionMemory === "light" ? "light" : sessionMemory === "heavy" && sessionRelease === "in_process" ? "heavy_reclaimable" : "heavy_process_only";
      assert.equal(hostKind({ sessions, sessionMemory, sessionRelease }), stated, [sessions, sessionMemory, sessionRelease].join(" "));
      combinations++;
    }
  assert.equal(combinations, 27);
});

const PHYSICAL = 64 * GIB;
test("G078-C02 the host budgets' defaults: an eighth of memory, the measured class caps, ADR-030 and ADR-036 limits, a 1.5 s close grace and the TMPDIR limits", () => {
  const budgets = resolveHostBudgets({ physicalMemoryBytes: PHYSICAL });
  assert.deepEqual(budgets, {
    hostMemoryBudgetBytes: 8 * GIB, maxHosts: 8, maxPinned: 4, maxParallel: MAX_PARALLEL_CONVERSATIONS, pinnedIdleTtlMs: 30 * MINUTE, pinnedHardCapMs: 4 * HOUR,
    classCaps: { single: { hostIdleMs: 5 * MINUTE }, light: { maxSessionsPerHost: 8, hostIdleMs: 15 * MINUTE },
      heavy_reclaimable: { maxLiveSessions: 3, sessionIdleMs: 10 * MINUTE, emptyHostIdleMs: 2 * MINUTE }, heavy_process_only: { maxProcesses: 3, hostIdleMs: 5 * MINUTE } },
    closeGraceMs: 1_500, closeOutsideWaitMs: 10_000, hostTmpdirMaxBytes: 256 * MIB, hostTmpdirMaxEntries: 4_096, hostTmpdirUnusedMs: 7 * DAY, hostTmpdirCloseWaitMs: 5_000 });
  assert.deepEqual(resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: {} }), budgets, "nothing configured is the defaults");
  assert.equal(MAX_PARALLEL_CONVERSATIONS, 4);
  assert.equal(resolveHostBudgets({ physicalMemoryBytes: 16 * GIB + 7 }).hostMemoryBudgetBytes, 2 * GIB, "an eighth, rounded down");
  assert.equal(resolveHostBudgets({ physicalMemoryBytes: MIN_PHYSICAL_MEMORY_BYTES }).hostMemoryBudgetBytes, MIN_HOST_MEMORY_BUDGET_BYTES, "the least memory still has a default within bounds");
  // Every default lies within its own bounds.
  for (const [key, bounds] of Object.entries(HOST_BUDGET_BOUNDS)) assert.ok(bounds.min <= bounds.fallback && bounds.fallback <= bounds.max, key);
  for (const [kind, fields] of Object.entries(HOST_CLASS_CAP_BOUNDS)) for (const [field, bounds] of Object.entries(fields as Record<string, { min: number; max: number; fallback: number }>))
    assert.ok(bounds.min <= bounds.fallback && bounds.fallback <= bounds.max, kind + "." + field);
});

test("G078-C02 each budget takes exactly its bounds and refuses one past them or anything not a whole number, instead of adjusting it", () => {
  const notWhole: unknown[] = [1.5, "3", Number.NaN, Number.POSITIVE_INFINITY, null, true, [3], { value: 3 }, Number.MAX_SAFE_INTEGER + 2];
  // Each value is tried with the others at defaults, except where a cross-field rule needs the related ones moved aside.
  const besides = (key: string): Record<string, unknown> => key === "maxHosts" ? { maxPinned: 1, classCaps: { heavy_process_only: { maxProcesses: 1 } } } : key === "maxPinned" ? { maxHosts: 64 }
    : key === "pinnedIdleTtlMs" ? { pinnedHardCapMs: 24 * HOUR } : key === "pinnedHardCapMs" ? { pinnedIdleTtlMs: MINUTE } : {};
  for (const [key, bounds] of Object.entries(HOST_BUDGET_BOUNDS)) {
    for (const value of [bounds.min, bounds.max]) {
      const budgets = resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { ...besides(key), [key]: value } });
      assert.equal(budgets[key as keyof typeof HOST_BUDGET_BOUNDS], value, key + " " + value);
    }
    for (const value of [bounds.min - 1, bounds.max + 1, -bounds.max, ...notWhole]) refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { ...besides(key), [key]: value } }), key + " " + String(value));
  }
  for (const [kind, fields] of Object.entries(HOST_CLASS_CAP_BOUNDS)) for (const [field, bounds] of Object.entries(fields as Record<string, { min: number; max: number }>)) {
    const configured = (value: unknown) => ({ maxHosts: 64, classCaps: { [kind]: { [field]: value } } });
    for (const value of [bounds.min, bounds.max]) {
      const caps: Readonly<Record<string, number>> = resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: configured(value) }).classCaps[kind as HostKind];
      assert.equal(caps[field], value, kind + "." + field + " " + value);
    }
    for (const value of [bounds.min - 1, bounds.max + 1, ...notWhole]) refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: configured(value) }), kind + "." + field + " " + String(value));
  }
  // The close grace is never below 1.5 s.
  refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { closeGraceMs: 1_499 } }), "a grace under 1.5 s");
  assert.equal(resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { closeGraceMs: 1_500 } }).closeGraceMs, 1_500);
  // Memory is bounded by the machine's own: from 256 MiB to all of it.
  for (const value of [MIN_HOST_MEMORY_BUDGET_BYTES, PHYSICAL]) assert.equal(resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { hostMemoryBudgetBytes: value } }).hostMemoryBudgetBytes, value);
  for (const value of [MIN_HOST_MEMORY_BUDGET_BYTES - 1, PHYSICAL + 1, ...notWhole]) refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { hostMemoryBudgetBytes: value } }), "memory " + String(value));
  for (const physical of [MIN_PHYSICAL_MEMORY_BYTES - 1, 0, -1, 2.5 * GIB + 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) refused(() => resolveHostBudgets({ physicalMemoryBytes: physical }), "physical memory " + physical);
});

test("G078-C02 maxPinned never exceeds maxHosts, nor a kind's process cap; the pinned idle time never exceeds its hard cap; unknown fields are refused", () => {
  refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { maxHosts: 2, maxPinned: 3 } }), "maxPinned above maxHosts");
  refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { maxPinned: 9 } }), "maxPinned above the default maxHosts");
  assert.equal(resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { maxHosts: 3, maxPinned: 3 } }).maxPinned, 3, "equal is allowed");
  refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { maxHosts: 2, maxPinned: 2, classCaps: { heavy_process_only: { maxProcesses: 3 } } } }), "a kind's processes above maxHosts");
  refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured: { pinnedIdleTtlMs: 2 * HOUR, pinnedHardCapMs: HOUR } }), "idle beyond the hard cap");
  for (const configured of [null, [], "budgets", 8, Object.create({ maxHosts: 8 }), { maxhosts: 8 }, { extra: 1 }, { classCaps: null }, { classCaps: [] }, { classCaps: { medium: {} } },
    { classCaps: { light: { maxSessionsPerHost: 8, extra: 1 } } }, { classCaps: { single: { maxProcesses: 3 } } }, { classCaps: { light: [] } }])
    refused(() => resolveHostBudgets({ physicalMemoryBytes: PHYSICAL, configured }), JSON.stringify(configured) ?? String(configured));
});

/**
 * Product words: every catalog Harness's id, name, aliases and program names, and vendors outside the catalog, as whole
 * words in any case. "pool" (a program name of one catalog entry) is also the contract's own word for the host pool.
 */
function productWords(): readonly string[] {
  const words = new Set(["WorkBuddy", "Anthropic", "OpenAI", "DeepSeek", "Google", "Moonshot"]);
  for (const definition of loadBuiltinCatalog("darwin-aarch64")) for (const word of [definition.id, definition.name, ...definition.aliases, ...definition.binaryNames]) words.add(word);
  words.delete("pool");
  return [...words];
}
function productsIn(text: string, words: readonly string[]): readonly string[] {
  const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return words.filter(word => new RegExp("(?<![A-Za-z0-9_-])" + escaped(word) + "(?![A-Za-z0-9_-])", "iu").test(text));
}
test("G078-C02 the contract names mechanisms only: no Harness or vendor name anywhere in its declarations", async () => {
  const words = productWords();
  assert.ok(words.length > 100, "the scan covers the whole catalog");
  // The scan itself finds a name where there is one, in any case, and leaves words that only contain one alone.
  assert.ok(productsIn("a Codex app-server keeps its threads", words).includes("codex"));
  const found = productsIn("claude code and OPENCLAW, dsh and Pi", words);
  for (const word of ["Claude Code", "openclaw", "dsh", "pi"]) assert.ok(found.includes(word), word);
  assert.deepEqual(productsIn("the host pool, a pinned session, a codexless word, opencoder, a pipe", words), []);
  const source = await readFile(fileURLToPath(new URL("../../../src/contracts/native-host.ts", import.meta.url)), "utf8");
  assert.ok(source.includes("export interface HostCapabilities"), "the contract source was read");
  assert.deepEqual(productsIn(source, words), []);
});
