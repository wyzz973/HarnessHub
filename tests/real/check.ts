// SPDX-License-Identifier: MIT
/**
 * `pnpm test:real`: a repeatable check of HarnessHub against a real
 * provider, run by its owner with their own key. Never part of `pnpm check`.
 *
 * Usage (after pnpm build; the key from a file or HH_REAL_KEY only):
 *   pnpm test:real --preset P [--region R] [--plan P] --model M [options]
 *   pnpm test:real --chat URL [--responses URL] [--anthropic URL]
 *     [--gemini URL] [--api-key-header H] --model M [options]
 * Options: --key-file PATH, --provider ID, --agents a,b,c, --attempts 1-3,
 *   --out FILE (the Markdown report), --dry-run (plans only, no model call).
 *
 * In a temporary directory it starts `hh serve` (file secrets, a temporary
 * `--wiring-home`, catalog refresh off), adds the provider with the key on
 * the command's stdin, and, when the provider also has other endpoints, a
 * Chat-only copy of it that makes the gateway translate. Then: `provider
 * test`; the doctor's plan with its estimated cost, then the doctor; the
 * official-SDK matrix (conformance/real/matrix.ts) on both providers; each
 * agent of `--agents`, wired into the temporary home and run once in the
 * real-agent suite's Seatbelt sandbox on a file-read task. The ledger is
 * then checked: each matrix path's upstream protocol and mode, each agent's
 * attribution and tool turn. Afterwards agents are unwired, the daemon
 * stops, and the temporary directory, the daemon's log and every captured
 * output are searched for the key's plaintext (and the matrix's Gateway
 * Key) before the directory is deleted.
 *
 * A model that answers wrong is asked again, at most twice, and every miss
 * is in the report. The report is Markdown with no secret values. Exits 0
 * when every check passed, 1 when one failed, 2 for bad arguments.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ApiModelCall, ProviderConfig } from "@harnesshub/sdk/client";
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { AGENTS, type AgentSpec } from "../conformance/agents.js";
import {
  agentVersion,
  findAgent,
  runSandboxed,
  sandboxIn,
  sandboxUnavailable,
} from "../conformance/support.js";
import { HH_ENTRY } from "../support/entries.js";
import { findSecret } from "./scan.js";

const MATRIX = fileURLToPath(
  new URL("../../conformance/real/matrix.js", import.meta.url),
);
const PROTOCOLS = ["chat", "responses", "anthropic", "gemini"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const AGENT_TIMEOUT_MS = 240_000;

class Usage extends Error {}

interface Options {
  preset?: string;
  region?: string;
  plan?: string;
  endpoints: Partial<Record<Protocol, string>>;
  apiKeyHeader?: string;
  model: string;
  provider: string;
  keyFile?: string;
  agents: string[];
  attempts: number;
  out?: string;
  dryRun: boolean;
}

function options(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        preset: { type: "string" },
        region: { type: "string" },
        plan: { type: "string" },
        chat: { type: "string" },
        responses: { type: "string" },
        anthropic: { type: "string" },
        gemini: { type: "string" },
        "api-key-header": { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        "key-file": { type: "string" },
        agents: { type: "string" },
        attempts: { type: "string", default: "3" },
        out: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new Usage((error as Error).message);
  }
  const { values } = parsed;
  const endpoints = Object.fromEntries(
    PROTOCOLS.flatMap((protocol) =>
      typeof values[protocol] === "string"
        ? [[protocol, values[protocol]]]
        : [],
    ),
  ) as Partial<Record<Protocol, string>>;
  if (!values.preset === !Object.keys(endpoints).length)
    throw new Usage(
      "Give --preset P or explicit endpoints (--chat URL ...), not both",
    );
  if (!values.model) throw new Usage("Give --model M");
  const attempts = Number(values.attempts);
  if (![1, 2, 3].includes(attempts))
    throw new Usage("--attempts takes 1, 2 or 3");
  const agents = (values.agents ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of agents)
    if (!AGENTS.some((spec) => spec.id === id))
      throw new Usage(
        `Unknown agent ${id} (${AGENTS.map((spec) => spec.id).join(", ")})`,
      );
  const provider = values.provider ?? values.preset ?? "real";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(provider))
    throw new Usage("--provider takes lower-case letters, digits and hyphens");
  return {
    ...(values.preset ? { preset: values.preset } : {}),
    ...(values.region ? { region: values.region } : {}),
    ...(values.plan ? { plan: values.plan } : {}),
    endpoints,
    ...(values["api-key-header"]
      ? { apiKeyHeader: values["api-key-header"] }
      : {}),
    model: values.model,
    provider,
    ...(values["key-file"] ? { keyFile: values["key-file"] } : {}),
    agents,
    attempts,
    ...(values.out ? { out: values.out } : {}),
    dryRun: values["dry-run"] === true,
  };
}

/** The upstream key: the file named by --key-file, or HH_REAL_KEY; never both. */
async function upstreamKey(given: Options): Promise<string> {
  const variable = process.env.HH_REAL_KEY;
  if (given.keyFile && variable)
    throw new Usage("Give the key with --key-file or HH_REAL_KEY, not both");
  let key = (variable ?? "").trim();
  if (given.keyFile)
    try {
      key = (await readFile(given.keyFile, "utf8")).trim();
    } catch (error) {
      throw new Usage(
        `Cannot read --key-file: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
      );
    }
  if (!key) throw new Usage("No key: give --key-file PATH or set HH_REAL_KEY");
  if (/\s/.test(key)) throw new Usage("The key has white space inside");
  if (key.length < 8) throw new Usage("The key is shorter than 8 characters");
  return key;
}

const say = (text: string) => process.stderr.write(`test:real: ${text}\n`);
const cell = (text: string) =>
  text.replaceAll("|", "\\|").replaceAll("\n", " ");
const usd = (amount: number) => `$${amount.toFixed(6)}`;

/** Everything a child printed, kept for the secret scan. */
const outputs: { name: string; text: string }[] = [];
/** The SDK matrix's Gateway Key, which no file may hold either. */
let matrixKey: string | undefined;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  name: string,
  file: string,
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child
      .stdout!.setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child
      .stderr!.setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    if (stdin !== undefined) child.stdin!.end(stdin);
    child.once("error", reject);
    child.once("close", (code) => {
      outputs.push(
        { name: `${name} (stdout)`, text: stdout },
        { name: `${name} (stderr)`, text: stderr },
      );
      resolve({ code, stdout, stderr });
    });
  });
}

interface Daemon {
  url: string;
  port: number;
  log?: string;
  child: ChildProcess;
  dataDir: string;
  env: Record<string, string>;
}

async function startDaemon(
  root: string,
  agentDirectories: string[],
): Promise<Daemon> {
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  for (const made of [dataDir, home, tmp])
    await mkdir(made, { recursive: true });
  const env: Record<string, string> = {
    PATH: [
      ...agentDirectories,
      ...(process.env.PATH ?? "").split(path.delimiter),
    ]
      .filter(Boolean)
      .join(path.delimiter),
    HOME: home,
    USER: os.userInfo().username,
    LANG: "en_US.UTF-8",
    TMPDIR: tmp,
    HH_OFFLINE: "1",
  };
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(HH_ENTRY),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--data-dir",
      dataDir,
      "--config-dir",
      path.join(root, "config"),
      "--secrets-backend",
      "file",
      "--wiring-home",
      home,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child
    .stderr!.setEncoding("utf8")
    .on("data", (chunk: string) => (stderr += chunk));
  child.once("close", () =>
    outputs.push(
      { name: "hh serve (stdout)", text: stdout },
      { name: "hh serve (stderr)", text: stderr },
    ),
  );
  const lines = createInterface({ input: child.stdout! });
  const exited = once(child, "exit").then(([code]) => {
    throw new Error(
      `hh serve exited with ${String(code)}: ${stderr.slice(-2000)}`,
    );
  });
  const ready = (async () => {
    for await (const line of lines) {
      stdout += `${line}\n`;
      if (!line.startsWith("{")) continue;
      const value = JSON.parse(line) as {
        event?: string;
        url?: string;
        log?: string;
      };
      if (value.event === "ready" && value.url) return value;
    }
    throw new Error("hh serve closed its output before it was ready");
  })();
  const value = await Promise.race([ready, exited]);
  child
    .stdout!.setEncoding("utf8")
    .on("data", (chunk: string) => (stdout += chunk));
  const url = value.url!.replace(/\/$/, "");
  return {
    url,
    port: Number(new URL(url).port),
    ...(value.log ? { log: value.log } : {}),
    child,
    dataDir,
    env,
  };
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null)
    return;
  const exited = once(daemon.child, "exit");
  daemon.child.kill("SIGTERM");
  const timer = setTimeout(() => daemon.child.kill("SIGKILL"), 15_000);
  await exited;
  clearTimeout(timer);
}

/** Runs `hh` against the daemon; rejects with its last error line. */
async function hh(
  daemon: Daemon,
  args: string[],
  stdin?: string,
): Promise<string> {
  const result = await run(
    `hh ${args[0]} ${args[1] ?? ""}`.trim(),
    process.execPath,
    [
      fileURLToPath(HH_ENTRY),
      ...args,
      "--url",
      daemon.url,
      "--data-dir",
      daemon.dataDir,
    ],
    daemon.env,
    stdin,
  );
  if (result.code !== 0)
    throw new Error(
      `hh ${args.slice(0, 2).join(" ")} exited ${String(result.code)}: ${
        result.stderr.trim().split("\n").at(-1) ?? ""
      }`,
    );
  return result.stdout;
}

/** The ledger, oldest first. */
async function ledger(client: HarnessHubClient): Promise<ApiModelCall[]> {
  const calls: ApiModelCall[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.modelCalls.list({
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    calls.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return calls.reverse();
}

interface Outcome {
  result: "pass" | "fail";
  attempts: number;
  detail: string;
  misses: string[];
}
interface MatrixRow {
  model: string;
  protocol: Protocol;
  stream: boolean;
  text: Outcome;
  tool: Outcome;
}

function outcomeText(outcome: Outcome): string {
  const tries =
    outcome.misses.length > 0
      ? ` — ${outcome.result === "pass" ? "passed" : "failed"} on attempt ${outcome.attempts}; earlier: ${outcome.misses.join("; ")}`
      : outcome.attempts > 1
        ? ` (${outcome.attempts} attempts)`
        : "";
  return `${outcome.result === "pass" ? "✓" : "✗"} ${outcome.detail}${tries}`;
}

/** The report, section by section; `failures` lists what failed. */
class Report {
  readonly lines: string[] = [];
  readonly failures: string[] = [];
  section(title: string, ...body: string[]) {
    this.lines.push(`## ${title}`, "", ...body, "");
  }
  table(header: string[], rows: string[][]) {
    return [
      `| ${header.join(" | ")} |`,
      `|${header.map(() => "---").join("|")}|`,
      ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ];
  }
  fail(what: string) {
    this.failures.push(what);
  }
  text(title: string): string {
    return [
      `# ${title}`,
      "",
      ...this.lines,
      this.failures.length
        ? `**${this.failures.length} failed:** ${this.failures.join("; ")}`
        : "**All checks passed.**",
      "",
    ].join("\n");
  }
}

interface Path {
  provider: string;
  config: ProviderConfig;
}

/** Which upstream protocol and mode a matrix call should have taken. */
function expectedRoute(config: ProviderConfig, protocol: Protocol): string {
  const endpoints = Object.keys(config.endpoints) as Protocol[];
  return endpoints.includes(protocol) && !config.translateOnly
    ? `${protocol}, passthrough`
    : `${endpoints.join("/")}, translated`;
}

function observedRoute(calls: ApiModelCall[]): string {
  return (
    [
      ...new Set(
        calls.map(
          (call) => `${call.upstreamProtocol ?? "?"}, ${call.mode ?? "?"}`,
        ),
      ),
    ].join("; ") || "no call"
  );
}

function routeMatches(expected: string, observed: string): boolean {
  const [protocols, mode] = expected.split(", ");
  return observed.split("; ").every((route) => {
    const [protocol, seen] = route.split(", ");
    return seen === mode && protocols!.split("/").includes(protocol!);
  });
}

async function matrix(
  report: Report,
  daemon: Daemon,
  client: HarnessHubClient,
  paths: Path[],
  model: string,
  attempts: number,
): Promise<void> {
  const created = await client.gatewayKeys.create({
    name: "test-real-matrix",
    modelAllow: paths.map((each) => `${each.provider}/*`),
    expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  });
  const secretKey = created.key;
  matrixKey = secretKey;
  const result = await run(
    "matrix",
    process.execPath,
    [
      MATRIX,
      ...paths.flatMap((each) => ["--model", `${each.provider}/${model}`]),
      "--attempts",
      String(attempts),
    ],
    {
      PATH: daemon.env.PATH!,
      HOME: daemon.env.HOME!,
      TMPDIR: daemon.env.TMPDIR!,
      HH_REAL_GATEWAY_URL: daemon.url,
      HH_REAL_GATEWAY_KEY: secretKey,
    },
  );
  const rows = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as MatrixRow);
  if (result.code === 2 || !rows.length)
    report.fail(
      `the SDK matrix did not run: ${result.stderr.trim().split("\n").at(-1) ?? ""}`,
    );
  const calls = (await ledger(client)).filter(
    (call) => call.keyId === created.gatewayKey.keyId,
  );
  const table = rows.map((row) => {
    const provider = row.model.split("/")[0]!;
    const config = paths.find((each) => each.provider === provider)!.config;
    const expected = expectedRoute(config, row.protocol);
    const observed = observedRoute(
      calls.filter(
        (call) =>
          call.provider === provider &&
          call.inbound.protocol === row.protocol &&
          call.inbound.stream === row.stream &&
          call.status === 200,
      ),
    );
    // Without a successful call the row has failed already; there is no route.
    const answered = observed !== "no call";
    const routed = !answered || routeMatches(expected, observed);
    const name = `${row.model} ${row.protocol}${row.stream ? " streamed" : ""}`;
    if (row.text.result === "fail") report.fail(`${name}: text`);
    if (row.tool.result === "fail") report.fail(`${name}: tool round trip`);
    if (!routed)
      report.fail(`${name}: routed ${observed}, expected ${expected}`);
    return [
      row.model,
      row.protocol,
      row.stream ? "yes" : "no",
      outcomeText(row.text),
      outcomeText(row.tool),
      answered ? `${routed ? "✓" : "✗"} ${observed}` : "-",
    ];
  });
  report.section(
    "Official SDK clients through the gateway",
    "`openai`, `@anthropic-ai/sdk` and `@google/genai` with a `client:` Gateway Key: a text turn that must answer OK and a `get_weather` tool round trip. A miss is asked again, and every attempt shows here. The route is what the ledger recorded for the row's calls.",
    "",
    ...report.table(
      [
        "Model",
        "Inbound",
        "Stream",
        "Text",
        "Tool round trip",
        "Upstream, mode (ledger)",
      ],
      table,
    ),
  );
  await client.gatewayKeys.revoke(created.gatewayKey.keyId);
}

