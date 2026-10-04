// SPDX-License-Identifier: MIT
/**
 * `pnpm bench`: the model gateway's performance against the targets of
 * 03-model-plane section 11, on loopback with the strict fake upstream
 * (tools/fake-provider) and synthetic keys only. Usage (after pnpm build):
 * node dist/tests/perf/bench.js [--out DIR] [--quick]
 *
 * - Added latency: the same request sent directly to the fake upstream and
 *   through the gateway, alternately; non-streaming time to the whole body
 *   and streaming time to the first body byte, passed through (Chat to a
 *   Chat upstream) and translated (Anthropic Messages to a Chat upstream).
 *   The added latency of a pair is gateway minus direct.
 * - Per-chunk cost of the translated path, in process: upstream SSE chunks
 *   through the gateway's decoder, the tool and finish accumulation and the
 *   client protocol's sink into a response that discards its bytes; a
 *   chunk's cost is the time between the parser's requests for chunks.
 * - 200 concurrent streams of 50 chunks per second through the gateway
 *   (translated, then passed through): the daemon process's CPU time over the
 *   window in which every stream is open, and its peak resident memory. The
 *   daemon runs in its own process (hub.ts) with the per-credential
 *   concurrency limit raised to 256, as one credential serves all streams.
 * - Ledger commit: `appendModelCall` of a realistic entry on a file database,
 *   one at a time and in bursts of 200 at once.
 * - The daemon's memory after a full garbage collection, right after start
 *   and after the latency rounds: resident, heap in use and committed, and
 *   the young generation (tests/perf/README.md explains the difference).
 *
 * Results go to `<out>/bench.json` and a summary with the targets to
 * `<out>/bench.md` (default out: dist/bench). Targets are reported, not
 * enforced: the exit status is 0 whenever every measurement ran, and 1 when
 * one failed.
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type {
  CredentialId,
  ModelCallEntry,
  ModelCallId,
  ModelRef,
  ProviderId,
} from "@harnesshub/core/model-plane";
import { AnthropicSink } from "@harnesshub/gateway/anthropic";
import { ChatSink } from "@harnesshub/gateway/chat";
import { createDecoder } from "@harnesshub/gateway/decode";
import { GoogleSink } from "@harnesshub/gateway/google";
import { HttpWriter, type OutputSink } from "@harnesshub/gateway/output";
import type { ChatTranslation } from "@harnesshub/gateway/protocol";
import { ResponsesSink } from "@harnesshub/gateway/responses";
import { readCompletion } from "@harnesshub/gateway/upstream";
import { connectLocal } from "@harnesshub/sdk/local";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAKE = path.join(ROOT, "tools/fake-provider/index.mjs");
const HUB = fileURLToPath(new URL("./hub.js", import.meta.url));
const KEY_VARIABLE = "HH_BENCH_UPSTREAM_KEY";
const UPSTREAM_MODEL = "upstream-sim";

/** The targets of 03-model-plane section 11. */
const TARGETS = {
  addedNonStreamP99Ms: 10,
  addedFirstByteP99Ms: 15,
  chunkP99Us: 50,
  cores: 1,
  rssMB: 400,
  ledgerP99Ms: 5,
};

