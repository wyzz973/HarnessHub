// SPDX-License-Identifier: MIT
/**
 * Real agents, wired by the daemon and run offline in a sandbox (10
 * section 3.3, the Adapter suite's online part): for each core agent
 * installed on this machine, the daemon (in process, `HH_OFFLINE=1`, file
 * secret backend) wires it into a temporary home towards a Chat Completions
 * provider on the strict fake upstream, and the agent's own non-interactive
 * mode runs in the Seatbelt sandbox of support.ts, three times:
 *
 * - **chat**: a random `PONG-…` comes back through the gateway with the
 *   agent's own `agent:` key; the same run checks **stream** (streamed
 *   client and upstream legs, the ledger's first byte time) and **usage**
 *   (scripted counts normalized in the ledger and summed by `hh usage`);
 * - **tools**: the upstream asks for the agent's own read tool on a file in
 *   the working directory and answers the file's random token only when the
 *   tool result carries it, so the token in the agent's output proves the
 *   round trip;
 * - **cancel**: a slow answer is cut by killing the agent's process group;
 *   the gateway must abort the upstream response and record a 499.
 *
 * Unwiring must restore the files byte for byte. Each agent's row goes to
 * the results file that `pnpm test:conformance` turns into
 * docs/compatibility.md. An agent that is not installed is skipped and
 * listed as such.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import type { ApiModelCall } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeProvider } from "../support/fake-provider.js";
import {
  agentSandbox,
  bytesOf,
  findAgent,
  record,
  runSandboxed,
  sandboxUnavailable,
  scrub,
  startSandboxed,
  type AgentRun,
  type ConformanceItem,
  type ConformanceResult,
} from "./support.js";

const KEY = "sk-synthetic-conformance-0001";
const MODEL = "fake/upstream-sim";
/** The same upstream on its Anthropic endpoint, for agents of that protocol. */
const ANTHROPIC_MODEL = "fake-anthropic/upstream-sim";
const RUN_TIMEOUT_MS = 120_000;
/** How long a run with the proxy variables may take before it counts as stuck. */
const PROBE_TIMEOUT_MS = 45_000;
/** Usage every scripted answer reports: 30 of the 80 output tokens are reasoning. */
const USAGE = { input: 1200, output: 80, reasoning: 30 };
/** The same, as the ledger keeps Chat usage: reasoning beside the output. */
const LEDGER_USAGE = {
  input: 1200,
  cacheRead: 0,
  cacheWrite: 0,
  output: 50,
  reasoning: 30,
};
/** The same from the Anthropic endpoint, which reports no reasoning count. */
const ANTHROPIC_LEDGER_USAGE = {
  input: 1200,
  cacheRead: 0,
  cacheWrite: 0,
  output: 80,
  reasoning: 0,
};
/** The slow answer the cancel run cuts: a word every 400 ms for 40 s. */
const SLOW_WORDS = Array.from({ length: 100 }, (_, index) => `w${index} `);
const SLOW_CHUNK_MS = 400;
/** The answer to a tool result that does not hold the token. */
const NO_TOKEN = "NO-TOKEN-IN-THE-TOOL-RESULT";

/** How the answered calls reached the Anthropic endpoint: mode and the beta fields stripped. */
function anthropicPath(calls: ApiModelCall[]): string {
  const modes = [...new Set(calls.map((call) => call.mode ?? "unknown"))];
  const stripped = [
    ...new Set(
      calls.flatMap((call) =>
        call.patches
          .filter((patch) => patch.startsWith("anthropic-strip-beta-fields:"))
          .map((patch) => patch.slice("anthropic-strip-beta-fields:".length)),
      ),
    ),
  ];
  const merged = calls.some((call) =>
    call.patches.includes("merge-system-messages"),
  );
  return `${modes.join(", ")}; stripped ${stripped.length ? stripped.join(", ") : "nothing"}${merged ? "; system messages merged" : ""}`;
}

