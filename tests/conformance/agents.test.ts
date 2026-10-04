// SPDX-License-Identifier: MIT
/**
 * Real agents, wired by the daemon and run offline in a sandbox (10
 * section 3.3): for each core agent installed on this machine, the daemon
 * (in process, `HH_OFFLINE=1`, file secret backend) wires it into a
 * temporary home towards a Chat Completions provider on the strict fake
 * upstream, which answers a random `PONG-…`; the agent's own non-interactive
 * mode then runs once in the Seatbelt sandbox of support.ts. The run must
 * reach the gateway with the agent's own `agent:` key, the upstream must
 * receive it, and unwiring must restore the files byte for byte. Each
 * agent's row (version, status, reason) goes to the results file that
 * `pnpm test:conformance` turns into docs/compatibility.md. An agent that is
 * not installed is skipped and listed as such.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import {
  agentSandbox,
  bytesOf,
  findAgent,
  record,
  runSandboxed,
  sandboxUnavailable,
  scrub,
  type ConformanceResult,
} from "./support.js";

const KEY = "sk-synthetic-conformance-0001";
const MODEL = "fake/upstream-sim";
const PROMPT = "Reply with the word you are given.";
const RUN_TIMEOUT_MS = 120_000;
/** How long a run with the proxy variables may take before it counts as stuck. */
const PROBE_TIMEOUT_MS = 45_000;

interface AgentSpec {
  id: string;
  executable: string;
  /** Install directories outside PATH, relative to the account's home. */
  installDirectories?: string[];
  /** The documented non-interactive mode with `prompt`. */
  args(prompt: string): string[];
  /**
   * When no request reaches the gateway with the refused proxy variables
   * set, the agent runs once more without them (the sandbox still allows
   * only the gateway's port), and both runs are recorded.
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
    args: (prompt) => ["-p", prompt],
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
  },
  {
    id: "gemini",
    executable: "gemini",
    args: (prompt) => ["-p", prompt],
    proxyProbe: true,
  },
  {
    id: "opencode",
    executable: "opencode",
    args: (prompt) => ["run", prompt],
  },
  {
    id: "pi",
    executable: "pi",
    args: (prompt) => ["-p", prompt],
    knownUpstreamRejection: /max_completion_tokens/,
  },
  {
    id: "hermes",
    executable: "hermes",
    args: (prompt) => ["chat", "-Q", "-q", prompt],
  },
  {
    id: "mimocode",
    executable: "mimo",
    installDirectories: [".mimocode/bin"],
    args: (prompt) => ["run", prompt],
    knownUpstreamRejection: /system message must be the first message/,
  },
  {
    // Grok Build's non-interactive flag is from xAI's documentation; it has
    // not run here (no grok binary on the machine this suite was made on).
    id: "grok",
    executable: "grok",
    args: (prompt) => ["-p", prompt],
  },
];

/** Lines of `text` that look like an error, for a blocked agent's reason. */
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

const today = new Date().toISOString().slice(0, 10);
const platform = `${process.platform}-${process.arch}`;

for (const spec of AGENTS)
  void test(
    `${spec.id}: wired by the daemon, runs offline in a sandbox and reaches the upstream with its own key`,
    { timeout: 300_000 },
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
      const env = sandbox.env(true);

      // The version, in the sandbox before anything is wired.
      const versionRun = await runSandboxed(
        sandbox,
        found.file,
        ["--version"],
        {
          env,
          timeoutMs: 30_000,
        },
      );
      const version =
        (versionRun.stdout + versionRun.stderr)
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean)
          ?.slice(0, 80) ?? "unknown";