interface Distribution {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    n: sorted.length,
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

/** The JSON line a child prints when ready. */
async function ready(
  child: ChildProcess,
  name: string,
): Promise<Record<string, unknown>> {
  const lines = createInterface({ input: child.stdout! });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on(
    "data",
    (text: string) => (stderr = (stderr + text).slice(-4000)),
  );
  const exited = once(child, "exit").then(([code]) => {
    throw new Error(`${name} exited with ${String(code)}: ${stderr}`);
  });
  const found = (async () => {
    for await (const line of lines)
      if (line.startsWith("{")) {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (String(value.event).endsWith("ready")) return value;
      }
    throw new Error(`${name} closed its output before it was ready: ${stderr}`);
  })();
  try {
    return await Promise.race([found, exited]);
  } finally {
    lines.close();
    child.stdout!.resume();
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (!(await Promise.race([exited.then(() => true), delay(10_000, false)]))) {
    child.kill("SIGKILL");
    await exited;
  }
}

interface System {
  upstream: string;
  key: string;
  gateway: string;
  gatewayKey: string;
  hub: ChildProcess;
  close(): Promise<void>;
}

const STREAM_CHUNKS = 200;

/**
 * The environment of the benchmark's children: none of the developer's
 * variables (keys, proxies, product settings), a private home and no
 * catalog refresh.
 */
function isolated(root: string): Record<string, string> {
  const home = path.join(root, "home");
  return {
    PATH: path.dirname(process.execPath),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    HH_OFFLINE: "1",
  };
}

/** Start the fake upstream and the daemon, and create one Chat provider. */
async function startSystem(root: string): Promise<System> {
  const children: ChildProcess[] = [];
  const close = () => Promise.all(children.map(stop)).then(() => undefined);
  try {
    const key = `sk-synthetic-bench-${randomBytes(12).toString("hex")}`;
    const script = path.join(root, "script.json");
    await writeFile(
      script,
      JSON.stringify({
        turns: [
          {
            when: { contains: "[bench-stream]" },
            repeat: true,
            text: Array.from({ length: STREAM_CHUNKS }, () => "tok "),
            usage: { input: 50, output: STREAM_CHUNKS },
            chunkDelayMs: 20,
          },
          { repeat: true, text: "OK", usage: { input: 10, output: 1 } },
        ],
      }),
    );
    const fields = path.join(root, "fields.json");
    // OpenAI's Chat API takes stream_options, which the gateway sends.
    await writeFile(
      fields,
      JSON.stringify({ chat: { declared: { topLevel: ["stream_options"] } } }),
    );
    const fake = spawn(
      process.execPath,
      [
        FAKE,
        "--port",
        "0",
        "--mode",
        "whitelist",
        "--model",
        UPSTREAM_MODEL,
        "--key-env",
        KEY_VARIABLE,
        "--script",
        script,
        "--fields",
        fields,
        "--chunk-delay-ms",
        "0",
      ],
      {
        env: { ...isolated(root), [KEY_VARIABLE]: key },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(fake);
    const upstream = String((await ready(fake, "the fake provider")).url);
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const hub = fork(
      HUB,
      [
        dataDir,
        JSON.stringify({
          maxConcurrentPerCredential: 256,
          maxQueuedPerCredential: 256,
        }),
      ],
      {
        env: isolated(root),
        execArgv: ["--expose-gc"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(hub);
    const gateway = String((await ready(hub, "the daemon")).url).replace(
      /\/$/,
      "",
    );
    const admin = await connectLocal({ dataDir, url: gateway });
    await admin.providers.create({
      id: "bench",
      name: "bench",
      kind: "custom",
      endpoints: { chat: `${upstream}/v1` },
      models: {
        source: "manual",
        list: [
          {
            id: "sim",
            wire: UPSTREAM_MODEL,
            contextWindow: 128_000,
            maxOutputTokens: 8192,
          },
        ],
        expose: "all",
      },
      credential: { value: key },
    });
    const created = await admin.gatewayKeys.create({
      name: "bench",
      modelAllow: ["bench/*"],
      expiresAt: null,
    });
    return { upstream, key, gateway, gatewayKey: created.key, hub, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Path = "direct" | "passthrough" | "translated";

function request(system: System, path: Path, stream: boolean, prompt: string) {
  const messages = [{ role: "user", content: prompt }];
  switch (path) {
    case "direct":
      return {
        url: `${system.upstream}/v1/chat/completions`,
        headers: { authorization: `Bearer ${system.key}` },
        body: { model: UPSTREAM_MODEL, stream, messages },
      };
    case "passthrough":
      return {
        url: `${system.gateway}/v1/chat/completions`,
        headers: { authorization: `Bearer ${system.gatewayKey}` },
        body: { model: "bench/sim", stream, messages },
      };
    case "translated":
      return {
        url: `${system.gateway}/v1/messages`,
        headers: {
          "x-api-key": system.gatewayKey,
          "anthropic-version": "2023-06-01",
        },
        body: { model: "bench/sim", stream, max_tokens: 64, messages },
      };
  }
}

/**
 * Milliseconds to the whole body (`stream` false) or to the first body byte,
 * reading the rest afterwards; also the bytes read.
 */
async function timed(
  system: System,
  which: Path,
  stream: boolean,
  prompt = "hello",
): Promise<{ ms: number; bytes: number; text: string }> {
  const { url, headers, body } = request(system, which, stream, prompt);
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let first: number | undefined;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body!) {
    first ??= performance.now() - started;
    bytes += (chunk as Uint8Array).byteLength;
    chunks.push(chunk as Uint8Array);
  }
  const whole = performance.now() - started;
  if (response.status !== 200)
    throw new Error(
      `${which}: HTTP ${response.status} ${Buffer.concat(chunks).toString()}`,
    );
  return {
    ms: stream ? (first ?? whole) : whole,
    bytes,
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

async function addedLatency(system: System, rounds: number, warmup: number) {
  const result: Record<string, unknown> = {};
  for (const stream of [false, true]) {
    const samples: Record<Path, number[]> = {
      direct: [],
      passthrough: [],
      translated: [],
    };
    const added: Record<"passthrough" | "translated", number[]> = {
      passthrough: [],
      translated: [],
    };
    for (let round = 0; round < warmup + rounds; round++) {
      const direct = (await timed(system, "direct", stream)).ms;
      const passthrough = (await timed(system, "passthrough", stream)).ms;
      const translated = (await timed(system, "translated", stream)).ms;
      if (round < warmup) continue;
      samples.direct.push(direct);
      samples.passthrough.push(passthrough);
      samples.translated.push(translated);
      added.passthrough.push(passthrough - direct);
      added.translated.push(translated - direct);
    }
    result[stream ? "firstByte" : "nonStream"] = {
      directMs: distribution(samples.direct),
      passthroughMs: distribution(samples.passthrough),
      translatedMs: distribution(samples.translated),
      addedPassthroughMs: distribution(added.passthrough),
      addedTranslatedMs: distribution(added.translated),
    };
  }
  return result;
}

/** A ServerResponse that accepts every write at once and keeps nothing. */
function discardingResponse(): ServerResponse {
  let sent = false;
  let ended = false;
  const response = {
    get headersSent() {
      return sent;
    },
    destroyed: false,
    get writableEnded() {
      return ended;
    },
    socket: { destroyed: false },
    writeHead() {
      sent = true;
      return response;
    },
    flushHeaders() {},
    setHeader() {},
    write(_chunk: unknown, callback?: (error?: Error | null) => void) {
      sent = true;
      callback?.();
      return true;
    },
    end(_chunk?: unknown, callback?: () => void) {
      sent = true;
      ended = true;
      callback?.();
      return response;
    },
  };
  return response as unknown as ServerResponse;
}

/** SSE text of `count` upstream text chunks in `protocol`, one event per chunk. */
function upstreamEvents(
  protocol: "chat" | "anthropic",
  count: number,
): string[] {
  const sse = (value: unknown, event?: string) =>
    `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
  if (protocol === "chat") {
    const chunk = (
      delta: Record<string, unknown>,
      finish: string | null = null,
    ) =>
      sse({
        id: "chatcmpl-bench",
        object: "chat.completion.chunk",
        created: 0,
        model: UPSTREAM_MODEL,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    return [
      chunk({ role: "assistant", content: "" }),
      ...Array.from({ length: count }, () => chunk({ content: "tok " })),
      chunk({}, "stop"),
      "data: [DONE]\n\n",
    ];
  }
  return [
    sse(
      {
        type: "message_start",
        message: {
          id: "msg_bench",
          type: "message",
          role: "assistant",
          model: UPSTREAM_MODEL,
          content: [],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      "message_start",
    ),
    sse(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      "content_block_start",
    ),
    ...Array.from({ length: count }, () =>
      sse(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "tok " },
        },
        "content_block_delta",
      ),
    ),
    sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
    sse(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: count },
      },
      "message_delta",
    ),
    sse({ type: "message_stop" }, "message_stop"),
  ];
}

/**
 * Microseconds per upstream chunk through decoder, accumulation and sink:
 * the time between the parser's successive requests for the next chunk of
 * a stream that hands out one event per request.
 */
async function chunkCost(
  upstream: "chat" | "anthropic",
  inbound: "chat" | "responses" | "anthropic" | "gemini",
  count: number,
): Promise<number[]> {
  const encoder = new TextEncoder();
  const events = upstreamEvents(upstream, count).map((text) =>
    encoder.encode(text),
  );
  const pulls: number[] = [];
  let next = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls.push(performance.now());
        const event = events[next++];
        if (event) controller.enqueue(event);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const writer = new HttpWriter(discardingResponse());
  const translation: ChatTranslation = {
    body: { messages: [] },
    tools: new Map(),
    stream: true,
  };
  const context = {
    model: "bench/sim",
    reasoning: true,
    promptEstimate: 10,
    id: "bench",
    created: 0,
  };
  const sink: OutputSink =
    inbound === "chat"
      ? new ChatSink(writer, translation, context)
      : inbound === "responses"
        ? new ResponsesSink(writer, translation, context)
        : inbound === "anthropic"
          ? new AnthropicSink(writer, translation, context)
          : new GoogleSink(writer, translation, context, true);
  let ids = 0;
  const result = await readCompletion(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    sink,
    () => `call_${ids++}`,
    { maxBytes: 64 * 1024 * 1024, activity() {}, data() {} },
    upstream === "chat" ? undefined : createDecoder(upstream),
  );
  await sink.finish(result);
  // The content chunks only: the intervals that ended with one of them.
  const intervals: number[] = [];
  for (let index = 1; index < pulls.length; index++)
    intervals.push((pulls[index]! - pulls[index - 1]!) * 1000);
  const offset = upstream === "chat" ? 1 : 2;
  return intervals.slice(offset, offset + count);
}

async function perChunk(count: number) {
  const paths = [
    ["chat", "anthropic"],
    ["chat", "responses"],
    ["chat", "gemini"],
    ["anthropic", "chat"],
  ] as const;
  // Warm the code paths up before measuring.
  for (const [upstream, inbound] of paths)
    await chunkCost(upstream, inbound, 2_000);
  const result: Record<string, Distribution> = {};
  for (const [upstream, inbound] of paths)
    result[`${upstream} upstream → ${inbound} client`] = distribution(
      await chunkCost(upstream, inbound, count),
    );
  return result;
}

interface Usage {
  /** CPU time in µs, user and system. */
  cpu: number;
  /** Resident memory, used and committed V8 heap, young generation; bytes. */
  rss: number;
  heap: number;
  heapTotal: number;
  newSpace: number;
}

/** The daemon's CPU time and memory. */
async function usage(hub: ChildProcess): Promise<Usage> {
  const answer = once(hub, "message");
  hub.send("usage");
  const [value] = (await answer) as [
    Omit<Usage, "cpu"> & { cpu: { user: number; system: number } },
  ];
  return { ...value, cpu: value.cpu.user + value.cpu.system };
}

/** The daemon's memory in MB after a full garbage collection. */
async function collected(hub: ChildProcess) {
  const answer = once(hub, "message");
  hub.send("gc");
  const [done] = (await answer) as [{ collected: boolean }];
  if (!done.collected) throw new Error("the daemon cannot collect garbage");
  const value = await usage(hub);
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return {
    rssMB: mb(value.rss),
    heapUsedMB: mb(value.heap),
    heapTotalMB: mb(value.heapTotal),
    youngGenerationMB: mb(value.newSpace),
  };
}

async function concurrentStreams(
  system: System,
  which: "passthrough" | "translated",
  streams: number,
) {
  const before = await usage(system.hub);
  let peak = before.rss;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, (await usage(system.hub)).rss);
      await delay(100);
    }
  })();
  let opened = 0;
  let allOpen: () => void = () => undefined;
  const everyStreamOpen = new Promise<void>((resolve) => (allOpen = resolve));
  let firstEnd: () => void = () => undefined;
  const oneStreamEnded = new Promise<void>((resolve) => (firstEnd = resolve));
  const started = performance.now();
  const run = Promise.all(
    Array.from({ length: streams }, async () => {
      const { url, headers, body } = request(
        system,
        which,
        true,
        "[bench-stream] go",
      );
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      if (response.status !== 200)
        throw new Error(`${which}: HTTP ${response.status}`);
      let text = "";
      let counted = false;
      const decoder = new TextDecoder();
      for await (const chunk of response.body!) {
        text += decoder.decode(chunk as Uint8Array, { stream: true });
        if (!counted && text.includes("tok")) {
          counted = true;
          if (++opened === streams) allOpen();
        }
      }
      firstEnd();
      const tokens = text.match(/tok /g)?.length ?? 0;
      if (tokens !== STREAM_CHUNKS)
        throw new Error(
          `${which}: a stream carried ${tokens} of ${STREAM_CHUNKS} chunks`,
        );
    }),
  );
  await Promise.race([everyStreamOpen, run]);
  const windowStart = { at: performance.now(), usage: await usage(system.hub) };
  await Promise.race([oneStreamEnded, run]);
  const windowEnd = { at: performance.now(), usage: await usage(system.hub) };
  await run;
  const total = performance.now() - started;
  sampling = false;
  await sampler;
  const after = await usage(system.hub);
  const wallMs = windowEnd.at - windowStart.at;
  const cpuMs = (windowEnd.usage.cpu - windowStart.usage.cpu) / 1000;
  return {
    streams,
    chunksPerStream: STREAM_CHUNKS,
    chunkIntervalMs: 20,
    windowMs: Math.round(wallMs),
    cores: Math.round((cpuMs / wallMs) * 1000) / 1000,
    wholeRunCores:
      Math.round(((after.cpu - before.cpu) / 1000 / total) * 1000) / 1000,
    rssBeforeMB: Math.round(before.rss / 1024 / 1024),
    heapBeforeMB: Math.round(before.heap / 1024 / 1024),
    rssPeakMB: Math.round(peak / 1024 / 1024),
    totalMs: Math.round(total),
  };
}

function ledgerEntry(index: number): ModelCallEntry {
  const now = new Date().toISOString();
  return {
    callId:
      `call_bench_${index}_${randomBytes(4).toString("hex")}` as ModelCallId,
    occurredAt: now,
    inbound: { protocol: "anthropic", path: "/v1/messages", stream: true },
    modelRef: "bench/sim" as ModelRef,
    provider: "bench" as ProviderId,
    credentialId: "default" as CredentialId,
    conversationKey: randomBytes(32).toString("hex"),
    agent: { id: "claude", source: "user-agent" },
    patches: [],
    unmapped: [],
    status: 200,
    usage: {
      input: 12_000,
      cacheRead: 9_000,
      cacheWrite: 0,
      output: 640,
      reasoning: 120,
      source: "reported",
    },
    timing: { durationMs: 4_200, firstByteMs: 380 },
    attempts: [
      {
        provider: "bench" as ProviderId,
        credentialId: "default" as CredentialId,
        modelRef: "bench/sim" as ModelRef,
        wireModel: UPSTREAM_MODEL,
        upstreamProtocol: "chat",
        startedAt: now,
        firstByteMs: 350,
        status: 200,
        decision: "success",
      },
    ],
    cost: { amountUsd: 0.0123, priceSource: "catalog" },
  };
}

async function ledger(
  root: string,
  serial: number,
  bursts: number,
  burst: number,
) {
  const file = path.join(root, "ledger", "harnesshub.sqlite");
  const owner = new SqliteStore(file);
  const release = owner.acquireOwner();
  const plane = new SqliteModelPlaneStore(file);
  try {
    let index = 0;
    for (let warm = 0; warm < 100; warm++)
      await plane.appendModelCall(ledgerEntry(index++));
    const one: number[] = [];
    for (let count = 0; count < serial; count++) {
      const entry = ledgerEntry(index++);
      const started = performance.now();
      await plane.appendModelCall(entry);
      one.push(performance.now() - started);
    }
    const together: number[] = [];
    for (let round = 0; round < bursts; round++) {
      const entries = Array.from({ length: burst }, () => ledgerEntry(index++));
      const started = performance.now();
      await Promise.all(
        entries.map(async (entry) => {
          await plane.appendModelCall(entry);
          together.push(performance.now() - started);
        }),
      );
    }
    return {
      serialMs: distribution(one),
      burstMs: distribution(together),
      burst,
    };
  } finally {
    plane.close();
    release();
    owner.close();
  }
}

function status(value: number, target: number): string {
  return value <= target ? "within" : "over";
}

function summary(results: Record<string, unknown>): string {
  const latency = results.addedLatency as Record<
    string,
    Record<string, Distribution>
  >;
  const chunks = results.perChunkUs as Record<string, Distribution>;
  const load = results.concurrency as Record<
    string,
    {
      cores: number;
      rssBeforeMB: number;
      rssPeakMB: number;
      windowMs: number;
      wholeRunCores: number;
    }
  >;
  const memory = results.memory as {
    idle: { rssMB: number; heapUsedMB: number };
    afterLatency: {
      rssMB: number;
      heapUsedMB: number;
      youngGenerationMB: number;
    };
    gatewayCalls: number;
  };
  const commits = results.ledger as {
    serialMs: Distribution;
    burstMs: Distribution;
    burst: number;
  };
  const worstChunk = Math.max(
    ...Object.values(chunks).map((value) => value.p99),
  );
  const rows: string[][] = [
    ["Metric", "Target", "Measured", "Status"],
    ...(["passthrough", "translated"] as const).flatMap((which) => {
      const key =
        which === "passthrough" ? "addedPassthroughMs" : "addedTranslatedMs";
      return [
        [
          `Added latency, non-streaming, ${which} (p99)`,
          `≤ ${TARGETS.addedNonStreamP99Ms} ms`,
          `${latency.nonStream![key]!.p99} ms`,
          status(latency.nonStream![key]!.p99, TARGETS.addedNonStreamP99Ms),
        ],
        [
          `Added latency, first byte, ${which} (p99)`,
          `≤ ${TARGETS.addedFirstByteP99Ms} ms`,
          `${latency.firstByte![key]!.p99} ms`,
          status(latency.firstByte![key]!.p99, TARGETS.addedFirstByteP99Ms),
        ],
      ];
    }),
    ...Object.entries(chunks).map(([name, value]) => [
      `Per-chunk cost, ${name} (p99)`,
      `≤ ${TARGETS.chunkP99Us} µs`,
      `${value.p99} µs`,
      status(value.p99, TARGETS.chunkP99Us),
    ]),
    ...Object.entries(load).flatMap(([which, value]) => [
      [
        `200 streams × 50 chunks/s, ${which}: daemon CPU`,
        `≤ ${TARGETS.cores} core`,
        `${value.cores} cores`,
        status(value.cores, TARGETS.cores),
      ],
      [
        `200 streams × 50 chunks/s, ${which}: daemon peak RSS`,
        `≤ ${TARGETS.rssMB} MB`,
        `${value.rssPeakMB} MB (${value.rssBeforeMB} MB before)`,
        status(value.rssPeakMB, TARGETS.rssMB),
      ],
    ]),
    [
      "Ledger commit, one at a time (p99)",
      `≤ ${TARGETS.ledgerP99Ms} ms`,
      `${commits.serialMs.p99} ms`,
      status(commits.serialMs.p99, TARGETS.ledgerP99Ms),
    ],
    [
      `Ledger commit, ${commits.burst} queued at once (p99 until committed)`,
      `≤ ${TARGETS.ledgerP99Ms} ms`,
      `${commits.burstMs.p99} ms`,
      status(commits.burstMs.p99, TARGETS.ledgerP99Ms),
    ],
  ];
  const environment = results.environment as Record<string, string>;
  return [
    "# Gateway benchmark",
    "",
    `${environment.date} · ${environment.platform} ${environment.arch} · ${environment.cpu} · Node ${environment.node} · ${environment.commit}`,
    "",
    "Targets of 03-model-plane section 11; reported, not enforced. Loopback, strict fake upstream, synthetic keys.",
    "",
    ...rows.map((row, index) =>
      index === 1
        ? `|${row.map(() => "---").join("|")}|\n| ${row.join(" | ")} |`
        : `| ${row.join(" | ")} |`,
    ),
    "",
    `Worst per-chunk p99: ${worstChunk} µs. Distributions, sample counts and the measurement windows are in bench.json.`,
    "",
    `Daemon memory after a full GC: ${memory.idle.rssMB} MB resident, ${memory.idle.heapUsedMB} MB heap in use right after start; ${memory.afterLatency.rssMB} MB resident, ${memory.afterLatency.heapUsedMB} MB heap in use (${memory.afterLatency.youngGenerationMB} MB young generation committed) after ${memory.gatewayCalls} gateway calls. Heap in use that grows with the calls is retained memory; the resident growth beside it is the young generation and allocator pages (tests/perf/README.md).`,
    "",
    `Ledger appends that arrive together are written in one transaction (group commit, synchronous=FULL), so the ${commits.burst} appends of a burst are durable together; the time is mostly that transaction's commit, which depends on the platform's fsync.`,
    "",
  ].join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      quick: { type: "boolean", default: false },
    },
  });
  const out = path.resolve(values.out ?? path.join(ROOT, "dist", "bench"));
  const quick = values.quick === true;
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-bench-"));
  let system: System | undefined;
  try {
    const { execFileSync } = await import("node:child_process");
    let commit = "unknown";
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
    } catch {
      /* Not a checkout: the commit stays unknown. */
    }
    const results: Record<string, unknown> = {
      environment: {
        date: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        cpu: `${os.cpus()[0]?.model ?? "unknown"} × ${os.cpus().length}`,
        node: process.versions.node,
        commit,
      },
      targets: TARGETS,
    };
    console.error("bench: per-chunk cost (in process)");
    results.perChunkUs = await perChunk(quick ? 5_000 : 50_000);
    console.error("bench: ledger commits");
    results.ledger = await ledger(
      root,
      quick ? 500 : 2_000,
      quick ? 2 : 5,
      200,
    );
    system = await startSystem(root);
    const idle = await collected(system.hub);
    console.error("bench: added latency");
    const rounds = quick ? 200 : 1_000;
    const warmup = quick ? 50 : 100;
    results.addedLatency = await addedLatency(system, rounds, warmup);
    results.memory = {
      idle,
      afterLatency: await collected(system.hub),
      gatewayCalls: (rounds + warmup) * 4,
    };
    console.error("bench: 200 concurrent streams");
    results.concurrency = {
      translated: await concurrentStreams(system, "translated", 200),
      passthrough: await concurrentStreams(system, "passthrough", 200),
    };
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, "bench.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    const text = summary(results);
    await writeFile(path.join(out, "bench.md"), text);
    console.log(text);
    console.log(`Results: ${path.join(out, "bench.json")}`);
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return 1;
  } finally {
    await system?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

process.exitCode = await main();