interface AgentSpec {
  id: string;
  executable: string;
  /**
   * `anthropic`: the agent is wired to the upstream's Anthropic endpoint,
   * which its requests pass through to (Claude Code); otherwise to Chat.
   */
  upstream?: "anthropic";
  /** Install directories outside PATH, relative to the account's home. */
  installDirectories?: string[];
  /** The documented non-interactive mode with `prompt`. */
  args(prompt: string): string[];
  /**
   * The agent's own tool that reads a file, and its arguments for `file`
   * (an absolute path in the working directory); absent when the agent
   * cannot run one non-interactively without switching its safety prompts
   * off, and `toolsNotRun` says why.
   */
  readTool?: { name: string; args(file: string): Record<string, unknown> };
  toolsNotRun?: string;
  /**
   * Why the tool runs but cannot read the file here: the tools item is then
   * partial, which the suite accepts.
   */
  toolsLimitation?: string;
  /**
   * When no request reaches the gateway with the refused proxy variables
   * set, the agent runs again without them (the sandbox still allows only
   * the gateway's port), and the first run is recorded.
   */
  proxyProbe?: boolean;
  /**
   * A shortcoming of the request the agent sends, which the strict upstream
   * rejects although the wiring works: the run is then partially verified.
   */
  knownUpstreamRejection?: RegExp;
  /** Notes when the agent says something worth recording. */
  notes?(run: { stdout: string; stderr: string }): string[];
}

const AGENTS: AgentSpec[] = [
  {
    id: "claude",
    executable: "claude",
    upstream: "anthropic",
    args: (prompt) => ["-p", prompt],
    readTool: { name: "Read", args: (file) => ({ file_path: file }) },
    notes: ({ stderr }) =>
      /auto-mode-classifier-billing/.test(stderr)
        ? [
            "prints that auto mode's classifier billing needs a gateway feature (code.claude.com/docs/en/auto-mode-classifier-billing); requests work",
          ]
        : [],
  },
  {
    id: "codex",
    executable: "codex",
    args: (prompt) => ["exec", "--skip-git-repo-check", prompt],
    // Codex reads files with a command, which `codex exec` runs in its own
    // read-only sandbox without asking.
    readTool: {
      name: "exec_command",
      args: (file) => ({ cmd: `cat ${path.basename(file)}` }),
    },
    toolsLimitation:
      "Codex runs the command in its own Seatbelt sandbox, which cannot start inside the suite's (sandbox-exec: sandbox_apply: Operation not permitted); only --sandbox danger-full-access would run it, which the suite does not use",
  },
  {
    id: "gemini",
    executable: "gemini",
    args: (prompt) => ["-p", prompt],
    readTool: { name: "read_file", args: (file) => ({ file_path: file }) },
    proxyProbe: true,
  },
  {
    id: "opencode",
    executable: "opencode",
    args: (prompt) => ["run", prompt],
    readTool: { name: "read", args: (file) => ({ filePath: file }) },
  },
  {
    id: "pi",
    executable: "pi",
    args: (prompt) => ["-p", prompt],
    readTool: { name: "read", args: (file) => ({ path: file }) },
    knownUpstreamRejection: /max_completion_tokens/,
  },
  {
    id: "hermes",
    executable: "hermes",
    args: (prompt) => ["chat", "-Q", "-q", prompt],
    readTool: { name: "read_file", args: (file) => ({ path: file }) },
  },
  {
    id: "mimocode",
    executable: "mimo",
    installDirectories: [".mimocode/bin"],
    args: (prompt) => ["run", prompt],
    readTool: { name: "read", args: (file) => ({ filePath: file }) },
    knownUpstreamRejection: /system message must be the first message/,
  },
  {
    // Grok Build's non-interactive flag is from xAI's documentation; it has
    // not run here (no grok binary on the machine this suite was made on).
    id: "grok",
    executable: "grok",
    args: (prompt) => ["-p", prompt],
    toolsNotRun: "its read tool is not known here",
  },
];