async function agents(
  report: Report,
  daemon: Daemon,
  client: HarnessHubClient,
  root: string,
  ids: string[],
  model: string,
  attempts: number,
  found: Map<string, { directory: string; file: string }>,
): Promise<void> {
  const unavailable = await sandboxUnavailable();
  const rows: string[][] = [];
  for (const id of ids) {
    const spec = AGENTS.find((each) => each.id === id) as AgentSpec;
    const located = found.get(id);
    if (unavailable || !located) {
      const why = unavailable ?? `${spec.executable} is not installed`;
      report.fail(`${id}: not run (${why})`);
      rows.push([id, "-", "✗ not run", why, "-", "-"]);
      continue;
    }
    const sandbox = await sandboxIn(root, located.directory, {
      home: path.join(root, "home"),
      work: path.join(root, `work-${id}`),
    });
    const env = sandbox.env(!spec.proxyProbe);
    const version = await agentVersion(sandbox, located.file, env);
    let wired = false;
    const misses: string[] = [];
    let answered = false;
    let detail = "";
    try {
      say(`wiring ${id}`);
      await hh(daemon, ["wire", id, model, "--yes", "--json"]);
      wired = true;
      for (let attempt = 1; attempt <= attempts && !answered; attempt++) {
        const word = `CODE-${randomBytes(3).toString("hex").toUpperCase()}`;
        await writeFile(
          path.join(sandbox.work, "note.txt"),
          `The code word is ${word}.\n`,
        );
        say(`running ${id} (attempt ${attempt})`);
        const prompt =
          "Read the file note.txt in the current directory and reply with only the code word it contains.";
        const result = await runSandboxed(
          sandbox,
          located.file,
          (spec.outerSandboxArgs ?? spec.args)(prompt),
          { env, gatewayPort: daemon.port, timeoutMs: AGENT_TIMEOUT_MS },
        );
        outputs.push(
          { name: `${id} attempt ${attempt} (stdout)`, text: result.stdout },
          { name: `${id} attempt ${attempt} (stderr)`, text: result.stderr },
        );
        answered = result.stdout.includes(word);
        const last = (text: string) =>
          text
            .trim()
            .split("\n")
            .at(-1)
            ?.split(root)
            .join("<tmp>")
            .slice(0, 160) ?? "";
        const said = result.timedOut
          ? `timed out after ${AGENT_TIMEOUT_MS / 1000} s`
          : `exit ${String(result.code ?? result.signal)}: "${last(result.stdout) || last(result.stderr)}"`;
        if (answered)
          detail = `answered the code word${misses.length ? ` on attempt ${attempt}; earlier: ${misses.join("; ")}` : ""}`;
        else misses.push(said);
      }
      if (!answered)
        detail = `never answered the code word: ${misses.join("; ")}`;
    } catch (error) {
      detail = (error as Error).message.split(root).join("<tmp>");
    }
    const wiring = wired ? (await client.agents.get(id)).wiring : null;
    const calls = (await ledger(client)).filter(
      (call) => call.scope?.kind === "agent" && call.scope.adapterId === id,
    );
    const attributed =
      wiring?.keyId !== undefined &&
      calls.length > 0 &&
      calls.every((call) => call.keyId === wiring.keyId);
    const toolTurns = calls.filter(
      (call) =>
        call.finishReason === "tool_calls" || call.finishReason === "tool_use",
    ).length;
    const responsesOnly =
      calls.length > 0 &&
      calls.every(
        (call) =>
          call.inbound.protocol === "responses" && call.mode === "passthrough",
      );
    const tools = toolTurns
      ? `✓ ${toolTurns} of ${calls.length} calls ended in a tool call`
      : responsesOnly && calls.length >= 2
        ? `${calls.length} calls; a Responses passthrough records the response status, not tool calls`
        : `✗ no call ended in a tool call (${calls.length} calls)`;
    if (!answered) report.fail(`${id}: ${detail}`);
    if (!attributed)
      report.fail(
        `${id}: the ledger does not attribute its calls to its agent key`,
      );
    if (tools.startsWith("✗")) report.fail(`${id}: no tool call in the ledger`);
    rows.push([
      id,
      version,
      `${answered ? "✓" : "✗"} ${detail}`,
      `${attributed ? "✓" : "✗"} ${calls.length} calls under agent:${id}`,
      tools,
      observedRoute(calls),
    ]);
    if (wired)
      try {
        await hh(daemon, ["unwire", id, "--yes", "--json"]);
      } catch (error) {
        report.fail(`${id}: unwire failed: ${(error as Error).message}`);
      }
  }
  report.section(
    "Agents",
    "Each agent is wired into the temporary home with `hh wire`, run once in the real-agent suite's Seatbelt sandbox (network only to the gateway's port, writes only in the temporary directory) on a file-read task, and unwired.",
    "",
    ...report.table(
      [
        "Agent",
        "Version",
        "Answer",
        "Attribution (ledger)",
        "Tool turn (ledger)",
        "Upstream, mode (ledger)",
      ],
      rows,
    ),
  );
}

