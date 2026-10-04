// SPDX-License-Identifier: MIT
/**
 * GitHub Copilot accounts on the daemon side ([ADR 0026](../../../docs/decisions/0026-subscription-accounts.md)):
 * one host process per account runs GitHub's Copilot SDK (an optional
 * add-on the user installs under `<dataDir>/addons/copilot-sdk`), which
 * drives the Copilot CLI the user installed; `install` puts the SDK there
 * with the user's npm. {@link CopilotHosts} is the
 * gateway's {@link CopilotRuntime} and also reads accounts' identities and
 * model lists for sign-in and model refresh.
 *
 * Host protocol (assets/copilot-host.mjs), one JSON value per line. The
 * daemon writes requests `{id, method, params}`; the host answers
 * `{id, result}` or `{id, error: {code, message}}`, with `code` a
 * {@link CopilotErrorCode}, and sends session events
 * `{event: "session", session, data}` where `data` is a {@link CopilotEvent}.
 * Methods: `start {sdk, cli, auth, token?, home?, workDirectory,
 * stateDirectory}`, `status`, `models`, `quota`, `open {model, system, tools,
 * reasoningEffort?}` → `{session}`, `send {session, prompt, attachments}`,
 * `answer {session, requestId, text | error}`, `abort {session}`,
 * `close {session}`. Closing its stdin stops the host and its CLI.
 *
 * A token account's token reaches the host in the `start` request, never in
 * arguments or the environment of HarnessHub's own processes; the host
 * passes it to the SDK. Host output is never logged.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import type {
  AllowanceReading,
  ProviderConfig,
  ProviderCredential,
  ProviderModel,
} from "@harnesshub/core/model-plane";
import type {
  LaunchedProcess,
  ProcessLauncher,
} from "@harnesshub/core/process-launcher";
import type { CopilotAuth } from "@harnesshub/core/subscriptions";
import {
  CopilotError,
  type CopilotAttachment,
  type CopilotErrorCode,
  type CopilotEvent,
  type CopilotRuntime,
  type CopilotSession,
  type CopilotSessionOptions,
  type CopilotToolRequest,
  type CopilotUsage,
} from "@harnesshub/gateway/copilot";
import type { ManagedSecrets } from "./http/api-v1.js";
import type { CopilotSetup } from "./http/subscription-routes.js";

/** The Copilot SDK release this host was written against; setup installs it. */
export const COPILOT_SDK_VERSION = "1.0.16";
const HOST_SCRIPT = fileURLToPath(
  new URL("../../assets/copilot-host.mjs", import.meta.url),
);
/** A host without sessions stops after this long. */
const HOST_IDLE_MS = 15 * 60_000;
/** How long one host request may take. */
const REQUEST_MS = 120_000;
/** How long a stopping host gets before it is killed. */
const STOP_MS = 5_000;
/** How long npm may take to install the SDK. */
const INSTALL_MS = 4 * 60_000;
/** Environment variables the Copilot CLI would take a token from instead of the account's. */
const TOKEN_VARIABLES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
const ERROR_CODES: readonly CopilotErrorCode[] = [
  "sdk_missing",
  "cli_missing",
  "cli_unsupported",
  "signed_out",
  "unavailable",
];

/** What a Copilot account's credential reference holds (single-line JSON). */
export interface CopilotSecret {
  v: 1;
  /** A token account's fine-grained personal access token. */
  token?: string;
}

export function encodeCopilotSecret(secret: CopilotSecret): string {
  return JSON.stringify(secret);
}

/** The stored value; anything else reads as an empty secret. */
export function decodeCopilotSecret(value: string): CopilotSecret {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { v?: unknown }).v === 1
    ) {
      const token = (parsed as { token?: unknown }).token;
      return typeof token === "string" ? { v: 1, token } : { v: 1 };
    }
  } catch {
    // An unreadable value holds no token.
  }
  return { v: 1 };
}

/** A fine-grained personal access token, as GitHub formats them. */
export function isFineGrainedToken(value: string): boolean {
  return /^github_pat_[A-Za-z0-9_]{20,250}$/.test(value);
}