/** The first line of `text` that looks like an error, for a reason. */
function firstError(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /error|failed|unauthori[sz]ed|login|denied/i.test(line))
    ?.slice(0, 300);
}

/** ` (added KEY, …)`: top-level JSON keys `after` has and `before` lacks. */
function addedKeys(
  before: Buffer | undefined,
  after: Buffer | undefined,
): string {
  try {
    const keys = (bytes: Buffer | undefined) =>
      bytes ? Object.keys(JSON.parse(bytes.toString("utf8")) as object) : [];
    const had = new Set(keys(before));
    const added = keys(after).filter((key) => !had.has(key));
    return added.length ? ` (added ${added.join(", ")})` : "";
  } catch {
    // Not JSON: the note names the file only.
    return "";
  }
}

/** Runs the real `hh` launcher and parses its `--json` output. */
function hhJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0)
        reject(new Error(`hh ${args[0]} exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout) as unknown);
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `condition` every 100 ms for up to `ms`; resolves to whether it held. */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await wait(100);
  }
  return condition();
}

const pass = (detail: string): ConformanceItem => ({ result: "pass", detail });
const notRun = (detail: string): ConformanceItem => ({
  result: "not run",
  detail,
});
const fail = (detail: string): ConformanceItem => ({ result: "fail", detail });

const today = new Date().toISOString().slice(0, 10);
const platform = `${process.platform}-${process.arch}`;

for (const spec of AGENTS)
  void test(
    `${spec.id}: wired by the daemon, runs offline in a sandbox: chat, tools, stream, cancel and usage`,
    { timeout: 420_000 },
    async (t) => {
      const unavailable = await sandboxUnavailable();
      if (unavailable) return t.skip(unavailable);
      const found = await findAgent(
        spec.executable,
        (spec.installDirectories ?? []).map((directory) =>
          path.join(os.userInfo().homedir, directory),
        ),
      );
      const row = (
        fields: Omit<ConformanceResult, "agent" | "date" | "platform">,
      ) => record({ agent: spec.id, date: today, platform, ...fields });
      if (!found) {
        await row({
          name: spec.id,
          version: "-",
          status: "not installed",
          notes: [],
        });
        return t.skip(`${spec.executable} is not installed outside wrappers`);
      }
      const sandbox = await agentSandbox(t, found.directory);
      const proxied = sandbox.env(true);

      // The version, in the sandbox before anything is wired.
      const versionRun = await runSandboxed(
        sandbox,
        found.file,
        ["--version"],
        { env: proxied, timeoutMs: 30_000 },
      );
      const version =
        (versionRun.stdout + versionRun.stderr)
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean)
          ?.slice(0, 80) ?? "unknown";

      // The strict upstream: each run's prompt carries a marker that its
      // turns match, and every answer reports the same usage.
      const reply = `PONG-${randomBytes(4).toString("hex")}`;
      const token = `TOKEN-${randomBytes(4).toString("hex")}`;
      const tokenFile = path.join(sandbox.work, "token.txt");
      await writeFile(tokenFile, `${token}\n`);
      const read = spec.readTool;
      const upstream = await startFakeProvider({
        models: ["upstream-sim"],
        keys: { upstream: KEY },
        chunkDelayMs: 0,
        script: {
          turns: [
            {
              when: { contains: "[hh:chat]" },
              repeat: true,
              text: reply,
              usage: USAGE,
            },
            ...(read
              ? [
                  {
                    when: {
                      contains: "[hh:tools]",
                      offersTool: read.name,
                      toolResult: false,
                    },
                    toolCalls: [
                      { name: read.name, arguments: read.args(tokenFile) },
                    ],
                    usage: USAGE,
                  },
                  {
                    // Only a request that offers tools is the agent's own
                    // answer; a title or summary request beside it is
                    // answered at once.
                    when: { contains: "[hh:cancel]", offersTool: read.name },
                    repeat: true,
                    text: SLOW_WORDS,
                    chunkDelayMs: SLOW_CHUNK_MS,
                    usage: USAGE,
                  },
                ]
              : []),
            {
              when: { toolResultContains: token },
              repeat: true,
              text: `The file holds ${token}.`,
              usage: USAGE,
            },
            {
              // The call came back answered, but without the file's token.
              when: { contains: "[hh:tools]", toolResult: true },
              repeat: true,
              text: NO_TOKEN,
              usage: USAGE,
            },
            { repeat: true, text: "OK", usage: USAGE },
          ],
        },
      });
      sandbox.defer(() => upstream.close());
      const dataDir = path.join(sandbox.root, "data");
      const hub = await startHub({
        dataDir,
        configDir: path.join(sandbox.root, "config"),
        secretsBackend: "file",
        demo: true,
        cwd: sandbox.root,
        port: 0,
        host: "127.0.0.1",
        catalog: { autoRefresh: false },
        wiringHome: { home: sandbox.home, env: proxied },
      });
      sandbox.defer(() => hub.server.close());
      const client = await connectLocal({ dataDir, url: hub.url });
      await client.providers.create({
        id: "fake",
        name: "Strict fake upstream",
        kind: "custom",
        endpoints: { chat: `${upstream.url}/v1` },
        // The strict upstream refuses OpenAI-only fields (the gateway asks
        // for usage with stream_options, Codex sends parallel_tool_calls,
        // Pi store and max_completion_tokens) and system messages after
        // the first (MiMo), as strict Chat-compatible relays do.
        patches: {
          chat: {
            patches: [
              "drop-fields",
              "max-tokens-field",
              "merge-system-messages",
            ],
            dropFields: ["stream_options", "parallel_tool_calls", "store"],
            maxTokensField: "max_tokens",
          },
        },
        models: {
          source: "manual",
          list: [
            {
              id: "upstream-sim",
              contextWindow: 128_000,
              maxOutputTokens: 8192,
            },
          ],
          expose: "all",
        },
        credential: { value: KEY },
      });
      // Anthropic's own auth; beta fields stripped as for strict
      // Anthropic-compatible relays.
      await client.providers.create({
        id: "fake-anthropic",
        name: "Strict fake upstream, Anthropic",
        kind: "custom",
        endpoints: { anthropic: upstream.url },
        auth: { apiKeyHeader: "x-api-key" },
        patches: { anthropic: { patches: ["anthropic-strip-beta-fields"] } },
        models: {
          source: "manual",
          list: [
            {
              id: "upstream-sim",
              contextWindow: 128_000,
              maxOutputTokens: 8192,
            },
          ],
          expose: "all",
        },
        credential: { value: KEY },
      });
      const agent = await client.agents.get(spec.id);
      assert.notEqual(
        agent.installation.status,
        "not-found",
        "the daemon detects the agent on the sandbox's PATH",
      );

      // Each file wiring writes holds a line of the user's first when its
      // format has comments, so that restoring is more than deleting.
      const input = {
        model: spec.upstream === "anthropic" ? ANTHROPIC_MODEL : MODEL,
      };
      const first = await client.agents.plan(spec.id, input);
      const before = new Map<string, Buffer | undefined>();
      for (const file of first.files) {
        if (["toml", "yaml", "dotenv"].includes(file.format) && !file.exists) {
          await mkdir(path.dirname(file.path), { recursive: true });
          await writeFile(file.path, "# the user's own line\n");
        }
        before.set(file.path, await bytesOf(file.path));
      }
      const plan = await client.agents.plan(spec.id, input);
      await client.agents.wire(spec.id, { ...input, expect: plan });
      const wiring = (await client.agents.get(spec.id)).wiring!;
      const wired = new Map<string, Buffer | undefined>();
      for (const file of plan.files)
        wired.set(file.path, await bytesOf(file.path));

      const gatewayPort = Number(new URL(hub.url).port);
      const seen = new Set<string>();
      /** The agent's ledger rows since the last call, oldest first. */
      const newCalls = async (): Promise<ApiModelCall[]> => {
        const rows = (await client.modelCalls.list({ limit: 200 })).items
          .filter(
            (call) =>
              call.keyId === wiring.keyId &&
              call.scope?.kind === "agent" &&
              call.scope.adapterId === spec.id &&
              !seen.has(call.callId),
          )
          .reverse();
        for (const call of rows) seen.add(call.callId);
        return rows;
      };
      const notes: string[] = [];
      const runAgent = (
        prompt: string,
        env: Record<string, string>,
        timeoutMs = RUN_TIMEOUT_MS,
      ) =>
        runSandboxed(sandbox, found.file, spec.args(prompt), {
          env,
          gatewayPort,
          timeoutMs,
        });

      // 1. Chat, with stream and usage.
      const chatPrompt = "[hh:chat] Reply with the word you are given.";
      let env = proxied;
      let run: AgentRun = await runAgent(
        chatPrompt,
        env,
        spec.proxyProbe ? PROBE_TIMEOUT_MS : RUN_TIMEOUT_MS,
      );
      let chatCalls = await newCalls();
      if (spec.proxyProbe && chatCalls.length === 0) {
        const error = firstError(run.stderr + run.stdout);
        notes.push(
          `with HTTP(S)_PROXY at a refused port and NO_PROXY=127.0.0.1,localhost no request reached the loopback gateway (${run.timedOut ? `${PROBE_TIMEOUT_MS / 1000} s` : `exit ${run.code ?? run.signal}`}${error ? `: ${error}` : ""}); it runs without proxy variables, the sandbox still allowing only the gateway's port`,
        );
        env = sandbox.env(false);
        run = await runAgent(chatPrompt, env);
        chatCalls = await newCalls();
      }
      await upstream.idle();
      const answered = chatCalls.filter((call) => call.status === 200);
      const printed = run.stdout.includes(reply);
      notes.push(...(spec.notes?.(run) ?? []));
      const status: ConformanceResult["status"] =
        chatCalls.length === 0
          ? "blocked"
          : answered.length && printed
            ? "wiring verified"
            : "partially verified";
      const upstreamError = chatCalls.find(
        (call) => call.status !== 200,
      )?.error;
      const runError = firstError(run.stderr + run.stdout);
      const reason =
        status === "blocked"
          ? `no request reached the gateway (${run.timedOut ? `timed out after ${RUN_TIMEOUT_MS / 1000} s` : `exit ${run.code ?? run.signal}`}${runError ? `: ${runError}` : ""})`
          : status === "partially verified"
            ? answered.length
              ? "the upstream answered but the agent did not print the reply"
              : `the agent's requests reached the gateway with its key; the strict upstream rejected them: ${typeof upstreamError === "string" ? upstreamError : JSON.stringify(upstreamError)}`
            : undefined;
      const working = status === "wiring verified";
      const skipped = notRun(
        status === "blocked"
          ? "no request reached the gateway"
          : "the strict upstream rejects the agent's requests",
      );

      // Stream: the agent's streamed calls were streamed upstream too, and
      // the ledger has their first byte time.
      const upstreamRecords = upstream.records();
      const streamed = answered.filter((call) => call.inbound.stream);
      const firstBytes = streamed.flatMap((call) =>
        call.timing.firstByteMs === undefined ? [] : [call.timing.firstByteMs],
      );
      const stream: ConformanceItem = !working
        ? skipped
        : streamed.length === 0
          ? notRun("the agent asked for no streamed answer")
          : firstBytes.length === streamed.length &&
              upstreamRecords.some((entry) => entry.stream === true)
            ? pass(
                `${streamed.length} of ${answered.length} calls streamed on both legs; first byte after ${Math.min(...firstBytes)}–${Math.max(...firstBytes)} ms`,
              )
            : fail(
                `ledger ${JSON.stringify(streamed.map((call) => call.timing.firstByteMs))}, upstream ${JSON.stringify(upstreamRecords.map((entry) => entry.stream))}`,
              );

      // Usage: every answer's scripted counts, normalized, in the ledger and
      // summed by `hh usage` for the agent's key.
      let usage: ConformanceItem = skipped;
      if (working) {
        const ledgerUsage =
          spec.upstream === "anthropic" ? ANTHROPIC_LEDGER_USAGE : LEDGER_USAGE;
        const normal = (value: unknown) =>
          JSON.stringify(value, Object.keys(ledgerUsage).sort());
        const wrong = answered.filter(
          (call) =>
            call.usage?.source !== "reported" ||
            normal(call.usage) !== normal(ledgerUsage),
        );
        const report = (await hhJson([
          "usage",
          "--by",
          "key",
          "--json",
          "--url",
          hub.url,
          "--data-dir",
          dataDir,
        ])) as {
          items: Array<{ key: string; calls: number; usage: unknown }>;
        };
        const bucket = report.items.find((item) => item.key === wiring.keyId);
        const expected = Object.fromEntries(
          Object.entries(ledgerUsage).map(([name, value]) => [
            name,
            value * answered.length,
          ]),
        );
        usage =
          wrong.length === 0 &&
          bucket?.calls === chatCalls.length &&
          normal(bucket.usage) === normal(expected)
            ? pass(
                spec.upstream === "anthropic"
                  ? `each answer reported input 1200 and output 80 on the Anthropic endpoint (${anthropicPath(answered)}); the ledger keeps them, and hh usage sums ${answered.length} answer${answered.length === 1 ? "" : "s"}`
                  : `each answer reported input 1200 and output 80 with 30 reasoning; the ledger keeps output 50 and reasoning 30, and hh usage sums ${answered.length} answer${answered.length === 1 ? "" : "s"}`,
              )
            : fail(
                `ledger ${JSON.stringify(answered.map((call) => call.usage))}; hh usage ${JSON.stringify(bucket)}`,
              );
      }

      // 2. Tools: the agent's own read tool on the token file.
      let tools: ConformanceItem;
      if (!read) tools = notRun(spec.toolsNotRun ?? "no read tool known");
      else if (!working) tools = skipped;
      else {
        const toolRun = await runAgent(
          "[hh:tools] Read the file token.txt in the current directory and reply with the token it holds.",
          env,
        );
        const toolCalls = await newCalls();
        await upstream.idle();
        const roundTrip = toolRun.stdout.includes(token);
        const ok = toolCalls.filter((call) => call.status === 200).length;
        const error = firstError(toolRun.stderr + toolRun.stdout);
        if (process.env.HARNESSHUB_TEST_CONFORMANCE_DEBUG)
          process.stderr.write(
            `--- ${spec.id} tools run\n${scrub(toolRun.stdout.slice(-3000), sandbox)}\n${scrub(toolRun.stderr.slice(-3000), sandbox)}\n`,
          );
        tools =
          roundTrip && ok >= 2
            ? pass(
                `${read.name} read the file; the token came back in the next request and in the output (${ok} answered ledger rows)`,
              )
            : toolRun.stdout.includes(NO_TOKEN)
              ? {
                  result: "partial",
                  detail: `the ${read.name} call reached the agent and its result came back through the gateway, but without the file's token${spec.toolsLimitation ? `: ${spec.toolsLimitation}` : ""}`,
                }
              : fail(
                  `${roundTrip ? "token printed" : "no token in the output"}; ${ok} answered ledger rows of ${toolCalls.length}${error ? `; ${error}` : ""}`,
                );
      }

      // 3. Cancel: the agent is killed during a slow answer.
      let cancel: ConformanceItem = skipped;
      if (working && read) {
        const recordsBefore = upstream.records().length;
        const started = Date.now();
        const cancelRun = await startSandboxed(
          sandbox,
          found.file,
          spec.args("[hh:cancel] Reply with the word you are given, slowly."),
          { env, gatewayPort, timeoutMs: RUN_TIMEOUT_MS },
        );
        const streaming = await until(
          () => upstream.activity().responses > 0,
          60_000,
        );
        // A few words stream to the agent before it is cut off.
        if (streaming) await wait(SLOW_CHUNK_MS * 5);
        const killedAfter = Date.now() - started;
        const printedBefore = cancelRun.stdout();
        cancelRun.kill();
        await cancelRun.done;
        const closed = await until(
          () => upstream.activity().responses === 0,
          10_000,
        );
        await upstream.idle();
        const cut = upstream
          .records(recordsBefore)
          .filter((entry) => entry.aborted === true);
        const cancelCalls = await newCalls();
        const cancelled = cancelCalls.filter(
          (call) =>
            call.status === 499 &&
            (call.errorClass === "client_cancelled" ||
              call.errorClass === "engine_disconnected"),
        );
        const activity = upstream.activity();
        const deltas = /\bw0\b/.test(printedBefore)
          ? "the agent printed streamed words before it was killed"
          : "the agent prints only at the end, so the streamed words do not show in its output";
        cancel =
          streaming &&
          closed &&
          cut.length > 0 &&
          cancelled.length > 0 &&
          activity.responses === 0 &&
          activity.timers === 0
            ? pass(
                `killed after ${killedAfter} ms; the gateway closed the upstream response and recorded 499 ${cancelled[0]!.errorClass}; ${deltas}`,
              )
            : fail(
                `upstream streaming ${streaming}, closed ${closed}, aborted records ${cut.length}, ledger ${JSON.stringify(cancelCalls.map((call) => [call.status, call.errorClass]))}, activity ${JSON.stringify(activity)}`,
              );
      } else if (working)
        cancel = notRun("no read tool to tell its request apart");

      // Unwiring restores the files; an agent that rewrote one keeps its
      // changes, and only HarnessHub's entries are taken out.
      const changed = new Map<string, string>();
      for (const file of plan.files) {
        const bytes = await bytesOf(file.path);
        const then = wired.get(file.path);
        if (bytes === undefined ? then !== undefined : !then?.equals(bytes))
          changed.set(file.path, addedKeys(then, bytes));
      }
      await client.agents.unwire(spec.id);
      for (const file of plan.files) {
        const after = await bytesOf(file.path);
        if (changed.has(file.path)) {
          notes.push(
            `the agent rewrote ${scrub(file.path, sandbox).replace("<sandbox>/home", "~")} while running${changed.get(file.path)}; unwiring took out HarnessHub's entries and kept the rest`,
          );
          assert.ok(
            !after?.toString("utf8").includes("hhk_"),
            `${file.path} holds no Gateway Key after unwiring`,
          );
        } else
          assert.deepEqual(
            after,
            before.get(file.path),
            `${file.path} is restored byte for byte`,
          );
      }

      const items = { tools, stream, cancel, usage };
      await row({
        name: agent.name,
        version,
        status,
        ...(reason ? { reason: scrub(reason, sandbox) } : {}),
        items: {
          tools: scrubbed(tools),
          stream: scrubbed(stream),
          cancel: scrubbed(cancel),
          usage: scrubbed(usage),
        },
        notes: notes.map((note) => scrub(note, sandbox)),
      });
      function scrubbed(item: ConformanceItem): ConformanceItem {
        return item.detail
          ? { ...item, detail: scrub(item.detail, sandbox) }
          : item;
      }

      // What the suite requires of every installed agent.
      assert.ok(
        chatCalls.length > 0,
        `the gateway saw ${spec.id}'s key: ${reason ?? ""}\n${scrub(run.stderr.slice(-2000), sandbox)}`,
      );
      assert.ok(upstreamRecords.length > 0, "the upstream received a request");
      if (spec.knownUpstreamRejection && !working)
        assert.match(String(reason), spec.knownUpstreamRejection);
      else {
        assert.ok(working, `chat: ${reason}`);
        for (const [name, item] of Object.entries(items))
          assert.notEqual(item.result, "fail", `${name}: ${item.detail}`);
        if (tools.result === "partial")
          assert.ok(spec.toolsLimitation, `tools: ${tools.detail}`);
      }
    },
  );