      // The daemon and the strict upstream answering a random word.
      const reply = `PONG-${randomBytes(4).toString("hex")}`;
      const upstream = await startFakeProvider({
        models: ["upstream-sim"],
        keys: { upstream: KEY },
        chunkDelayMs: 0,
        script: { turns: [{ text: reply, repeat: true }] },
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
        wiringHome: { home: sandbox.home, env },
      });
      sandbox.defer(() => hub.server.close());
      const client = await connectLocal({ dataDir, url: hub.url });
      await client.providers.create({
        id: "fake",
        name: "Strict fake upstream",
        kind: "custom",
        endpoints: { chat: `${upstream.url}/v1` },
        // The strict upstream refuses OpenAI-only fields: the gateway asks
        // for usage with stream_options, Codex sends parallel_tool_calls
        // and Pi store.
        patches: {
          chat: {
            patches: ["drop-fields"],
            dropFields: ["stream_options", "parallel_tool_calls", "store"],
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
      const agent = await client.agents.get(spec.id);
      assert.notEqual(
        agent.installation.status,
        "not-found",
        "the daemon detects the agent on the sandbox's PATH",
      );

      // Each file wiring writes holds a line of the user's first when its
      // format has comments, so that restoring is more than deleting.
      const input = { model: MODEL };
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

      // The agent's run.
      const gatewayPort = Number(new URL(hub.url).port);
      const agentCalls = async () =>
        (await client.modelCalls.list({ limit: 200 })).items.filter(
          (call) =>
            call.keyId === wiring.keyId &&
            call.scope?.kind === "agent" &&
            call.scope.adapterId === spec.id,
        );
      const notes: string[] = [];
      let run = await runSandboxed(sandbox, found.file, spec.args(PROMPT), {
        env,
        gatewayPort,
        timeoutMs: spec.proxyProbe ? PROBE_TIMEOUT_MS : RUN_TIMEOUT_MS,
      });
      if (spec.proxyProbe && (await agentCalls()).length === 0) {
        const seen = firstError(run.stderr + run.stdout);
        notes.push(
          `with HTTP(S)_PROXY at a refused port and NO_PROXY=127.0.0.1,localhost no request reached the loopback gateway (${run.timedOut ? `${PROBE_TIMEOUT_MS / 1000} s` : `exit ${run.code ?? run.signal}`}${seen ? `: ${seen}` : ""}); it ran again without proxy variables, the sandbox still allowing only the gateway's port`,
        );
        run = await runSandboxed(sandbox, found.file, spec.args(PROMPT), {
          env: sandbox.env(false),
          gatewayPort,
          timeoutMs: RUN_TIMEOUT_MS,
        });
      }
      await upstream.idle();
      const received = upstream.records();
      const calls = await agentCalls();
      const answered = calls.some((call) => call.status === 200);
      const printed = run.stdout.includes(reply);
      notes.push(...(spec.notes?.(run) ?? []));

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

      const status: ConformanceResult["status"] =
        calls.length === 0
          ? "blocked"
          : answered && printed
            ? "wiring verified"
            : "partially verified";
      const upstreamError = calls.find((call) => call.status !== 200)?.error;
      const reason =
        status === "blocked"
          ? `no request reached the gateway (${run.timedOut ? `timed out after ${RUN_TIMEOUT_MS / 1000} s` : `exit ${run.code ?? run.signal}`}${firstError(run.stderr + run.stdout) ? `: ${firstError(run.stderr + run.stdout)}` : ""})`
          : status === "partially verified"
            ? answered
              ? "the upstream answered but the agent did not print the reply"
              : `the agent's requests reached the gateway with its key; the strict upstream rejected them: ${typeof upstreamError === "string" ? upstreamError : JSON.stringify(upstreamError)}`
            : undefined;
      await row({
        name: agent.name,
        version,
        status,
        ...(reason ? { reason: scrub(reason, sandbox) } : {}),
        notes: notes.map((note) => scrub(note, sandbox)),
      });

      // What the suite requires of every installed agent.
      assert.ok(
        calls.length > 0,
        `the gateway saw ${spec.id}'s key: ${reason ?? ""}\n${scrub(run.stderr.slice(-2000), sandbox)}`,
      );
      assert.ok(received.length > 0, "the upstream received a request");
      if (spec.knownUpstreamRejection && !answered)
        assert.match(String(reason), spec.knownUpstreamRejection);
      else {
        assert.ok(answered, `the upstream answered: ${reason}`);
        assert.ok(
          printed,
          `${spec.id} printed the reply ${reply}:\n${scrub(run.stdout.slice(-2000), sandbox)}`,
        );
      }
    },
  );