/**
 * A program on PATH (with PATHEXT on Windows), or undefined. Only regular
 * files count; on POSIX they must be executable.
 */
export async function findProgram(
  program: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const windows = platform === "win32";
  const names = windows
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT")
        .split(";")
        .filter(Boolean)
        .map((ext) => `${program}${ext.toLowerCase()}`)
    : [program];
  const variable = windows
    ? (Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ??
      "PATH")
    : "PATH";
  for (const directory of (environment[variable] ?? "").split(
    windows ? ";" : ":",
  )) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const file = path.join(directory, name);
      try {
        if (!(await stat(file)).isFile()) continue;
        if (!windows) await access(file, constants.X_OK);
        return file;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

/** The Copilot CLI on PATH (`copilot`), or undefined. */
export function findCopilotCli(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  return findProgram("copilot", environment, platform);
}

/**
 * The npm arguments that install the supported SDK into `prefix`: without
 * its platform runtimes (HarnessHub drives the user's CLI) and without
 * install scripts, which the stdio transport does not need.
 */
export function copilotInstallArguments(prefix: string): string[] {
  return [
    "install",
    "--prefix",
    prefix,
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `@github/copilot-sdk@${COPILOT_SDK_VERSION}`,
  ];
}

/** One quota window as the host reports it. */
interface QuotaSnapshot {
  name: string;
  unlimited: boolean;
  remainingPercentage: number;
  resetDate?: string;
}

/**
 * Allowance readings from Copilot's quota report: each limited window with
 * its used share and renewal; its span is the month before the renewal.
 */
export function copilotReadings(
  snapshots: readonly QuotaSnapshot[],
  now: number,
): AllowanceReading[] {
  const observedAt = new Date(now).toISOString();
  return snapshots.flatMap((snapshot) => {
    if (snapshot.unlimited || !Number.isFinite(snapshot.remainingPercentage))
      return [];
    const reset = snapshot.resetDate ? Date.parse(snapshot.resetDate) : NaN;
    const renewal = Number.isFinite(reset) ? new Date(reset) : undefined;
    let span: number | undefined;
    if (renewal) {
      const start = new Date(renewal);
      start.setUTCMonth(start.getUTCMonth() - 1);
      span = Math.round((renewal.getTime() - start.getTime()) / 1000);
    }
    return [
      {
        window: snapshot.name,
        usedPercent: Math.min(
          100,
          Math.max(0, 100 - snapshot.remainingPercentage),
        ),
        ...(renewal ? { resetsAt: renewal.toISOString() } : {}),
        ...(span ? { spanSeconds: span } : {}),
        observedAt,
      },
    ];
  });
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A host's session event, checked; undefined for anything else. */
function sessionEvent(value: unknown): CopilotEvent | undefined {
  const data = record(value);
  switch (data?.type) {
    case "delta":
    case "reasoning":
      return text(data.text) ? { type: data.type, text: data.text } : undefined;
    case "message": {
      if (!text(data.text) || !Array.isArray(data.toolRequests))
        return undefined;
      const toolRequests: CopilotToolRequest[] = [];
      for (const item of data.toolRequests) {
        const request = record(item);
        if (
          !text(request?.toolCallId) ||
          !text(request.name) ||
          !text(request.arguments)
        )
          return undefined;
        toolRequests.push({
          toolCallId: request.toolCallId,
          name: request.name,
          arguments: request.arguments,
        });
      }
      return { type: "message", text: data.text, toolRequests };
    }
    case "tool":
      return text(data.requestId) && text(data.toolCallId)
        ? {
            type: "tool",
            requestId: data.requestId,
            toolCallId: data.toolCallId,
          }
        : undefined;
    case "usage": {
      const given = record(data.usage);
      if (!given) return undefined;
      const usage: CopilotUsage = {};
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
      ] as const)
        if (count(given[key])) usage[key] = given[key];
      return { type: "usage", usage };
    }
    case "error":
      return text(data.message)
        ? {
            type: "error",
            message: data.message,
            ...(count(data.status) ? { status: data.status } : {}),
            ...(text(data.code) ? { code: data.code } : {}),
          }
        : undefined;
    case "idle":
      return { type: "idle", aborted: data.aborted === true };
    case "closed":
      return text(data.message)
        ? { type: "closed", message: data.message }
        : undefined;
    default:
      return undefined;
  }
}

/** The host of an account: one per credential reference. */
const keyOf = (credential: ProviderCredential) =>
  JSON.stringify([credential.ref.kind, credential.ref.value]);

/** One running host and its sessions. */
class Host {
  #next = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly sessions = new Map<string, HostSession>();
  #gone: string | undefined;
  idle: NodeJS.Timeout | undefined;

  constructor(
    private readonly child: LaunchedProcess,
    /** Removed from every message the host sends back. */
    private readonly token: string | undefined,
  ) {
    if (child.stdout)
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
        "line",
        (line) => this.#line(line),
      );
    // Host diagnostics are not kept: they may quote the CLI.
    child.stderr?.resume();
    void child.exit.then((exit) =>
      this.#end(
        exit.error
          ? "The Copilot host could not start"
          : `The Copilot host exited (${exit.signal ?? exit.code ?? "unknown"})`,
      ),
    );
  }

  get alive(): boolean {
    return this.#gone === undefined;
  }

  #clean(message: string): string {
    return (
      this.token ? message.replaceAll(this.token, "[token]") : message
    ).slice(0, 500);
  }

  #line(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const message = record(value);
    if (!message) return;
    if (message.event === "session" && text(message.session)) {
      const event = sessionEvent(message.data);
      if (event) this.sessions.get(message.session)?.push(event);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.#pending.get(message.id);
    if (!waiting) return;
    this.#pending.delete(message.id);
    clearTimeout(waiting.timer);
    const error = record(message.error);
    if (error) {
      const code = ERROR_CODES.find((item) => item === error.code);
      waiting.reject(
        new CopilotError(
          this.#clean(text(error.message) ? error.message : "Copilot failed"),
          code ?? "unavailable",
        ),
      );
    } else waiting.resolve(message.result);
  }

  #end(reason: string): void {
    if (this.#gone !== undefined) return;
    this.#gone = reason;
    clearTimeout(this.idle);
    for (const [id, waiting] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new CopilotError(reason, "unavailable"));
    }
    for (const session of this.sessions.values())
      session.push({ type: "closed", message: reason });
    this.sessions.clear();
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_MS,
  ): Promise<unknown> {
    if (this.#gone !== undefined)
      return Promise.reject(new CopilotError(this.#gone, "unavailable"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CopilotError(
            `The Copilot host did not answer ${method} in time`,
            "unavailable",
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Stop the host and its CLI; waits for it to exit. */
  async stop(): Promise<void> {
    this.#end("The Copilot host stopped");
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), STOP_MS);
    await this.child.exit;
    clearTimeout(timer);
  }
}

class HostSession implements CopilotSession {
  #handler: ((event: CopilotEvent) => void) | undefined;
  #buffer: CopilotEvent[] = [];
  #closed = false;

  constructor(
    private readonly host: Host,
    readonly id: string,
    private readonly onClose: () => void,
  ) {}

  push(event: CopilotEvent): void {
    if (this.#handler) this.#handler(event);
    else this.#buffer.push(event);
  }

  listen(handler: (event: CopilotEvent) => void): void {
    this.#handler = handler;
    for (const event of this.#buffer.splice(0)) handler(event);
  }

  async send(prompt: string, attachments: CopilotAttachment[]): Promise<void> {
    await this.host.request("send", { session: this.id, prompt, attachments });
  }

  async answer(
    requestId: string,
    result: { text: string } | { error: string },
  ): Promise<void> {
    await this.host.request("answer", {
      session: this.id,
      requestId,
      ...result,
    });
  }

  async abort(): Promise<void> {
    await this.host.request("abort", { session: this.id });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.host.sessions.delete(this.id);
    await this.host
      .request("close", { session: this.id })
      .catch(() => undefined);
    this.onClose();
  }
}

/** Where the Copilot client of this daemon lives. */
export interface CopilotPaths {
  /** `<dataDir>/addons/copilot-sdk`: the SDK add-on's npm prefix. */
  addon: string;
  /** `<dataDir>/subscriptions/copilot`: the hosts' working, state and token-account directories. */
  directory: string;
  /** The Copilot CLI; undefined looks it up on PATH when a host starts. */
  cli?: string;
  /** npm for installing the SDK; undefined looks it up on PATH. */
  npm?: string;
}

/**
 * The Copilot hosts of this daemon: one per account, started on first use
 * and stopped after {@link HOST_IDLE_MS} without sessions or by
 * {@link close}.
 */
export class CopilotHosts implements CopilotRuntime {
  #hosts = new Map<string, Promise<Host>>();
  #installing: Promise<CopilotSetup> | undefined;
  #closed = false;

  constructor(
    private readonly options: {
      launcher: ProcessLauncher;
      secrets: ManagedSecrets;
      environment: Readonly<NodeJS.ProcessEnv>;
      paths: CopilotPaths;
      clock: () => number;
      log: LogSink;
    },
  ) {}

  async setup(): Promise<CopilotSetup> {
    const sdkDirectory = this.options.paths.addon;
    let sdkVersion: string | undefined;
    try {
      const manifest = record(
        JSON.parse(
          await readFile(
            path.join(
              sdkDirectory,
              "node_modules",
              "@github",
              "copilot-sdk",
              "package.json",
            ),
            "utf8",
          ),
        ),
      );
      if (text(manifest?.version)) sdkVersion = manifest.version;
    } catch {
      // Not installed.
    }
    const cliPath = await this.#cli();
    return {
      sdkDirectory,
      ...(sdkVersion ? { sdkVersion } : {}),
      supportedSdkVersion: COPILOT_SDK_VERSION,
      ...(cliPath ? { cliPath } : {}),
      installCommand: [
        "npm",
        ...copilotInstallArguments(sdkDirectory).map((arg) =>
          /[\s"']/.test(arg) ? JSON.stringify(arg) : arg,
        ),
      ].join(" "),
    };
  }

  /**
   * Install the supported SDK into the add-on directory with the user's npm
   * (through the ProcessLauncher; one install at a time), then report the
   * setup again.
   *
   * @throws HubError `NPM_NOT_FOUND` (409) without npm on PATH,
   *   `COPILOT_SDK_INSTALL_FAILED` (502) when npm fails or times out.
   */
  install(): Promise<CopilotSetup> {
    this.#installing ??= this.#install().finally(() => {
      this.#installing = undefined;
    });
    return this.#installing;
  }

  async #install(): Promise<CopilotSetup> {
    const prefix = this.options.paths.addon;
    const args = copilotInstallArguments(prefix);
    const npm =
      this.options.paths.npm ??
      (await findProgram("npm", this.options.environment));
    if (!npm)
      throw new HubError(
        "NPM_NOT_FOUND",
        `npm was not found on PATH; install Node.js with npm, or run: ${(await this.setup()).installCommand}`,
        409,
      );
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    // A Windows npm is a batch file, which only runs through cmd.exe.
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(npm);
    if (shell && [npm, ...args].some((arg) => arg.includes('"')))
      throw new HubError(
        "COPILOT_SDK_INSTALL_FAILED",
        "The npm or add-on path contains a quotation mark",
        502,
      );
    const result = await this.options.launcher.run({
      ...(shell
        ? {
            file: "cmd.exe",
            args: [
              "/d",
              "/s",
              "/c",
              `"${[npm, ...args].map((arg) => `"${arg}"`).join(" ")}"`,
            ],
            windowsVerbatimArguments: true,
          }
        : { file: npm, args }),
      env: this.#environment(false),
      cwd: prefix,
      timeoutMs: INSTALL_MS,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.timedOut || result.code !== 0) {
      const reason = result.error
        ? "could not start"
        : result.timedOut
          ? "timed out"
          : `exit code ${result.code ?? result.signal ?? "unknown"}`;
      const output = result.stderr
        .toString("utf8")
        .trim()
        .split("\n")
        .slice(-5);
      throw new HubError(
        "COPILOT_SDK_INSTALL_FAILED",
        `npm install of @github/copilot-sdk@${COPILOT_SDK_VERSION} failed (${reason})${output.length && output[0] ? `: ${output.join(" | ")}` : ""}`.slice(
          0,
          1000,
        ),
        502,
      );
    }
    this.options.log.info("subscriptions.copilot_sdk_installed", {
      version: COPILOT_SDK_VERSION,
    });
    return this.setup();
  }

  /** The daemon's environment for a child; without token variables for a token account. */
  #environment(token: boolean): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.environment))
      if (value !== undefined && !(token && TOKEN_VARIABLES.includes(key)))
        environment[key] = value;
    return environment;
  }

  #cli(): Promise<string | undefined> {
    return this.options.paths.cli !== undefined
      ? Promise.resolve(this.options.paths.cli)
      : findCopilotCli(this.options.environment);
  }

  /** Start a host signed in as `auth`; rejects with CopilotError. */
  async #start(auth: CopilotAuth, token: string | undefined): Promise<Host> {
    if (this.#closed)
      throw new CopilotError("The daemon is stopping", "unavailable");
    const { directory } = this.options.paths;
    const work = path.join(directory, "work");
    const state = path.join(directory, "state");
    const home = token
      ? path.join(
          directory,
          "homes",
          createHash("sha256").update(token).digest("hex").slice(0, 16),
        )
      : undefined;
    for (const dir of [work, state, ...(home ? [home] : [])])
      await mkdir(dir, { recursive: true, mode: 0o700 });
    const child = this.options.launcher.launch({
      file: process.execPath,
      args: [HOST_SCRIPT],
      env: this.#environment(token !== undefined),
      cwd: work,
    });
    const host = new Host(child, token);
    try {
      await host.request("start", {
        sdk: this.options.paths.addon,
        cli: (await this.#cli()) ?? null,
        auth,
        ...(token ? { token, home } : {}),
        workDirectory: work,
        stateDirectory: state,
      });
      const status = record(await host.request("status"));
      if (status?.authenticated !== true)
        throw new CopilotError(
          auth === "token"
            ? "GitHub did not accept the token for Copilot"
            : "The Copilot CLI is not signed in; run copilot and sign in with /login",
          "signed_out",
        );
      return host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }

  /** The running host of an account, started when needed. */
  #host(credential: ProviderCredential): Promise<Host> {
    const account = credential.account;
    if (account?.backend !== "copilot")
      return Promise.reject(
        new CopilotError("Not a Copilot account", "unavailable"),
      );
    const key = keyOf(credential);
    const running = this.#hosts.get(key);
    if (running)
      return running.then((found) =>
        found.alive ? found : this.#replace(key, credential),
      );
    return this.#replace(key, credential);
  }

  #replace(key: string, credential: ProviderCredential): Promise<Host> {
    const account = credential.account!;
    const auth = account.backend === "copilot" ? account.auth : "login";
    const started = (async () => {
      const secret = decodeCopilotSecret(
        await this.options.secrets
          .resolve(credential.ref, this.options.environment)
          .catch(() => ""),
      );
      if (auth === "token" && !secret.token)
        throw new CopilotError(
          "The account has no token; sign in again",
          "signed_out",
        );
      return this.#start(auth, auth === "token" ? secret.token : undefined);
    })();
    this.#hosts.set(key, started);
    started.catch(() => {
      if (this.#hosts.get(key) === started) this.#hosts.delete(key);
    });
    return started;
  }

  /** One request outside a session; the host rests afterwards. */
  async #once(
    credential: ProviderCredential,
    method: string,
  ): Promise<unknown> {
    const host = await this.#host(credential);
    clearTimeout(host.idle);
    try {
      return await host.request(method);
    } finally {
      this.#rest(keyOf(credential), host);
    }
  }

  /** Stop the host of an idle account after a while. */
  #rest(key: string, host: Host): void {
    clearTimeout(host.idle);
    if (host.sessions.size) return;
    host.idle = setTimeout(() => {
      if (host.sessions.size) return;
      void this.#stopKey(key);
    }, HOST_IDLE_MS);
    host.idle.unref();
  }

  async #stopKey(key: string): Promise<void> {
    const running = this.#hosts.get(key);
    this.#hosts.delete(key);
    const host = await running?.catch(() => undefined);
    await host?.stop();
  }

  async open(
    _provider: ProviderConfig,
    credential: ProviderCredential,
    options: CopilotSessionOptions,
    signal: AbortSignal,
  ): Promise<CopilotSession> {
    signal.throwIfAborted();
    const key = keyOf(credential);
    const host = await this.#host(credential);
    clearTimeout(host.idle);
    let result: Record<string, unknown> | undefined;
    try {
      result = record(
        await host.request("open", {
          model: options.model,
          system: options.system,
          tools: options.tools,
          ...(options.reasoningEffort
            ? { reasoningEffort: options.reasoningEffort }
            : {}),
        }),
      );
    } finally {
      if (!text(result?.session)) this.#rest(key, host);
    }
    if (!text(result?.session))
      throw new CopilotError("Copilot opened no session", "unavailable");
    const session = new HostSession(host, result.session, () =>
      this.#rest(key, host),
    );
    host.sessions.set(session.id, session);
    if (signal.aborted) {
      await session.close();
      signal.throwIfAborted();
    }
    return session;
  }

  async quota(
    _provider: ProviderConfig,
    credential: ProviderCredential,
  ): Promise<AllowanceReading[]> {
    const value = await this.#once(credential, "quota");
    const snapshots: QuotaSnapshot[] = [];
    for (const item of Array.isArray(value) ? value : []) {
      const snapshot = record(item);
      if (
        !text(snapshot?.name) ||
        typeof snapshot.remainingPercentage !== "number"
      )
        continue;
      snapshots.push({
        name: snapshot.name,
        unlimited: snapshot.unlimited === true,
        remainingPercentage: snapshot.remainingPercentage,
        ...(text(snapshot.resetDate) ? { resetDate: snapshot.resetDate } : {}),
      });
    }
    return copilotReadings(snapshots, this.options.clock());
  }

  /** The models the account may use, from Copilot's own list. */
  async models(credential: ProviderCredential): Promise<ProviderModel[]> {
    const value = await this.#once(credential, "models");
    const models: ProviderModel[] = [];
    for (const item of Array.isArray(value) ? value : []) {
      const model = record(item);
      if (!text(model?.id) || !model.id || model.enabled === false) continue;
      models.push({
        id: model.id,
        ...(count(model.contextWindow)
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(count(model.maxOutput) ? { maxOutputTokens: model.maxOutput } : {}),
        reasoning: model.reasoning === true,
        inputModalities: model.vision === true ? ["text", "image"] : ["text"],
      });
    }
    return models;
  }

  /**
   * Who a login or token signs in as, with a host that stops right after.
   *
   * @throws CopilotError `signed_out` when Copilot does not accept it.
   */
  async identify(
    auth: CopilotAuth,
    token: string | undefined,
  ): Promise<{ login: string; host: string }> {
    const host = await this.#start(auth, token);
    try {
      const status = record(await host.request("status"));
      if (!text(status?.login) || !status.login)
        throw new CopilotError(
          "Copilot reported no GitHub login for this account",
          "signed_out",
        );
      return {
        login: status.login.slice(0, 200),
        host:
          text(status.host) && status.host ? status.host : "https://github.com",
      };
    } finally {
      await host.stop();
    }
  }

  /** Stop the host of an account, for its sign-out or removal. */
  async stop(credential: ProviderCredential): Promise<void> {
    await this.#stopKey(keyOf(credential));
  }

  /** Stop every host. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#hosts.keys()].map((key) => this.#stopKey(key)));
  }
}