async function main(): Promise<number> {
  let given: Options;
  let key: string;
  try {
    given = options(process.argv.slice(2));
    key = await upstreamKey(given);
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    console.error(`test:real: ${error.message}`);
    return 2;
  }
  const report = new Report();
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh-real-")),
  );
  const found = new Map<string, { directory: string; file: string }>();
  for (const id of given.agents) {
    const spec = AGENTS.find((each) => each.id === id)!;
    const located = await findAgent(
      spec.executable,
      (spec.installDirectories ?? []).map((directory) =>
        path.join(os.userInfo().homedir, directory),
      ),
    );
    if (located) found.set(id, located);
  }
  let daemon: Daemon | undefined;
  try {
    say("starting hh serve in a temporary directory");
    daemon = await startDaemon(
      root,
      [...found.values()].map((each) => each.directory),
    );
    const client = await connectLocal({
      dataDir: daemon.dataDir,
      url: daemon.url,
    });
    const version = JSON.parse(
      (
        await run(
          "hh version",
          process.execPath,
          [fileURLToPath(HH_ENTRY), "version", "--json"],
          daemon.env,
        )
      ).stdout,
    ) as { version?: string; commit?: string };
    report.section(
      "Run",
      `${new Date().toISOString()} · ${process.platform}-${process.arch} · Node ${process.versions.node} · HarnessHub ${version.version ?? "?"} ${version.commit?.slice(0, 7) ?? ""} · model \`${given.model}\``,
    );

    say(`adding provider ${given.provider} with the key on stdin`);
    await hh(
      daemon,
      [
        "provider",
        "add",
        given.provider,
        ...(given.preset ? ["--preset", given.preset] : []),
        ...(given.region ? ["--region", given.region] : []),
        ...(given.plan ? ["--plan", given.plan] : []),
        ...Object.entries(given.endpoints).flatMap(([protocol, url]) => [
          `--${protocol}`,
          url,
        ]),
        ...(given.apiKeyHeader ? ["--api-key-header", given.apiKeyHeader] : []),
        ...(given.preset ? [] : ["--model", given.model]),
        "--credential-from-stdin",
        "--json",
      ],
      `${key}\n`,
    );
    if (given.preset)
      try {
        await client.providers.refreshModels(given.provider);
      } catch (error) {
        say(`the live model list failed: ${(error as Error).message}`);
      }
    const main = await client.providers.get(given.provider);
    if (
      given.preset &&
      !main.models.list.some((model) => model.id === given.model)
    )
      say(
        `${given.model} is not in ${given.provider}'s model list; trying it anyway`,
      );
    const paths: Path[] = [{ provider: given.provider, config: main }];
    const endpoints = Object.keys(main.endpoints);
    if (main.endpoints.chat && endpoints.length > 1) {
      const chatOnly = `${given.provider}-chat`;
      say(
        `adding ${chatOnly}, the Chat endpoint alone, so that the gateway translates`,
      );
      await hh(
        daemon,
        [
          "provider",
          "add",
          chatOnly,
          "--chat",
          main.endpoints.chat,
          "--api-key-header",
          main.auth.apiKeyHeader,
          "--model",
          given.model,
          "--credential-from-stdin",
          "--json",
        ],
        `${key}\n`,
      );
      if (main.patches?.chat || main.headers)
        await client.providers.update(chatOnly, {
          ...(main.patches?.chat
            ? { patches: { chat: main.patches.chat } }
            : {}),
          ...(main.headers ? { headers: main.headers } : {}),
        });
      paths.push({
        provider: chatOnly,
        config: await client.providers.get(chatOnly),
      });
    }
    report.section(
      "Providers",
      ...paths.map(
        (each) =>
          `- \`${each.provider}\`${each.config.preset ? ` (preset ${each.config.preset})` : ""}: ${Object.entries(
            each.config.endpoints,
          )
            .map(([protocol, url]) => `${protocol} ${url}`)
            .join(", ")}; key header ${each.config.auth.apiKeyHeader}`,
      ),
      ...(paths.length === 1
        ? [
            "- No Chat-only copy: the provider has no other endpoint than Chat, or no Chat endpoint.",
          ]
        : []),
    );

    const plan = (
      await client.providers.doctor(given.provider, {
        model: given.model,
        dryRun: true,
      })
    ).plan;
    const matrixCalls = paths.length * 8 * 3;
    const planText = `Doctor: ${plan.modelCalls} model calls (at most ${plan.maxModelCalls}), estimated cost ${
      plan.estimatedCostUsd === null
        ? "unknown (no price)"
        : usd(plan.estimatedCostUsd)
    }. Provider test: one call per endpoint (${endpoints.length}). SDK matrix: about ${matrixCalls} calls (at most ${matrixCalls * given.attempts}). Agents: ${given.agents.length ? `${given.agents.length}, a few calls each` : "none"}.`;
    say(planText);
    report.section("Plan", planText);
    if (given.dryRun) {
      report.section("Dry run", "Nothing was sent to the provider.");
      return finish(report, given, root, daemon, key);
    }

    say("hh provider test");
    const test = await client.providers.test(given.provider, {
      model: given.model,
    });
    for (const endpoint of test.endpoints)
      if (!endpoint.ok)
        report.fail(
          `provider test: ${endpoint.protocol} ${endpoint.status || "no answer"}`,
        );
    report.section(
      "Provider test",
      ...report.table(
        ["Endpoint", "Status", "Time", "First byte", "Served model", "Error"],
        test.endpoints.map((endpoint) => [
          endpoint.protocol,
          `${endpoint.ok ? "✓" : "✗"} ${endpoint.status || "-"}`,
          `${endpoint.durationMs} ms`,
          endpoint.firstByteMs === undefined
            ? "-"
            : `${endpoint.firstByteMs} ms`,
          endpoint.servedModel ?? "-",
          endpoint.error ?? "",
        ]),
      ),
      "",
      `${test.modelCalls} model calls, ${usd(test.costUsd)}${test.unpricedCalls ? ` (${test.unpricedCalls} without a price)` : ""}.`,
    );

    say("hh provider doctor");
    const doctor = await client.providers.doctor(given.provider, {
      model: given.model,
    });
    const items = doctor.items ?? [];
    for (const item of items)
      if (item.status === "fail") report.fail(`doctor: ${item.check}`);
    const count = (status: string) =>
      items.filter((item) => item.status === status).length;
    report.section(
      "Doctor",
      `${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip; ${doctor.modelCalls ?? 0} model calls, ${usd(doctor.costUsd ?? 0)}${doctor.unpricedCalls ? ` (${doctor.unpricedCalls} without a price)` : ""}.`,
      "",
      ...report.table(
        ["Check", "Status", "Summary"],
        items.map((item) => [item.check, item.status, item.summary]),
      ),
    );

    say("the official-SDK matrix");
    await matrix(report, daemon, client, paths, given.model, given.attempts);

    if (given.agents.length) {
      say(`agents: ${given.agents.join(", ")}`);
      await agents(
        report,
        daemon,
        client,
        root,
        given.agents,
        `${given.provider}/${given.model}`,
        given.attempts,
        found,
      );
    }

    const usage = await client.usage.aggregate({ groupBy: "provider" });
    report.section(
      "Usage",
      ...report.table(
        ["Provider", "Calls", "Failed", "Input", "Output", "Cost", "Unpriced"],
        usage.items.map((bucket) => [
          bucket.key,
          String(bucket.calls),
          String(bucket.failedCalls),
          String(
            bucket.usage.input +
              bucket.usage.cacheRead +
              bucket.usage.cacheWrite,
          ),
          String(bucket.usage.output),
          `$${bucket.cost.amount}`,
          String(bucket.unpricedCalls),
        ]),
      ),
    );
  } catch (error) {
    report.fail(
      `the run stopped: ${(error as Error).message.split(root).join("<tmp>")}`,
    );
  }
  return finish(report, given, root, daemon, key);
}

/** Stops the daemon, scans for the secrets, writes the report and deletes the directory. */
async function finish(
  report: Report,
  given: Options,
  root: string,
  daemon: Daemon | undefined,
  key: string,
): Promise<number> {
  if (daemon) await stopDaemon(daemon);
  const roots = [{ label: "<tmp>", directory: root }];
  if (daemon?.log && !daemon.log.startsWith(root))
    roots.push({ label: "<daemon log>", directory: path.dirname(daemon.log) });
  const draft = report.text("Real provider check");
  const texts = [...outputs, { name: "the report", text: draft }];
  const leaks = await findSecret(key, roots, texts);
  const matrixLeaks = matrixKey
    ? await findSecret(matrixKey, roots, texts)
    : [];
  if (leaks.length)
    report.fail(`the upstream key's plaintext is in ${leaks.join(", ")}`);
  if (matrixLeaks.length)
    report.fail(`the matrix's Gateway Key is in ${matrixLeaks.join(", ")}`);
  report.section(
    "Secrets",
    leaks.length
      ? `✗ The upstream key's plaintext was found in: ${leaks.join(", ")}.`
      : "✓ The upstream key's plaintext is in no file of the temporary directory (data, logs, secrets, agent files) and in no captured output.",
    matrixKey
      ? matrixLeaks.length
        ? `✗ The matrix's Gateway Key was found in: ${matrixLeaks.join(", ")}.`
        : "✓ The matrix's Gateway Key is in no file of the temporary directory and in no captured output."
      : "",
  );
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
  const text = report.text("Real provider check");
  if (given.out) await writeFile(given.out, text);
  process.stdout.write(text);
  return report.failures.length ? 1 : 0;
}

process.exitCode = await main();
