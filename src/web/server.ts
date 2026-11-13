import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { release, userInfo } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { application as composeApplication, builtinHarnessName } from "../cli/session-application.js";
import { ProviderError } from "../contracts/provider.js";
import { ManagementError } from "../contracts/management.js";
import type { ConversationCommit, StartupSample } from "../contracts/conversation.js";
import { SessionError, parseNativeOptions, runId, sessionId, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type TurnLimits } from "../contracts/session.js";
import { MAX_CONTENT_BYTES } from "../contracts/content.js";
import type { EventPage, HarnessReadinessView, HarnessView, InstallationLogPage, InstallationUpgradeCheckView, MaintenanceView, NativeSessionListView, UninstallCheckView, InstallCheckView, WebState } from "../contracts/web.js";
import { inventory, officialInstallation } from "../infrastructure/catalog/inventory-composition.js";
import type { InstallationPolicy } from "../contexts/catalog/domain/catalog.js";
import { harnessEntry, productCommand } from "./harness-entry.js";
import { installationObservations, installationRef, installationViews, unofficialView } from "./harness-installations.js";
import { homePathsIn } from "./shown-paths.js";
import { officialInstallMethod } from "../adapters/catalog-channels.js";
import { harnessTier } from "../adapters/catalog.js";
import type { InstallationJobView } from "../contracts/management.js";
import { prepareConfiguration } from "../infrastructure/session/binding-factory.js";
import { chooseFolder, FolderDialogUnavailable, scratchFolder } from "../infrastructure/workspace/choose-folder.js";
import { supportedProviderProtocols } from "../contexts/provider/domain/provider.js";
import { observedPackageVersion } from "../infrastructure/management/system-version.js";
import { SessionStreamError, SessionStreamHub } from "./session-stream.js";
import { RelayApi, parseSendRelay } from "./relay-routes.js";
import { ConversationRoutes, type HeadLive } from "./conversation-routes.js";
import { commitFrame } from "./commit-frame.js";
import { DetailHeads } from "./detail-heads.js";
import { sendPieces } from "./download.js";
import { RunRelayReader } from "./run-relay.js";
import { TableApi } from "./table-routes.js";
import type { TableGrants } from "../contracts/table.js";
import { AttentionStreamHub } from "./attention-stream.js";
import { HarnessModels } from "./harness-models.js";
import { buildRevision, NativeCatalogCache, type NativeReadiness } from "./native-catalog-cache.js";
import { exportJson, exportMarkdown, rowsExport, rowsJsonExport } from "./conversation-export.js";
import { scrubDiagnostics, turnDiagnostics } from "./run-diagnostics.js";
import { messageStarts, turnSource } from "../contexts/session/domain/turn-source.js";
import { nativeResume } from "../infrastructure/management/verified-versions.js";
import { LoginShellStore, readLoginShellPath, type LoginShellDirectories } from "../infrastructure/discovery/login-shell.js";
import { CapabilityService, type InstalledChannel, type InstalledHarness } from "../infrastructure/capabilities/service.js";
import { CapabilityChanges, homeText } from "../infrastructure/capabilities/changes.js";
import { CapabilityError, INSTRUCTION_CHECK_OPTIONS, type InstructionCheckOption, type McpDefinitionView } from "../contracts/capabilities.js";
import type { GithubFetch } from "../infrastructure/capabilities/github.js";
import { TableMount } from "../infrastructure/table/mount.js";
import type { HubToolsOptions } from "../infrastructure/capabilities/hub-tools.js";
import type { ClaudeRunner } from "../infrastructure/capabilities/claude-mcp.js";
import { flavorOf } from "../adapters/flavors/index.js";
import { PERMISSION_KEY } from "../contracts/flavor.js";
import { TABLE_COMMAND_DIR } from "../contracts/table.js";

const MAX_BODY_BYTES = 128 * 1024;
/**
 * The request body of a message and of the answer to a question a Harness asked (a pasted file can be one): room for the longest input
 * (MAX_INPUT_BYTES, 32 MiB) with its JSON escaping. A guard against a runaway client, not a limit on what a message may say.
 */
const MAX_MESSAGE_BODY_BYTES = 64 * 1024 * 1024, MAX_ANSWER_BODY_BYTES = MAX_MESSAGE_BODY_BYTES;
/** The texts of the capability editors (a skill, the instructions, a subagent): up to 8 MiB each (only a guard against a mistaken paste), with room for JSON. */
const CAPABILITY_TEXT_BYTES = 8 * 1024 * 1024, CAPABILITY_BODY_BYTES = 4 * CAPABILITY_TEXT_BYTES;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
/**
 * Requests in progress at once, and connections open at once (streams included): guards against a client that opens them without end,
 * set far above what any page or tool of one user opens (a page keeps a few streams; 2026-11-12: 16 and 32 were too few for several
 * windows and a Harness's tool calls).
 */
const MAX_REQUESTS = 256;
const MAX_CONNECTIONS = 1024;
/** A request that has sent nothing for this long, with its body unfinished, is given up on: only silence ends it, however long it has taken so far. */
const REQUEST_IDLE_MS = 15_000;
const COOKIE_NAME = "harnessgateway_session";
const BOOTSTRAP_MS = 10 * 60 * 1000;
/**
 * How long a login lasts without a request (2026-11-12): every request of the logged-in page pushes the end of the login this far from
 * itself, and the cookie's Max-Age with it, so a login ends only after this much silence, not after a fixed time since it began.
 */
const LOGIN_MS = 8 * 60 * 60 * 1000;
/** The cookie is sent again after this long since it last was: not with every request, but long before its Max-Age could run out. */
const LOGIN_COOKIE_REFRESH_MS = 60_000;
interface Login { readonly id: string; readonly csrf: string; expires: number; renewed: number }
/** The Set-Cookie value of a login that ends `idleMs` after the request it answers. */
function loginCookie(id: string, idleMs: number): string { return COOKIE_NAME + "=" + id + "; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=" + Math.ceil(idleMs / 1000); }
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface WebServerOptions {
  readonly providerManagement?: boolean;
  readonly root: string;
  readonly configuration: SessionConfiguration;
  readonly port?: number;
  readonly assetsDirectory?: string;
  readonly application?: (root: string, publish: (commit: ConversationCommit) => void) => Omit<ReturnType<typeof composeApplication>, "grants"> & { readonly grants?: TableGrants };
  /** The operator's optional limits (the execution and wait budgets, conversations at once), resolved by `resolveTurnBudgets`; none otherwise. */
  readonly budgets?: TurnLimits;
  /** How long a login lasts without a request, and how often its cookie is sent again (8 hours and 1 minute by default); for tests that cannot wait for hours. */
  readonly login?: { readonly idleMs?: number; readonly refreshMs?: number };
  /** How long a request with an unfinished body may send nothing before it is given up on (15 seconds by default); for tests. */
  readonly requestIdleMs?: number;
  /**
   * The login shell the user may ask to read PATH from (G(ii)) and the system's shell list; absent or false: not offered
   * (CI, sandboxes and tests that do not name a fixture shell).
   */
  readonly loginShell?: { readonly shell: string | null; readonly shells: string } | false;
  /** The workspace lock namespace (`resolveWorkspaceLockRoot`) when this server composes its own application; the default otherwise. */
  readonly workspaceLockRoot?: string;
  /** Where conversations started without a folder get one of their own (2026-11-13); `chats` in the data directory by default. */
  readonly scratchRoot?: string;
  /** What counts as an installation (ADR-044) when this server composes its own application; the composition's default otherwise. */
  readonly installations?: InstallationPolicy;
  /** Fetches from GitHub without following redirects, for adding and updating skills (ADR-045 §4); the platform's `fetch` by default. */
  readonly github?: GithubFetch;
  /** The installation's relay key file (ADR-055 D5) when this server composes its own application; none otherwise (G072). */
  readonly relayKeyFile?: string;
  /** The context table's tokens (src/contracts/table.ts) when this server composes its own application; it makes its own otherwise. */
  readonly tableGrants?: TableGrants;
  /** The context table's mount, shared with whatever answers its tokens; this server makes its own when none is given, and sets its address once it listens. */
  readonly table?: TableMount;
  /** The Node and the tool program the Hub's own MCP entry runs (docs/decisions/LOG.md, 2026-11-11); the Node running the Hub and this build's `cli/hub-tools.js` by default. */
  readonly hubTools?: HubToolsOptions;
  /** Runs the user's `claude` for its own MCP commands (ADR-045 step 3b); the sandboxed system one by default. */
  readonly claude?: ClaudeRunner;
}
export interface WebServer { readonly url: string; close(): Promise<void> }
/** A list of Harness identities in a request body: unique, at most 16. */
function harnessList(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some(item => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(item)) || new Set(value).size !== value.length)
    throw new HttpError(400, "INVALID_INPUT", "Expected a bounded unique list of Harness identities");
  return value as string[];
}
/** An MCP definition in a request body, shaped only; what it may hold is checked by the list (ADR-045 §5). */
function mcpDefinition(value: unknown): McpDefinitionView {
  const fail = (): never => { throw new HttpError(400, "INVALID_INPUT", "Expected an MCP server definition"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>, keys = ["transport", "command", "args", "cwd", "url", "env", "headers"];
  if (Object.keys(input).some(key => !keys.includes(key))) return fail();
  const short = (item: unknown, limit: number): string => typeof item === "string" && item.length <= limit ? item : fail();
  const nullable = (item: unknown, limit: number): string | null => item === null || item === undefined ? null : short(item, limit);
  const rows = (item: unknown): Record<string, unknown>[] => item === undefined ? [] : Array.isArray(item) && item.length <= 64 && item.every(row => row !== null && typeof row === "object" && !Array.isArray(row)) ? item as Record<string, unknown>[] : fail();
  const transport = input.transport === "stdio" || input.transport === "http" || input.transport === "sse" ? input.transport : fail();
  const args = input.args === undefined ? [] : Array.isArray(input.args) && input.args.length <= 128 ? input.args.map(arg => short(arg, 4096)) : fail();
  return { transport, command: nullable(input.command, 4096), args, cwd: nullable(input.cwd, 4096), url: nullable(input.url, 4096),
    env: rows(input.env).map(row => typeof row.variable === "string" ? { key: short(row.key, 128), variable: short(row.variable, 128) } : { key: short(row.key, 128), value: short(row.value, 4096) }),
    headers: rows(input.headers).map(row => typeof row.variable === "string" ? { name: short(row.name, 128), variable: short(row.variable, 128), prefix: typeof row.prefix === "string" ? short(row.prefix, 32) : "" } : { name: short(row.name, 128), value: short(row.value, 4096) }) };
}
/** An instructions text in a request body: a string within the body's bounds; what it may hold is checked by the instructions (ADR-045 §6). */
function instructionText(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > CAPABILITY_TEXT_BYTES) throw new HttpError(400, "INVALID_INPUT", "Expected an instructions text");
  return value;
}
/** Each Harness's addition to the instructions, by its identity: at most 16. */
function instructionAdditions(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16 || Object.keys(value).some(key => !/^[a-z][a-z0-9-]{0,95}$/u.test(key)))
    throw new HttpError(400, "INVALID_INPUT", "Expected the additions by Harness identity");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, instructionText(item)]));
}
/** A subagent definition in a request body, shaped only; what it may hold is checked by the list (ADR-045 §7). */
function subagentDefinition(value: unknown): { readonly description: string; readonly prompt: string } {
  const input = record(value, ["description", "prompt"], ["description", "prompt"]);
  if (typeof input.description !== "string" || typeof input.prompt !== "string" || Buffer.byteLength(input.description, "utf8") > 8192 || Buffer.byteLength(input.prompt, "utf8") > CAPABILITY_TEXT_BYTES)
    throw new HttpError(400, "INVALID_INPUT", "Expected a subagent definition");
  return { description: input.description, prompt: input.prompt };
}
/** What the user said to a blocked instructions check, as `options=a,b`: known options, each once. */
function instructionOptions(value: string | null): ReadonlySet<InstructionCheckOption> {
  if (value === null || value === "") return new Set();
  const items = value.split(",");
  if (items.some(item => !(INSTRUCTION_CHECK_OPTIONS as readonly string[]).includes(item)) || new Set(items).size !== items.length) throw new HttpError(400, "INVALID_INPUT", "Unknown instructions check option");
  return new Set(items as InstructionCheckOption[]);
}
function record(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_INPUT", "Expected a JSON object");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !allowed.includes(key)) || required.some(key => !(key in item))) throw new HttpError(400, "INVALID_INPUT", "Unexpected or missing fields");
  return item;
}
function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum || /[\0\r\n]/u.test(value)) throw new HttpError(400, "INVALID_INPUT", "Invalid " + label);
  return value;
}
function command(value: unknown): string { return text(value, "command identity", 128); }
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new HttpError(400, "INVALID_INPUT", "Invalid " + label);
  return value;
}
function cursor(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new HttpError(400, "INVALID_INPUT", "Invalid cursor or limit");
  return integer(Number(value), minimum, maximum, "cursor or limit");
}
/** An ISO time in a request body, written as this Gateway writes its own (`toISOString`). */
function isoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "INVALID_INPUT", "Invalid " + label);
  return value;
}
/** Whether a management task has ended (completed, cancelled, failed or unknown), after which it changes nothing by itself. */
function settled(status: InstallationJobView["status"]): boolean {
  switch (status) {
    case "queued": case "resolving": case "installing": case "verifying": case "activating": return false;
    case "completed": case "cancelled": case "failed": case "unknown": return true;
  }
}
function select(value: unknown): SelectionRequest {
  const item = record(value, ["harnessId", "controlId", "provider", "nativeModel", "nativeOptions"], ["harnessId"]);
  if (typeof item.harnessId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(item.harnessId) ||
      (item.controlId !== undefined && (typeof item.controlId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(item.controlId)))) throw new HttpError(400, "INVALID_INPUT", "Invalid Harness selection");
  // The domain parser validates the Provider target; this boundary never casts it into a target.
  if (item.provider !== undefined && item.provider !== null) {
    if (item.nativeModel !== undefined || item.nativeOptions !== undefined) throw new HttpError(400, "INVALID_INPUT", "Native model and managed Provider are mutually exclusive");
    const target = record(item.provider, ["providerId", "revision", "model"], ["providerId", "revision", "model"]);
    const providerId = text(target.providerId, "Provider identity", 96), revision = integer(target.revision, 1, Number.MAX_SAFE_INTEGER, "Provider revision"), model = text(target.model, "model", 256);
    return { harnessId: item.harnessId, ...(item.controlId === undefined ? {} : { controlId: item.controlId }), provider: { providerId, revision, model } };
  }
  return { harnessId: item.harnessId, ...(item.controlId === undefined ? {} : { controlId: item.controlId }), ...(item.provider === null ? { provider: null } : {}),
    ...(item.nativeModel === undefined ? {} : { nativeModel: text(item.nativeModel, "native model", 1024) }), ...(item.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(item.nativeOptions) }) };
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(request: IncomingMessage): string | null {
  const values = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(COOKIE_NAME + "="));
  return values.length === 1 ? values[0]!.slice(COOKIE_NAME.length + 1) : null;
}
function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  // Everything comes from this Gateway (ADR-054 §2): system fonts and a bundled Geist Mono, no other origin.
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(value));
  headers(response); response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Content-Length", bytes.length);
  response.end(bytes);
}
async function body(request: IncomingMessage, maximum = MAX_BODY_BYTES): Promise<unknown> {
  if ((request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new HttpError(415, "INVALID_CONTENT_TYPE", "JSON request body required");
  if (request.headers["content-encoding"] !== undefined) throw new HttpError(415, "INVALID_CONTENT_ENCODING", "Encoded request bodies are unsupported");
  const limit = maximum < 1024 * 1024 ? Math.round(maximum / 1024) + " KiB" : Math.round(maximum / 1024 / 1024) + " MiB";
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximum)) throw new HttpError(413, "BODY_LIMIT", "Request body exceeds " + limit);
  const chunks: Buffer[] = []; let length = 0;
  // The body may take as long as it takes while bytes keep coming: it is given up on only after ten seconds of silence.
  const timer = setTimeout(() => request.destroy(new HttpError(408, "BODY_TIMEOUT", "Request body timed out")), 10000);
  timer.unref();
  try {
    for await (const chunk of request) {
      if (!(chunk instanceof Buffer)) throw new HttpError(400, "INVALID_INPUT", "Invalid request bytes");
      timer.refresh();
      length += chunk.length;
      if (length > maximum) throw new HttpError(413, "BODY_LIMIT", "Request body exceeds " + limit);
      chunks.push(chunk);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown; }
    catch { throw new HttpError(400, "INVALID_JSON", "Request body must be valid UTF-8 JSON"); }
  } finally { clearTimeout(timer); }
}
/**
 * Gives up on a request that has gone silent: checked every `idleMs`, a request whose body is unfinished and whose connection
 * has read no byte since the last check is destroyed. The request is not read here (a listener on the request or its socket would take
 * the body from its route); only the connection's byte count is.
 */
function watchIdle(request: IncomingMessage, idleMs: number): void {
  if (request.complete) return;
  const socket = request.socket;
  let seen = socket.bytesRead;
  const timer = setInterval(() => {
    if (request.complete || request.destroyed || socket.destroyed) { clearInterval(timer); return; }
    if (socket.bytesRead === seen) { clearInterval(timer); socket.destroy(); return; }
    seen = socket.bytesRead;
  }, idleMs);
  timer.unref();
  request.once("close", () => clearInterval(timer));
}
/** How many of an entry's latest Runs set its usual startup time. */
const STARTUP_SAMPLES = 5;
/**
 * Each Harness entry's latest catalog read, with its usual startup: the median time from starting the program to its open native session over its latest Runs
 * (`startupSamples`: the latest few of every entry, from the Runs' columns). An entry with Runs but no read is unchecked.
 */
function readinessViews(observed: readonly NativeReadiness[], samples: readonly StartupSample[]): HarnessReadinessView[] {
  // A Turn on a kept process did not start the program, so it says nothing about startup (ADR-030): the samples hold only Turns that started it.
  const times = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.readyAt < sample.preparingAt) continue;
    const key = sample.harnessId + "\0" + sample.controlId;
    times.set(key, [...times.get(key) ?? [], sample.readyAt - sample.preparingAt]);
  }
  const startup = (key: string) => {
    const latest = [...times.get(key) ?? []].sort((a, b) => a - b);
    return latest.length ? { startupMs: latest[Math.floor(latest.length / 2)]! } : {};
  };
  const views: HarnessReadinessView[] = observed.map(item => ({ harnessId: item.harnessId, controlId: item.controlId, state: item.state, checkedAt: item.checkedAt,
    ...(item.signedIn === undefined ? {} : { signedIn: item.signedIn }), ...(item.failureCode === undefined ? {} : { failureCode: item.failureCode }), ...startup(item.harnessId + "\0" + item.controlId) }));
  for (const key of times.keys()) {
    const [harnessId, controlId] = key.split("\0") as [string, string];
    if (!views.some(view => view.harnessId === harnessId && view.controlId === controlId)) views.push({ harnessId, controlId, state: "unchecked", checkedAt: null, ...startup(key) });
  }
  return views;
}
/**
 * The status, code and message a failure answers with. The domain errors keep their code and message, with every
 * spelling of the user's home in `homes` written as ~ (ADR-044) and then cut to 512 characters: a management or
 * capability error may name a program or file by its absolute path. An HttpError or a stream error keeps its own words;
 * anything else is a generic 500.
 */
function publicFailure(error: unknown, homes: readonly string[]): { readonly status: number; readonly code: string; readonly message: string } {
  if (error instanceof HttpError || error instanceof SessionStreamError) return error;
  if (error instanceof SessionError || error instanceof ProviderError || error instanceof ManagementError || error instanceof CapabilityError) {
    const code = error.code;
    const status = code.includes("NOT_FOUND") ? 404 : code === "INVALID_INPUT" || code === "INVALID_CURSOR" ? 400 : code.includes("LIMIT") || code === "QUEUE_FULL" ? 429
      : code.startsWith("RECOVERY_") || code.includes("UNAVAILABLE") || code.includes("CLOSED") || code.includes("BLOCKED") || code.includes("CONFLICT") || code.includes("PENDING") || code.includes("REVISION") || code.includes("UNSUPPORTED") || code.includes("BUSY") || code.includes("ACTIVE") || code === "STALE_DEFAULT" || code.endsWith("_CHANGED") || code.includes("REFUSED") || code.endsWith("_EXPIRED") || code.includes("INCOMPATIBLE") || code.endsWith("_REQUIRED") ? 409 : 502;
    // Write ~ before cutting: every whole spelling of the home is replaced first, so a home that crosses the 512th
    // character can no longer leave its first half in the answer; the cut then only shortens text that already says ~.
    return { status, code, message: homeText(homes)(error.message).slice(0, 512) };
  }
  return { status: 500, code: "GATEWAY_FAILED", message: "Gateway operation failed" };
}
/** Native session listing and continuing failures, named for the person choosing a session; private detail stays out. */
function importFailure(error: unknown): unknown {
  if (error instanceof HttpError || error instanceof SessionError) return error;
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 128) : "NATIVE_SESSION_IMPORT_FAILED";
  const known: Readonly<Record<string, readonly [number, string]>> = {
    NATIVE_SESSION_NOT_FOUND: [404, "这个工作区的本机会话列表里没有它，可能已删除或属于其他目录。"],
    NATIVE_SESSION_WORKSPACE_MISMATCH: [409, "这个本机会话属于其他工作区。请先切换到它所在的工作区。"],
    NATIVE_SESSION_UNAVAILABLE: [409, "这个本机会话不能继续，例如原程序的临时会话。"],
    NATIVE_SESSION_LIST_UNAVAILABLE: [409, "这个 Harness 不能在 Hub 中继续它自己的会话。"],
    NATIVE_RESUME_UNAVAILABLE: [409, "这个 Harness 没有声明原生会话恢复，不能继续它的会话。"],
  };
  const [status, message] = known[code] ?? [502, "无法读取这个本机会话。请检查这个 Harness 的登录和配置后重试。"];
  return new HttpError(status, code, message);
}
function queries(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "INVALID_INPUT", "Unexpected query parameters");
}
const MIME: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
async function asset(root: string, pathname: string, response: ServerResponse, method: string): Promise<void> {
  const path = resolve(root, pathname === "/" ? "index.html" : "." + pathname);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith(".." + sep) || fromRoot === ".." || isAbsolute(fromRoot)) throw new HttpError(404, "NOT_FOUND", "Page not found");
  let canonical: string;
  try { canonical = await realpath(path); }
  catch { throw new HttpError(404, "NOT_FOUND", "Page not found; build the frontend first"); }
  const resolved = relative(root, canonical);
  if (resolved.startsWith(".." + sep) || resolved === ".." || isAbsolute(resolved)) throw new HttpError(404, "NOT_FOUND", "Page not found");
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ASSET_BYTES || MIME[extname(canonical)] === undefined) throw new HttpError(404, "NOT_FOUND", "Page not found");
    const buffer = Buffer.alloc(MAX_ASSET_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(buffer, length, buffer.length - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > MAX_ASSET_BYTES) throw new HttpError(413, "ASSET_LIMIT", "Asset exceeds its byte budget");
    const bytes = buffer.subarray(0, length);
    if (response.destroyed || response.writableEnded) return;
    headers(response); response.statusCode = 200;
    response.setHeader("Content-Type", MIME[extname(canonical)]!); response.setHeader("Content-Length", bytes.length);
    response.end(method === "HEAD" ? undefined : bytes);
  } finally { await handle.close(); }
}

/** Native content is served as data: only known raster images and JSON/plain text render inline, never HTML or SVG. */
const INLINE_CONTENT = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/json", "text/plain"]);
async function content(path: string, ref: { readonly name: string; readonly mediaType: string; readonly bytes: number }, response: ServerResponse, method: string, download: boolean): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== ref.bytes) throw new HttpError(409, "CONTENT_CHANGED", "Stored content changed");
    if (response.destroyed || response.writableEnded) return;
    headers(response); response.statusCode = 200;
    const inline = !download && INLINE_CONTENT.has(ref.mediaType);
    response.setHeader("Content-Type", inline ? ref.mediaType + (ref.mediaType.startsWith("text/") || ref.mediaType === "application/json" ? "; charset=utf-8" : "") : "application/octet-stream");
    response.setHeader("Content-Length", ref.bytes);
    response.setHeader("Content-Disposition", (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(ref.name));
    response.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    response.setHeader("Cache-Control", "private, max-age=3600");
    if (method === "HEAD") { response.end(); return; }
    await new Promise<void>((done, reject) => {
      const stream = handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 });
      stream.once("error", reject); response.once("close", done);
      stream.once("end", () => { response.end(); done(); });
      stream.pipe(response, { end: false });
    });
  } finally { await handle.close(); }
}

/** Owns the HTTP listener and a real application owner; browser connection loss never cancels a Run. */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const port = options.port ?? 0;
  integer(port, 0, 65535, "port");
  const assetPath = resolve(options.assetsDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/dist"));
  const assets = await realpath(assetPath).catch((error: unknown) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return assetPath;
    throw error;
  });
  let app: ReturnType<typeof composeApplication>;
  // The context table's mount (docs/decisions/LOG.md, 2026-11-11): the native processes the application starts carry this server's address and a token each.
  const table = options.table ?? new TableMount(options.tableGrants, join(options.root, TABLE_COMMAND_DIR));
  // The relay's API (ADR-055 §12.4): its routes, the delivery state of the Runs it shows and the bodies of the errors it explains.
  let relayApi: RelayApi;
  // A Turn waits for a slot only when an operator limited the conversations running at once; conversations sharing a workspace do not wait.
  const queueOf = (id: SessionId): NonNullable<HeadLive["queue"]> | null => {
    const slot = app.runtime.slotWait(id);
    return slot !== null ? { kind: "slot", ...slot } : null;
  };
  // The reads of a conversation kept as rows, as the API answers them (src/web/conversation-routes.ts); made once the Gateway's parts they read from exist, below.
  let conversations: ConversationRoutes | undefined;
  const streams = new SessionStreamHub({ snapshot: id => conversations!.session(id),
    frame: commit => { const id = commit.changes.head!.row.id as SessionId; return commitFrame(commit.changes, conversations!.headView(commit.changes.head!.row), conversations!.frameViews(id)); },
    stale: commit => conversations!.needsSnapshot(commit) }, {}, failure => {
    const fault = publicFailure(failure.error, homeForms());
    process.stderr.write("HarnessGateway: SESSION_STREAM_READ_FAILED (" + app.providers.redact(fault.code).slice(0, 128) + ")\n");
  }, () => attention.frame());
  // Waiting approvals and questions of every conversation, refreshed after each published commit (ADR-035). A page with a
  // conversation open gets them on that conversation's stream; a page without one subscribes to them alone.
  const attention = new AttentionStreamHub(() => app.runtime.attention(), {}, frame => streams.attentionChanged(frame));
  const made = (options.application ?? ((root, publish) => composeApplication(root, publish, { ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.workspaceLockRoot === undefined ? {} : { workspaceLockRoot: options.workspaceLockRoot }),
    ...(options.installations === undefined ? {} : { installations: options.installations }), ...(options.relayKeyFile === undefined ? {} : { relayKeyFile: options.relayKeyFile }),
    table, tableGrants: table.grants })))(options.root, commit => {
    // What the head tells besides the commit's rows (the totals of the Runs, the edits) moves along with it before the frame is made; the frame is one for the commit.
    try { conversations?.observe(commit); streams.publish(commit); } finally { if (app !== undefined) attention.changed(); }
  });
  // An application put together by hand may bring no tokens for the context table: it then has a table nobody can enter.
  app = { ...made, grants: made.grants ?? table.grants };
  relayApi = new RelayApi({ reads: app.store,
    declaration: selection => { const factory: SessionBindingFactory = app.factory; return factory.relayCapabilities?.(selection); },
    // What each binding asks the user to look at, and whether the data directory is in the workspace's reach: the Runtime's reads (never a block).
    attention: id => app.runtime.relayAttention(id), installation: () => app.runtime.relayInstallation(), http: { json, headers, queries, body } });
  // The context table's API (docs/decisions/LOG.md, 2026-11-11): what a Harness running a Turn of a conversation may read back of it, by the token its process was given.
  const tableApi = new TableApi({ grants: app.grants, reader: app.store, content: app.content,
    secrets: (configuration, harnessIds) => { const factory: SessionBindingFactory = app.factory; return factory.relaySecrets === undefined ? Promise.resolve([]) : factory.relaySecrets(configuration, harnessIds); },
    http: { json, queries, body: request => body(request) },
    // `hub_update_plan` and `hub_wrap_up`: the Turn in progress of the token's conversation takes them, from the Harness the token was minted for.
    progress: (grant, made) => { app.runtime.hubProgress(grant.sessionId, { harnessId: grant.harnessId, controlId: grant.controlId }, made); },
    // `hub_delegate`, `hub_delegations` (2026-11-13): the Turn's Harness hands a part of its work to another Harness of this computer, at the conversation's own permission level.
    delegation: {
      start: async (grant, wanted, task) => {
        const usable = harnesses.filter(item => item.controls.some(control => control.available)), key = wanted.toLowerCase();
        const found = usable.find(item => item.id === key) ?? usable.find(item => item.name.toLowerCase() === key) ?? usable.find(item => item.name.toLowerCase().replace(/[^a-z0-9]/gu, "") === key.replace(/[^a-z0-9]/gu, ""));
        if (found === undefined) throw new HttpError(400, "DELEGATE_HARNESS_UNKNOWN", "No such Harness on this computer. Give one of: " + usable.map(item => item.id).join(", ") + ".");
        const control = found.controls.find(item => item.id === found.defaultControlId && item.available) ?? found.controls.find(item => item.available)!;
        const level = app.store.get(grant.sessionId).selection.nativeOptions?.[PERMISSION_KEY] ?? "auto", id = randomBytes(12).toString("hex");
        const child = await app.runtime.delegate(grant.sessionId, { harnessId: found.id, controlId: control.id, nativeOptions: { [PERMISSION_KEY]: level } }, "hub-delegate-" + id, { harnessId: grant.harnessId, controlId: grant.controlId });
        if (child.runs.length === 0) app.runtime.send(child.id, task, "hub-delegate-" + id + "-task");
        return { sessionId: child.id, harness: found.name };
      },
      states: grant => app.runtime.delegationsFor(grant.sessionId, { harnessId: grant.harnessId, controlId: grant.controlId }),
    } });
  // This build: every compiled Gateway file by name and content (ADR-033), also named in a Turn's diagnostics (ADR-037).
  const revision = buildRevision(fileURLToPath(new URL("..", import.meta.url)));
  // Derived observations only; a file this version cannot adopt is reported and left as it is. Catalogs are reused only by
  // the build that read them (every compiled Gateway file), since its drivers decide what a catalog contains.
  const nativeModels = new HarnessModels(app.factory, new NativeCatalogCache(realpathSync(options.root), { assertOwner: () => app.store.assertOwner(),
    report: problem => process.stderr.write("HarnessGateway: NATIVE_CATALOG_CACHE_UNAVAILABLE (" + problem + ")\n"), revision }));
  // Each Turn as the wire tells it: Harnesses named as the relay names them, models as the catalogs read so far name them, tool details as the content store reads them back.
  let scannedNames: ReadonlyMap<string, string> = new Map();
  // A Harness is named as the Harness list names it (the catalog of the last scan), the built-in catalog's name when the scan has not seen it: the page shows one name for it everywhere.
  const builtinName = builtinHarnessName();
  const detailHeads = new DetailHeads(app.content);
  const runRelay = new RunRelayReader({ relayDeliveries: id => app.store.relayDeliveries(id), events: (id, after, limit) => app.store.events(id, after, limit), get: id => app.store.get(id) });
  conversations = new ConversationRoutes({ reader: app.store, facts: app.store, relay: id => runRelay.of(id),
    env: { harnessName: harnessId => scannedNames.get(harnessId) ?? builtinName(harnessId), modelName: (harnessId, nativeModel) => nativeModels.modelName(harnessId, nativeModel), detail: ref => detailHeads.read(ref) },
    // What only the running service knows of a conversation: the requests that wait for the user, the slot it waits for, the process it keeps.
    live: id => {
      const lost = app.runtime.keptLoss(id), outside = app.runtime.keptOutside(id), upgraded = app.runtime.keptUpgrade(id), queue = queueOf(id);
      return { permissions: app.runtime.permissionRequests(id), ...(queue === null ? {} : { queue }),
        retention: { process: app.runtime.keptProcess(id), ...(lost === null ? {} : { lost }), ...(outside === null ? {} : { outside }), ...(upgraded === null ? {} : { upgraded }) } };
    } });
  /** A conversation's title for the lists of conversations a maintenance step names; the generic name for one that is gone. */
  const titleOf = (id: string): string => { try { const row = app.store.head(sessionId(id)); return row.deletedAt === null ? row.title : "对话"; } catch { return "对话"; } };
  // Directories the user took from the login shell's PATH (G(ii)) extend discovery and new conversations until removed.
  const loginShells = new LoginShellStore(realpathSync(options.root));
  // What each installed Harness reads besides its model (ADR-045 step 1), from the user's own files; read-only.
  const capabilities = new CapabilityService(app.factory.discoveryEnvironment);
  let loginDirs: LoginShellDirectories | null = await loginShells.load();
  const searchDirs = (): readonly string[] => [...options.configuration.searchDirs, ...(loginDirs?.dirs ?? []).filter(dir => !options.configuration.searchDirs.includes(dir))];
  const loginShellView = () => ({ available: options.loginShell !== undefined && options.loginShell !== false && options.loginShell.shell !== null,
    ...(options.loginShell && options.loginShell.shell !== null ? { shell: basename(options.loginShell.shell) } : {}), dirs: loginDirs?.dirs ?? [], readAt: loginDirs?.readAt ?? null });
  // Where conversations started without a folder get theirs, as the canonical path their workspaces will carry (it need not exist yet).
  const scratchRoot = await (async (path: string) => {
    const rest: string[] = [];
    for (let at = path; ;) { try { return join(await realpath(at), ...rest); } catch { const up = dirname(at); if (up === at) return path; rest.unshift(basename(at)); at = up; } }
  })(resolve(options.scratchRoot ?? join(options.root, "chats")));
  /** A request's workspace with this Gateway's catalog, configuration home and search settings. */
  const workspaceConfiguration = (workspace: string) => prepareConfiguration({ workspace,
    ...(options.configuration.configHome === null ? {} : { configHome: options.configuration.configHome }),
    ...(options.configuration.manifestPath === null ? {} : { manifestPath: options.configuration.manifestPath }),
    packageRoots: options.configuration.packageRoots, searchDirs: searchDirs(), pathOnly: options.configuration.pathOnly });
  /** A product's official installation for its page, with how HarnessHub can run it here (ADR-044). */
  const installView = (id: string): HarnessView["install"] => {
    const official = officialInstallation(id), method = officialInstallMethod(id);
    if (official === null) return null;
    const kind = method?.kind ?? "terminal";
    return { ...official, method: kind, available: kind !== "terminal" && app.management.offersOfficialInstall() };
  };
  /** The user's home as given and as resolved, for the privacy guard of confirmations (ADR-044). */
  const homeForms = (): readonly string[] => { const home = app.factory.discoveryEnvironment.home; try { return [...new Set([home, realpathSync(home)])]; } catch { return [home]; } };
  // Changes to a Harness's own configuration (ADR-045 §3): checked, shown, applied once on confirmation, with backups.
  const capabilityChanges = new CapabilityChanges({ root: realpathSync(options.root), generation: app.store.ownerGeneration, assertOwner: () => app.store.assertOwner(),
    environment: app.factory.discoveryEnvironment, homes: homeForms(), ...(options.github === undefined ? {} : { github: options.github }),
    ...(options.hubTools === undefined ? {} : { hubTools: options.hubTools }), ...(options.claude === undefined ? {} : { claude: options.claude }) });
  /** The installed Harnesses of a scan's views: each one's official installation the Gateway uses. */
  const installedIn = (views: readonly HarnessView[]): readonly InstalledHarness[] => views.flatMap(harness => {
    const products = harness.installations.filter(item => item.role === "product"), chosen = products.find(item => item.active) ?? products[0];
    if (!chosen) return [];
    // The channel record tells OpenCode 1 from OpenCode 2 (package, formula, tap); the view itself carries no such record.
    const channel = installationChannels.get(chosen.ref);
    return [{ harnessId: harness.id, name: harness.name, version: chosen.version, ...(channel === undefined ? {} : { channel }) }];
  });
  /**
   * The installed Harnesses a capability read or change covers, as a scan at this request finds them (these reads and checks are
   * the user's own requests; ADR-050 leaves them as they were).
   */
  const installedHarnesses = async (): Promise<readonly InstalledHarness[]> => installedIn(await rescan());
  /** Answers with a capability value only when it names no path by its absolute home form (ADR-044's privacy guard). */
  const privateJson = (response: ServerResponse, value: unknown) => {
    if (homePathsIn(value, homeForms(), 1 << 20).length) throw new HttpError(500, "PRIVACY_GUARD", "a capability answer named a path by its absolute home form");
    json(response, 200, value);
  };
  const loginMs = options.login?.idleMs ?? LOGIN_MS, loginRefreshMs = options.login?.refreshMs ?? LOGIN_COOKIE_REFRESH_MS;
  let origin = "", host = "", running = 0, stopping = false, closing: Promise<void> | null = null;
  const bootstrap = randomBytes(32).toString("hex"), bootstrapExpires = Date.now() + BOOTSTRAP_MS;
  let bootstrapAvailable = true;
  const logins = new Map<string, Login>();
  // The last completed scan of this computer's Harnesses and when it began (ADR-050). Reading the state shows these and
  // never scans. A scan runs at startup, on the user's request, after the login shell's directories change, before a
  // management task is checked or accepted, after an update check, and once a task's end has been read.
  let harnesses: readonly HarnessView[] = [];
  /** Each official installation's channel record by its reference, from the same scan as `harnesses` (ADR-044; no path). */
  let installationChannels: ReadonlyMap<string, InstalledChannel> = new Map();
  let scannedAt = "";
  let scan: { readonly startedAt: string; readonly done: Promise<readonly HarnessView[]> } | null = null;
  /**
   * Ends once a completed scan began at or after `time` (an ISO time of this Gateway's clock, such as a task's end; the
   * clock counts milliseconds, so the same one counts): at once when the last one did, with the running one when it began
   * then, otherwise with a new one after the running one.
   */
  const scanAfter = async (time: string): Promise<void> => {
    const after = Date.parse(time), covered = () => Date.parse(scannedAt) >= after;
    if (covered()) return;
    const running = scan;
    if (running !== null) {
      if (Date.parse(running.startedAt) >= after) { await running.done; return; }
      // It began too early to count: its failure is for its own request to report, and this one scans again.
      await running.done.catch(() => []);
      if (covered()) return;
    }
    await rescan();
  };
  /** A scan with the current search directories, after any scan still running with the previous ones. */
  const rescanWith = (): Promise<void> => scanAfter(new Date().toISOString());
  const rescan = (): Promise<readonly HarnessView[]> => {
    if (scan) return scan.done;
    const startedAt = new Date().toISOString();
    const pending = inventory({ ...(options.configuration.manifestPath === null ? {} : { manifest: options.configuration.manifestPath }),
      environment: app.factory.discoveryEnvironment.values, home: app.factory.discoveryEnvironment.home,
      searchDirs: searchDirs(), packageRoots: options.configuration.packageRoots, pathOnly: options.configuration.pathOnly,
      installations: app.factory.installations, managedResolver: app.management }).then(async observed => {
      app.management.setSystemObservations(observed.report.harnesses.flatMap(harness => harness.controls.flatMap(control => {
        if (control.state !== "candidate" || control.command === null || observed.managedBindings.has(control.id)) return [];
        const packageVersion = observedPackageVersion(control.diagnostics), program = productCommand(observed.definitions.find(item => item.id === harness.id)?.binaryNames[0], harness.installation, control);
        return [{ harnessId: harness.id, controlId: control.id, command: control.command, ...(packageVersion === undefined ? {} : { packageVersion }), ...(program === null ? {} : { program }) }];
      })));
      // Every official installation by its reference, for uninstall checks and submissions (ADR-044).
      app.management.setInstallations(observed.report.harnesses.flatMap(harness => {
        const definition = observed.definitions.find(item => item.id === harness.id);
        return installationObservations(harness.id, harness.installation, app.factory.discoveryEnvironment.home,
          command => definition?.controls.find(control => control.executableNames.includes(command))?.id ?? definition?.controls[0]?.id ?? harness.id);
      }));
      await app.management.refreshSystemVersions();
      await app.management.refreshNativeCapabilities();
      const management = new Map(app.management.views(observed.report.harnesses.map(item => item.id)).map(item => [item.harnessId, item]));
      const views = observed.report.harnesses.map((item): HarnessView => {
        const managed = management.get(item.id);
        if (!managed) throw new HttpError(503, "MANAGEMENT_UNAVAILABLE", "Harness management observation is unavailable");
        const installed = item.installation.candidates.length > 0 || item.controls.some(control => control.state === "candidate");
        const available = item.controls.filter(control => control.state === "candidate" && (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc"));
        const managedControls = available.filter(control => observed.managedBindings.has(control.id));
        const defaultControlId = managedControls.length === 1 ? managedControls[0]!.id : managedControls.length === 0 && available.length === 1 ? available[0]!.id : null;
        return { id: item.id, name: item.name, tier: harnessTier(item.id), installed, defaultControlId,
        controls: item.controls.map(control => ({ id: control.id, protocol: control.protocol, available: control.state === "candidate" && (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc"),
          reason: control.state === "candidate" ? (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc" ? null : "Control Driver is not implemented")
            : observed.customEntries.has(control.id) ? "发现清单中的自定义入口不可用（不存在或不可执行）" : control.missingDependencies.length ? "Missing: " + control.missingDependencies.join(", ") : "Control entry unavailable",
          entry: harnessEntry(control, observed.managedBindings.has(control.id)) })),
        providerProtocols: item.controls.some(control => control.state === "candidate" && ((item.id === "codex" && control.protocol === "codex-app-server") || (item.id === "gemini" && control.protocol === "acp-v1"))) ? supportedProviderProtocols(item.id) : [],
        management: { ...managed, source: managed.source === "managed" ? "managed" : installed ? "system" : "missing" }, install: installView(item.id),
        installations: installationViews(item.id, item.installation, app.factory.discoveryEnvironment.home, ref => app.management.installationUpgrade(item.id, ref)),
        unofficial: unofficialView(item.installation, observed.definitions.find(definition => definition.id === item.id)?.binaryNames[0]) };
      });
      // A scan that began earlier never replaces one that began later, whichever ends first.
      if (scannedAt === "" || Date.parse(startedAt) >= Date.parse(scannedAt)) {
        harnesses = views; scannedAt = startedAt; scannedNames = new Map(views.map(view => [view.id, view.name]));
        installationChannels = new Map(observed.report.harnesses.flatMap(item => item.installation.candidates.flatMap(candidate => candidate.channel === null ? []
          : [[installationRef(candidate), { kind: candidate.channel.kind, name: candidate.channel.name, ...(candidate.channel.tap === undefined ? {} : { tap: candidate.channel.tap }) }] as const])));
      }
      return views;
    });
    const running = { startedAt, done: pending };
    scan = running;
    void pending.then(() => { if (scan === running) scan = null; }, () => { if (scan === running) scan = null; });
    return pending;
  };
  const authenticated = (request: IncomingMessage, response: ServerResponse): Login => {
    const token = cookie(request), login = token === null ? undefined : logins.get(token), now = Date.now();
    if (!login || login.expires < now) { if (token !== null) logins.delete(token); throw new HttpError(401, "AUTH_REQUIRED", "Open the Gateway startup link to connect"); }
    // A request is activity: the login now ends LOGIN_MS after it, and the cookie says so (sent again once a minute has passed since it last was).
    login.expires = now + loginMs;
    if (now - login.renewed >= loginRefreshMs) { login.renewed = now; response.setHeader("Set-Cookie", loginCookie(login.id, loginMs)); }
    return login;
  };
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (stopping) throw new HttpError(503, "GATEWAY_STOPPING", "Gateway is stopping");
    // The table's callers are programs on this computer, which may name it localhost; no other name is accepted for any route.
    const forTable = typeof request.url === "string" && /^\/api\/table\/[a-z]/u.test(request.url);
    if (request.headers.host !== host && !(forTable && request.headers.host === "localhost:" + host.slice(host.lastIndexOf(":") + 1))) throw new HttpError(403, "HOST_REJECTED", "Invalid local Host");
    const receivedOrigin = request.headers.origin;
    if (receivedOrigin !== undefined && receivedOrigin !== origin) throw new HttpError(403, "ORIGIN_REJECTED", "Cross-origin request rejected");
    if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "ORIGIN_REJECTED", "Cross-site request rejected");
    if (!request.url || !request.url.startsWith("/") || request.url.startsWith("//") || request.url.length > 4096 || /%(?:2f|5c|00)|\\/iu.test(request.url.split("?", 1)[0]!)) throw new HttpError(400, "INVALID_PATH", "Invalid request path");
    const url = new URL(request.url, origin), path = url.pathname, method = request.method ?? "GET";
    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      queries(url, []); await asset(assets, path, response, method); return;
    }
    // The context table is read by a Harness's tool process with a bearer token, not by the page: it has no login and no CSRF token.
    if (forTable) { if (await tableApi.handle(request, response, url, method)) return; throw new HttpError(404, "NOT_FOUND", "API route not found"); }
    const write = method !== "GET" && method !== "HEAD";
    if (write && receivedOrigin !== origin) throw new HttpError(403, "ORIGIN_REQUIRED", "Same-origin write required");
    if (path === "/api/v1/auth/bootstrap") {
      if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST required");
      queries(url, []);
      const value = record(await body(request), ["token"], ["token"]), token = text(value.token, "startup token", 128);
      if (!bootstrapAvailable || Date.now() > bootstrapExpires || !equal(token, bootstrap)) throw new HttpError(401, "AUTH_REQUIRED", "Startup link expired or already used");
      bootstrapAvailable = false;
      const loginId = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
      logins.set(loginId, { id: loginId, csrf, expires: Date.now() + loginMs, renewed: Date.now() });
      response.setHeader("Set-Cookie", loginCookie(loginId, loginMs));
      json(response, 200, { csrfToken: csrf }); return;
    }
    const login = authenticated(request, response);
    if (write && (typeof request.headers["x-csrf-token"] !== "string" || !equal(request.headers["x-csrf-token"], login.csrf))) throw new HttpError(403, "CSRF_REJECTED", "Invalid write token");
    if (path === "/api/v1/auth/session" && method === "GET") { queries(url, []); json(response, 200, { csrfToken: login.csrf }); return; }
    // Both answer with the last completed scan (ADR-050): reading them starts no discovery, and a scan still running is
    // not waited for. The startup scan ends before the listener opens, so there always is one.
    if (path === "/api/v1/state" && method === "GET") {
      queries(url, []); const listed = conversations!.sessions({});
      const output: WebState = { providerManagement: options.providerManagement ?? true, workspace: options.configuration.workspace, scratchRoot, providers: app.providers.list(), harnesses, harnessesScannedAt: scannedAt,
        sessions: listed.sessions, sessionsNext: listed.next, jobs: app.management.listJobs(50), readiness: readinessViews(nativeModels.readiness(), app.store.startupSamples(STARTUP_SAMPLES)), installationPolicy: app.factory.installations,
        // This Gateway has the relay API (ADR-055 §12.4): the page asks for the relay of a Gateway that says so and of none else.
        relay: true };
      json(response, 200, output); return;
    }
    if (path === "/api/v1/harnesses" && method === "GET") { queries(url, []); json(response, 200, harnesses); return; }
    // The login shell's PATH, read once on the user's request: it runs the shell's login configuration (G(ii)).
    if (path === "/api/v1/discovery/login-shell") {
      if (method === "GET") { queries(url, []); json(response, 200, loginShellView()); return; }
      if (method === "POST") {
        queries(url, []); record(await body(request), ["commandId"], ["commandId"]);
        const setting = options.loginShell;
        if (!setting || setting.shell === null) throw new HttpError(409, "LOGIN_SHELL_UNAVAILABLE", "reading the login shell is not offered here");
        const values = app.factory.discoveryEnvironment.values, env = Object.fromEntries(["HOME", "USER", "LOGNAME", "LANG", "TMPDIR"].flatMap(name => values[name] === undefined ? [] : [[name, values[name]!]]));
        // Only what the login shell adds: directories this Gateway already searches are not listed again.
        const known = new Set([...(values.PATH ?? "").split(":"), ...options.configuration.searchDirs]);
        loginDirs = { shell: setting.shell, readAt: Date.now(), dirs: (await readLoginShellPath(setting.shell, { shells: setting.shells, env })).filter(dir => !known.has(dir)) };
        await loginShells.save(loginDirs); await rescanWith();
        json(response, 200, loginShellView()); return;
      }
    }
    if (path === "/api/v1/discovery/login-shell/remove" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["dir", "commandId"], ["dir", "commandId"]), dir = text(input.dir, "directory", 4096);
      if (loginDirs !== null && loginDirs.dirs.includes(dir)) { loginDirs = { ...loginDirs, dirs: loginDirs.dirs.filter(item => item !== dir) }; await loginShells.save(loginDirs); await rescanWith(); }
      json(response, 200, loginShellView()); return;
    }
    // Read-only (ADR-045 step 1): skills, MCP, instructions, subagents, commands, hooks and plugins of every installed
    // Harness, by its read table. Nothing is written or started; the view carries names and counts, never a value.
    if (path === "/api/v1/capabilities" && method === "GET") { queries(url, []); privateJson(response, await capabilities.view(await installedHarnesses(), capabilityChanges.placedLinks(), capabilityChanges.installedSkills())); return; }
    // Adding, updating and deleting skills of the shared directory (ADR-045 §4): reading GitHub and each check change
    // nothing; a check shows the folders, links and lock entry first, and the change is applied through /changes.
    if (path === "/api/v1/capabilities/skill-sources" && method === "GET") {
      queries(url, ["source"]); privateJson(response, await capabilityChanges.listSkillSource(text(url.searchParams.get("source"), "repository", 512))); return;
    }
    if (path === "/api/v1/capabilities/skill-add" && method === "GET") {
      queries(url, ["listing", "names"]);
      const names = text(url.searchParams.get("names"), "skill names", 64 * 129).split(",");
      if (names.some(name => !/^[a-z0-9._-]{1,255}$/u.test(name))) throw new HttpError(400, "INVALID_INPUT", "Expected skill folder names separated by commas");
      privateJson(response, await capabilityChanges.checkSkillAdd(text(url.searchParams.get("listing"), "listing", 64), names, await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/skill-updates" && method === "GET") {
      queries(url, ["refresh"]); const refresh = url.searchParams.get("refresh");
      if (refresh !== null && refresh !== "1") throw new HttpError(400, "INVALID_INPUT", "invalid refresh flag");
      privateJson(response, await capabilityChanges.checkSkillUpdates(refresh === "1")); return;
    }
    if (path === "/api/v1/capabilities/skill-update" && method === "GET") {
      queries(url, ["name", "overwrite"]); const overwrite = url.searchParams.get("overwrite");
      if (overwrite !== null && overwrite !== "true" && overwrite !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected overwrite=true or overwrite=false");
      privateJson(response, await capabilityChanges.checkSkillUpdate(text(url.searchParams.get("name"), "skill name", 255), overwrite === "true")); return;
    }
    // Writing a skill from the user's texts (ADR-045 step 5: commands become shared skills), and changing one HarnessHub
    // wrote: the check is a POST because the texts are long; nothing is written until /changes.
    if ((path === "/api/v1/capabilities/skill-create" || path === "/api/v1/capabilities/skill-edit") && method === "POST") {
      queries(url, []); const input = record(await body(request, CAPABILITY_BODY_BYTES), ["name", "description", "body", "overwrite"], ["name", "description", "body"]);
      if (typeof input.description !== "string" || typeof input.body !== "string" || Buffer.byteLength(input.description, "utf8") > 8192 || Buffer.byteLength(input.body, "utf8") > CAPABILITY_TEXT_BYTES)
        throw new HttpError(400, "INVALID_INPUT", "Expected a skill's description and body");
      if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Expected overwrite to be a boolean");
      const name = text(input.name, "skill name", 64), texts = { description: input.description, body: input.body };
      privateJson(response, path.endsWith("/skill-create") ? await capabilityChanges.checkSkillCreate(name, texts, await installedHarnesses()) : await capabilityChanges.checkSkillEdit(name, texts, input.overwrite === true)); return;
    }
    if (path === "/api/v1/capabilities/skill-text" && method === "GET") {
      queries(url, ["name"]); privateJson(response, { text: await capabilityChanges.skillText(text(url.searchParams.get("name"), "skill name", 64)) }); return;
    }
    if (path === "/api/v1/capabilities/skill-delete" && method === "GET") {
      queries(url, ["name"]); privateJson(response, await capabilityChanges.checkSkillDelete(text(url.searchParams.get("name"), "skill name", 255))); return;
    }
    // HarnessHub's MCP list (ADR-045 §5): reading it and editing the list change no Harness file; writing a server into a
    // Harness goes through a check shown first and /changes.
    if (path === "/api/v1/capabilities/mcp" && method === "GET") { queries(url, []); privateJson(response, await capabilityChanges.mcpInventory(await installedHarnesses())); return; }
    if (path === "/api/v1/capabilities/mcp/servers" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["name", "definition", "replace"], ["name", "definition"]);
      if (input.replace !== undefined && typeof input.replace !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Expected replace to be a boolean");
      privateJson(response, await capabilityChanges.saveMcpServer(text(input.name, "server name", 64), mcpDefinition(input.definition), input.replace === true)); return;
    }
    if (path === "/api/v1/capabilities/mcp/servers/delete" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["name"], ["name"]);
      privateJson(response, await capabilityChanges.removeMcpServer(text(input.name, "server name", 64), await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/mcp/import" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["candidate", "claim"], ["candidate"]);
      privateJson(response, await capabilityChanges.importMcpServer(text(input.candidate, "candidate", 64), harnessList(input.claim), await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/mcp/claim" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["name", "harnessIds"], ["name", "harnessIds"]);
      privateJson(response, await capabilityChanges.claimMcpServer(text(input.name, "server name", 64), harnessList(input.harnessIds), await installedHarnesses())); return;
    }
    if ((path === "/api/v1/capabilities/mcp/sync" || path === "/api/v1/capabilities/mcp/remove") && method === "GET") {
      queries(url, ["name", "harnessId", "overwrite"]); const overwrite = url.searchParams.get("overwrite");
      if (overwrite !== null && overwrite !== "true" && overwrite !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected overwrite=true or overwrite=false");
      const name = text(url.searchParams.get("name"), "server name", 64), harnessId = text(url.searchParams.get("harnessId"), "Harness", 128);
      privateJson(response, path.endsWith("/sync") ? await capabilityChanges.checkMcpSync(name, harnessId, overwrite === "true", await installedHarnesses())
        : await capabilityChanges.checkMcpRemove(name, harnessId, await installedHarnesses())); return;
    }
    // The Hub's own tools (docs/decisions/LOG.md, 2026-11-11) in a Harness's user-level MCP configuration: where they stand, and one
    // request to install or remove them there, through the same check, backup and read-back as any server of the list.
    if (path === "/api/v1/capabilities/hub-tools" && method === "GET") { queries(url, []); privateJson(response, await capabilityChanges.hubTools(await installedHarnesses())); return; }
    if ((path === "/api/v1/capabilities/hub-tools/install" || path === "/api/v1/capabilities/hub-tools/uninstall") && method === "POST") {
      queries(url, []); const input = record(await body(request), ["harnessId"], ["harnessId"]), harnessId = text(input.harnessId, "Harness", 128);
      privateJson(response, path.endsWith("/install") ? await capabilityChanges.installHubTools(harnessId, await installedHarnesses()) : await capabilityChanges.uninstallHubTools(harnessId, await installedHarnesses())); return;
    }
    // HarnessHub's instructions (ADR-045 §6, step 4): saving the texts changes no Harness file; writing them into a Harness
    // goes through a check shown first and /changes.
    if (path === "/api/v1/capabilities/instructions" && method === "GET") { queries(url, []); privateJson(response, await capabilityChanges.instructionsView(await installedHarnesses())); return; }
    if (path === "/api/v1/capabilities/instructions" && method === "POST") {
      queries(url, []); const input = record(await body(request, CAPABILITY_BODY_BYTES), ["shared", "additions"], ["shared"]);
      privateJson(response, await capabilityChanges.saveInstructions(instructionText(input.shared), instructionAdditions(input.additions), await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/instructions/claim" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["harnessId"], ["harnessId"]);
      privateJson(response, await capabilityChanges.claimInstructions(text(input.harnessId, "Harness", 128), await installedHarnesses())); return;
    }
    if ((path === "/api/v1/capabilities/instructions/sync" || path === "/api/v1/capabilities/instructions/remove") && method === "GET") {
      queries(url, ["harnessId", "options"]); const harnessId = text(url.searchParams.get("harnessId"), "Harness", 128), options = instructionOptions(url.searchParams.get("options"));
      privateJson(response, path.endsWith("/sync") ? await capabilityChanges.checkInstructionsSync(harnessId, options, await installedHarnesses())
        : await capabilityChanges.checkInstructionsRemove(harnessId, options, await installedHarnesses())); return;
    }
    // HarnessHub's subagent list (ADR-045 §7, step 5): reading and editing the list change no Harness file; writing a
    // subagent into a Harness goes through a check shown first and /changes.
    if (path === "/api/v1/capabilities/subagents" && method === "GET") { queries(url, []); privateJson(response, await capabilityChanges.subagentInventory(await installedHarnesses())); return; }
    if (path === "/api/v1/capabilities/subagents/save" && method === "POST") {
      queries(url, []); const input = record(await body(request, CAPABILITY_BODY_BYTES), ["name", "definition", "replace"], ["name", "definition"]);
      if (input.replace !== undefined && typeof input.replace !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Expected replace to be a boolean");
      privateJson(response, await capabilityChanges.saveSubagent(text(input.name, "subagent name", 64), subagentDefinition(input.definition), input.replace === true)); return;
    }
    if (path === "/api/v1/capabilities/subagents/delete" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["name"], ["name"]);
      privateJson(response, await capabilityChanges.removeSubagent(text(input.name, "subagent name", 64), await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/subagents/claim" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["name", "harnessIds"], ["name", "harnessIds"]);
      privateJson(response, await capabilityChanges.claimSubagent(text(input.name, "subagent name", 64), harnessList(input.harnessIds), await installedHarnesses())); return;
    }
    if ((path === "/api/v1/capabilities/subagents/sync" || path === "/api/v1/capabilities/subagents/remove") && method === "GET") {
      queries(url, ["name", "harnessId", "overwrite"]); const overwrite = url.searchParams.get("overwrite");
      if (overwrite !== null && overwrite !== "true" && overwrite !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected overwrite=true or overwrite=false");
      const name = text(url.searchParams.get("name"), "subagent name", 64), harnessId = text(url.searchParams.get("harnessId"), "Harness", 128);
      privateJson(response, path.endsWith("/sync") ? await capabilityChanges.checkSubagentSync(name, harnessId, overwrite === "true", await installedHarnesses())
        : await capabilityChanges.checkSubagentRemove(name, harnessId, await installedHarnesses())); return;
    }
    // A switch setting HarnessHub wrote for a skill its Harness no longer has: cleared through the usual switch check.
    if (path.startsWith("/api/v1/capabilities/orphans/") && path.endsWith("/clear") && method === "GET") {
      queries(url, []); privateJson(response, await capabilityChanges.checkOrphanClear(decodeURIComponent(path.slice("/api/v1/capabilities/orphans/".length, -"/clear".length)), await installedHarnesses())); return;
    }
    // Placing shared skills (ADR-045 §4): Hermes reads the shared directory, Claude Code takes single skills by links, and the
    // links a Harness no longer needs can be removed; each check shows the change first, and a change of links can be undone.
    if (path === "/api/v1/capabilities/shared-dir" && method === "GET") {
      queries(url, ["harnessId", "present"]); const present = url.searchParams.get("present");
      if (present !== "true" && present !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected present=true or present=false");
      privateJson(response, await capabilityChanges.checkSharedDir({ harnessId: text(url.searchParams.get("harnessId"), "Harness", 128), present: present === "true" }, await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/skill-link" && method === "GET") {
      queries(url, ["harnessId", "name", "present"]); const present = url.searchParams.get("present");
      if (present !== "true" && present !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected present=true or present=false");
      privateJson(response, await capabilityChanges.checkSkillLink({ harnessId: text(url.searchParams.get("harnessId"), "Harness", 128), name: text(url.searchParams.get("name"), "skill name", 128), present: present === "true" },
        await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/link-cleanup" && method === "GET") {
      queries(url, ["harnessId"]);
      privateJson(response, await capabilityChanges.checkLinkCleanup({ harnessId: text(url.searchParams.get("harnessId"), "Harness", 128) }, await installedHarnesses())); return;
    }
    if (path.startsWith("/api/v1/capabilities/changes/") && path.endsWith("/undo") && method === "GET") {
      queries(url, []); privateJson(response, await capabilityChanges.checkUndo(decodeURIComponent(path.slice("/api/v1/capabilities/changes/".length, -"/undo".length)))); return;
    }
    // Turning one skill off or on in one Harness (ADR-045 §4): the check shows the exact change; nothing is written here.
    if (path === "/api/v1/capabilities/skill-switch" && method === "GET") {
      queries(url, ["harnessId", "name", "enabled", "via"]);
      const enabled = url.searchParams.get("enabled");
      if (enabled !== "true" && enabled !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected enabled=true or enabled=false");
      privateJson(response, await capabilityChanges.checkSkillSwitch({ harnessId: text(url.searchParams.get("harnessId"), "Harness", 128), name: text(url.searchParams.get("name"), "skill name", 128),
        enabled: enabled === "true", via: url.searchParams.has("via") ? text(url.searchParams.get("via"), "skill location", 4096) : null }, await installedHarnesses())); return;
    }
    // Turning a plugin off or on in Claude Code's or Codex's own file (ADR-045 step 6a), checked and shown first.
    if (path === "/api/v1/capabilities/plugin-switch" && method === "GET") {
      queries(url, ["harnessId", "id", "enabled"]);
      const enabled = url.searchParams.get("enabled");
      if (enabled !== "true" && enabled !== "false") throw new HttpError(400, "INVALID_INPUT", "Expected enabled=true or enabled=false");
      privateJson(response, await capabilityChanges.checkPluginSwitch({ harnessId: text(url.searchParams.get("harnessId"), "Harness", 128), id: text(url.searchParams.get("id"), "plugin id", 256),
        enabled: enabled === "true" }, await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/changes" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["fingerprint", "commandId"], ["fingerprint", "commandId"]);
      privateJson(response, await capabilityChanges.apply(text(input.fingerprint, "confirmation", 128), command(input.commandId))); return;
    }
    // The stored records come back with ~ already, one by one; the guard refuses only what is still absolute after that.
    if (path === "/api/v1/capabilities/history" && method === "GET") { queries(url, []); privateJson(response, await capabilityChanges.history()); return; }
    // What HarnessHub wrote that is no longer in place (ADR-045 §10): put back through its usual check, or no longer tracked.
    if (path.startsWith("/api/v1/capabilities/drift/") && path.endsWith("/reapply") && method === "GET") {
      queries(url, []); privateJson(response, await capabilityChanges.checkReapply(decodeURIComponent(path.slice("/api/v1/capabilities/drift/".length, -"/reapply".length)), await installedHarnesses())); return;
    }
    if (path === "/api/v1/capabilities/forget" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["id"], ["id"]);
      privateJson(response, await capabilityChanges.forget(text(input.id, "ledger entry", 64))); return;
    }
    if (path.startsWith("/api/v1/capabilities/backups/") && path.endsWith("/restore") && method === "GET") {
      queries(url, []); privateJson(response, await capabilityChanges.checkRestore(decodeURIComponent(path.slice("/api/v1/capabilities/backups/".length, -"/restore".length)))); return;
    }
    if (path === "/api/v1/capabilities/restores" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["fingerprint", "commandId"], ["fingerprint", "commandId"]);
      privateJson(response, await capabilityChanges.restore(text(input.fingerprint, "confirmation", 128), command(input.commandId))); return;
    }
    // Read-only: what the latest catalog reads and Runs showed; nothing is started.
    if (path === "/api/v1/harnesses/readiness" && method === "GET") { queries(url, []); json(response, 200, { readiness: readinessViews(nativeModels.readiness(), app.store.startupSamples(STARTUP_SAMPLES)) }); return; }
    if (path === "/api/v1/attachments" && method === "POST") {
      // Raw bytes, not JSON: the declared type is checked against the bytes and the upload is bound to this workspace.
      queries(url, ["name", "commandId"]);
      if (request.headers["content-encoding"] !== undefined) throw new HttpError(415, "INVALID_CONTENT_ENCODING", "Encoded uploads are unsupported");
      const length = request.headers["content-length"];
      if (length === undefined || !/^[0-9]{1,15}$/u.test(length)) throw new HttpError(411, "LENGTH_REQUIRED", "Attachment uploads need Content-Length");
      if (Number(length) < 1 || Number(length) > MAX_CONTENT_BYTES) throw new HttpError(413, "ATTACHMENT_LIMIT", "Attachments must contain 1 byte to 1 GiB");
      const ref = await app.content.stage({ workspace: options.configuration.workspace, name: url.searchParams.get("name") ?? "", mediaType: request.headers["content-type"] ?? "application/octet-stream",
        commandId: command(url.searchParams.get("commandId")), declaredBytes: Number(length), source: request });
      json(response, 201, ref); return;
    }
    const attachmentRoute = /^\/api\/v1\/attachments\/(content-[a-zA-Z0-9-]{1,96})$/u.exec(path);
    if (attachmentRoute && method === "DELETE") {
      queries(url, []); app.content.discard(attachmentRoute[1]!, options.configuration.workspace);
      if (!response.destroyed && !response.writableEnded) { headers(response); response.statusCode = 204; response.end(); }
      return;
    }
    const contentRoute = /^\/api\/v1\/content\/(content-[a-zA-Z0-9-]{1,96})$/u.exec(path);
    if (contentRoute && (method === "GET" || method === "HEAD")) {
      queries(url, ["download"]);
      const download = url.searchParams.get("download"); if (download !== null && download !== "1") throw new HttpError(400, "INVALID_INPUT", "invalid download flag");
      const item = app.content.read(contentRoute[1]!); await content(item.path, item.ref, response, method, download === "1"); return;
    }
    const permissionRoute = /^\/api\/v1\/sessions\/(session-[a-zA-Z0-9-]+)\/permissions\/(permission-[a-zA-Z0-9-]+)$/u.exec(path);
    const nativeBranch = /^\/api\/v1\/sessions\/(session-[a-zA-Z0-9-]+)\/native-branch$/u.exec(path);
    if (nativeBranch && method === "POST") {
      queries(url, []); const input = record(await body(request), ["epoch", "commandId"], ["epoch", "commandId"]);
      if (typeof input.epoch !== "number" || !Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new HttpError(400, "INVALID_INPUT", "invalid native branch epoch");
      json(response, 200, conversations!.session(app.runtime.resetNative(sessionId(nativeBranch[1]), text(input.commandId, "commandId", 128), input.epoch).id)); return;
    }
    if (permissionRoute && method === "POST") { queries(url, []); const input = record(await body(request, MAX_ANSWER_BODY_BYTES), ["optionId", "commandId", "input"], ["optionId", "commandId"]); const id = sessionId(permissionRoute[1]); json(response, 200, await app.runtime.decidePermission(id, permissionRoute[2]!, text(input.optionId, "optionId", 512), text(input.commandId, "commandId", 128), input.input===undefined?undefined:(typeof input.input==="string"&&!input.input.includes("\0")?input.input:(()=>{throw new HttpError(400,"INVALID_INPUT","invalid native UI input")})()))); return; }
    const nativeSessionsRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/native-sessions$/u.exec(path);
    if (nativeSessionsRoute && method === "GET") {
      queries(url, ["controlId", "workspace", "cursor", "probes"]);
      const controlId = url.searchParams.get("controlId"), workspace = url.searchParams.get("workspace"), after = url.searchParams.get("cursor"), probes = url.searchParams.get("probes");
      if (probes !== null && probes !== "include") throw new HttpError(400, "INVALID_INPUT", "Invalid native session filter");
      if (after !== null && (!after || Buffer.byteLength(after) > 1024 || /[\0-\x1f\x7f]/u.test(after))) throw new HttpError(400, "INVALID_INPUT", "Invalid native session cursor");
      const configuration = workspace === null ? options.configuration : await workspaceConfiguration(workspace);
      const selected = select({ harnessId: nativeSessionsRoute[1], ...(controlId === null ? {} : { controlId }) });
      let page: Awaited<ReturnType<typeof nativeModels.sessions>>;
      try { page = await nativeModels.sessions(selected, configuration, after ?? undefined); }
      catch (error) { const failure = importFailure(error); throw failure instanceof HttpError && failure.status === 502 ? new HttpError(502, failure.code, "无法读取这个 Harness 的本机会话。请检查它的登录和配置后重试。") : failure; }
      if (page === null) { const output: NativeSessionListView = { sessions: null, nextCursor: null }; json(response, 200, output); return; }
      // Sessions a conversation already continues (or the Hub created) open that conversation instead of a second holder.
      const validated = await app.factory.validate(selected, configuration), owners = app.store.nativeOwners(validated.harnessId, validated.controlId);
      // Sessions only a catalog read opened are left out unless asked for; one a conversation holds is never left out.
      const opened = probes === "include" ? new Set<string>() : nativeModels.probeSessions(validated.harnessId, validated.controlId);
      const shown = page.sessions.filter(row => owners.has(row.id) || !opened.has(row.id));
      const output: NativeSessionListView = { sessions: shown.map(row => ({ ...row, ...(owners.has(row.id) ? { conversationId: owners.get(row.id)! } : {}) })), nextCursor: page.nextCursor,
        ...(shown.length < page.sessions.length ? { hiddenProbes: page.sessions.length - shown.length } : {}) };
      json(response, 200, output); return;
    }
    const extensionsRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/extensions$/u.exec(path);
    if (extensionsRoute && method === "GET") {
      queries(url, ["controlId", "workspace"]);
      const controlId = url.searchParams.get("controlId"), workspace = url.searchParams.get("workspace");
      const configuration = workspace === null ? options.configuration : await prepareConfiguration({ workspace,
        ...(options.configuration.configHome === null ? {} : { configHome: options.configuration.configHome }),
        ...(options.configuration.manifestPath === null ? {} : { manifestPath: options.configuration.manifestPath }),
        packageRoots: options.configuration.packageRoots, searchDirs: searchDirs(), pathOnly: options.configuration.pathOnly });
      const selected = select({ harnessId: extensionsRoute[1], ...(controlId === null ? {} : { controlId }) });
      try { json(response, 200, { extensions: await nativeModels.extensions(selected, configuration) }); }
      catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "EXTENSION_DISCOVERY_FAILED";
        throw new HttpError(502, code, "无法读取这个 Harness 的本机扩展。请检查它的登录和配置后重试。");
      }
      return;
    }
    const modelsRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/models$/u.exec(path);
    if (modelsRoute && method === "GET") {
      queries(url, ["controlId", "workspace", "refresh", "nativeModel"]);
      const refresh = url.searchParams.get("refresh"); if (refresh !== null && refresh !== "1") throw new HttpError(400, "INVALID_INPUT", "invalid model refresh flag");
      const controlId = url.searchParams.get("controlId"), workspace = url.searchParams.get("workspace");
      const configuration = workspace === null ? options.configuration : await prepareConfiguration({ workspace,
        ...(options.configuration.configHome === null ? {} : { configHome: options.configuration.configHome }),
        ...(options.configuration.manifestPath === null ? {} : { manifestPath: options.configuration.manifestPath }),
        packageRoots: options.configuration.packageRoots, searchDirs: searchDirs(), pathOnly: options.configuration.pathOnly });
      const selected = select({ harnessId: modelsRoute[1], ...(controlId === null ? {} : { controlId }), ...(url.searchParams.get("nativeModel") === null ? {} : {nativeModel:url.searchParams.get("nativeModel")}) });
      // The Harness's adapter declaration goes with its catalog: the page draws the permission and thinking levels from it (contracts/flavor.ts).
      try { json(response, 200, { ...await nativeModels.read(selected, configuration, refresh === "1"), flavor: flavorOf(selected.harnessId) }); }
      catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "MODEL_DISCOVERY_FAILED";
        if (code === "GATEWAY_AUTH_REQUIRED" || code === "HARNESS_AUTH_REQUIRED" || code === "NATIVE_AUTH_REQUIRED") { json(response, 200, { models: [], defaultModel: null, authentication: "missing", canSelect: false, flavor: flavorOf(selected.harnessId) }); return; }
        throw new HttpError(502, code, "无法读取这个 Harness 的本机模型列表。请检查它的登录和配置后刷新。");
      }
      return;
    }
    const maintenanceRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/maintenance$/u.exec(path);
    if (maintenanceRoute && method === "GET") {
      queries(url, []); await rescan();
      const check = await app.management.maintenance(maintenanceRoute[1]!);
      const output: MaintenanceView = { ...check, conversations: check.conversations.map(item => {
        return { ...item, title: titleOf(item.sessionId) };
      }) };
      json(response, 200, output); return;
    }
    // What installing a missing product the official way would run and change (ADR-044); prepares the script copy, changes nothing.
    const installRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/install$/u.exec(path);
    if (installRoute && method === "GET") {
      queries(url, []); await rescan();
      const output: InstallCheckView = await app.management.installCheck(installRoute[1]!);
      if (homePathsIn(output, homeForms()).length) throw new HttpError(500, "PRIVACY_GUARD", "安装检查的结果含有未隐去的本机路径，已拦截。");
      json(response, 200, output); return;
    }
    // What uninstalling one installation would remove, stop and leave (ADR-044); reads only.
    const uninstallRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/installations\/([a-f0-9]{64})\/uninstall$/u.exec(path);
    if (uninstallRoute && method === "GET") {
      queries(url, []); await rescan();
      const check = await app.management.uninstallCheck(uninstallRoute[1]!, uninstallRoute[2]!);
      const output: UninstallCheckView = { ...check, conversations: check.conversations.map(item => {
        return { ...item, title: titleOf(item.sessionId) };
      }) };
      // The confirmation may name the removed program paths with ~ only; an absolute home path is refused, not sent (ADR-044).
      if (homePathsIn(output, homeForms()).length) throw new HttpError(500, "PRIVACY_GUARD", "卸载检查的结果含有未隐去的本机路径，已拦截。");
      json(response, 200, output); return;
    }
    // What upgrading one installation through its channel would run and change (ADR-044); prepares it, changes no installed program.
    const upgradeRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/installations\/([a-f0-9]{64})\/upgrade$/u.exec(path);
    if (upgradeRoute && method === "GET") {
      queries(url, []); await rescan();
      const check = await app.management.upgradeCheck(upgradeRoute[1]!, upgradeRoute[2]!);
      const output: InstallationUpgradeCheckView = { ...check, conversations: check.conversations.map(item => {
        return { ...item, title: titleOf(item.sessionId) };
      }) };
      if (homePathsIn(output, homeForms()).length) throw new HttpError(500, "PRIVACY_GUARD", "升级检查的结果含有未隐去的本机路径，已拦截。");
      json(response, 200, output); return;
    }
    // The one full scan a client asks for (ADR-050): it joins a scan already running, or with `after` (an ISO time of this
    // Gateway's clock, such as a task's end) answers once a scan that began then or later has ended.
    if (path === "/api/v1/harnesses/rescan" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["after"]);
      if (input.after === undefined) { json(response, 200, await rescan()); return; }
      await scanAfter(isoTime(input.after, "scan time")); json(response, 200, harnesses); return;
    }
    if (path === "/api/v1/harnesses/check-updates" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["harnessIds"]);
      let ids: readonly string[] | undefined;
      if (input.harnessIds !== undefined) {
        if (!Array.isArray(input.harnessIds) || input.harnessIds.length > 128 || input.harnessIds.some(value => typeof value !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value)) || new Set(input.harnessIds).size !== input.harnessIds.length)
          throw new HttpError(400, "INVALID_INPUT", "Expected a bounded unique list of Harness identities");
        ids = input.harnessIds.map(value => text(value, "Harness identity", 96));
      }
      await app.management.checkUpdates(ids); json(response, 200, await rescan()); return;
    }
    if (path === "/api/v1/installation-jobs") {
      if (method === "GET") { queries(url, ["limit"]); json(response, 200, app.management.listJobs().slice(0, cursor(url.searchParams.get("limit"), 50, 1, 100))); return; }
      if (method === "POST") {
        queries(url, []); const input = record(await body(request), ["harnessId", "controlId", "action", "commandId", "expectedDefaultRevision", "expectedNativeFingerprint", "restartServices", "installation", "expectedInstallationFingerprint", "stopServices", "expectedInstallFingerprint", "backupConfirmed"], ["harnessId", "action", "commandId"]);
        if (input.action !== "install" && input.action !== "upgrade" && input.action !== "uninstall") throw new HttpError(400, "INVALID_INPUT", "Expected install, upgrade or uninstall action");
        await rescan();
        // Every consent field reaches the management parser, which refuses the ones that do not belong to the action (ADR-043, ADR-044, ADR-052).
        const consent = { ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: input.expectedNativeFingerprint }), ...(input.restartServices === undefined ? {} : { restartServices: input.restartServices }),
          ...(input.backupConfirmed === undefined ? {} : { backupConfirmed: input.backupConfirmed }) };
        if (input.action === "install" && input.expectedInstallFingerprint !== undefined) {
          json(response, 202, app.management.submitOfficialInstall({ harnessId: text(input.harnessId, "Harness identity", 96), action: "install", commandId: command(input.commandId), expectedInstallFingerprint: input.expectedInstallFingerprint,
            ...(input.controlId === undefined ? {} : { controlId: input.controlId }), ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: input.expectedDefaultRevision }), ...consent })); return;
        }
        if (input.action === "upgrade" && input.installation !== undefined) {
          json(response, 202, await app.management.submitInstallationUpgrade({ harnessId: text(input.harnessId, "Harness identity", 96), action: "upgrade", commandId: command(input.commandId),
            installation: input.installation, ...(input.expectedInstallationFingerprint === undefined ? {} : { expectedInstallationFingerprint: input.expectedInstallationFingerprint }),
            ...(input.stopServices === undefined ? {} : { stopServices: input.stopServices }), ...(input.controlId === undefined ? {} : { controlId: input.controlId }),
            ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: input.expectedDefaultRevision }), ...consent })); return;
        }
        if (input.action === "uninstall") {
          json(response, 202, await app.management.submitUninstall({ harnessId: text(input.harnessId, "Harness identity", 96), action: "uninstall", commandId: command(input.commandId),
            installation: input.installation, expectedInstallationFingerprint: input.expectedInstallationFingerprint, ...(input.stopServices === undefined ? {} : { stopServices: input.stopServices }),
            ...(input.controlId === undefined ? {} : { controlId: input.controlId }), ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: input.expectedDefaultRevision }), ...consent })); return;
        }
        json(response, 202, app.management.submit({ harnessId: text(input.harnessId, "Harness identity", 96), action: input.action, commandId: command(input.commandId),
          ...(input.controlId === undefined ? {} : { controlId: text(input.controlId, "control identity", 96) }),
          ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: integer(input.expectedDefaultRevision, 0, Number.MAX_SAFE_INTEGER, "default revision") }),
          ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: text(input.expectedNativeFingerprint, "native fingerprint", 64) }),
          ...(input.restartServices === undefined ? {} : { restartServices: input.restartServices }), ...(input.backupConfirmed === undefined ? {} : { backupConfirmed: input.backupConfirmed }) })); return;
      }
    }
    const jobRoute = /^\/api\/v1\/installation-jobs\/([^/]+)(?:\/(logs|cancel|inspect))?$/u.exec(path);
    if (jobRoute) {
      const id = jobRoute[1]!, action = jobRoute[2];
      if (action === undefined && method === "GET") {
        queries(url, []); const job = app.management.readJob(id);
        // A task's end, read here, is when the Gateway looks at this computer again (ADR-050): the management service
        // offers no completion callback, and a client that waited for the task through its record then reads what it left.
        if (settled(job.status)) await scanAfter(job.updatedAt);
        json(response, 200, job); return;
      }
      if (action === "logs" && method === "GET") {
        queries(url, ["afterSeq", "limit"]);
        const after = cursor(url.searchParams.get("afterSeq"), 0, 0, Number.MAX_SAFE_INTEGER), entries = app.management.logs(id, after, cursor(url.searchParams.get("limit"), 50, 1, 100));
        const nextSeq = entries.at(-1)?.seq ?? after;
        const output: InstallationLogPage = { entries, nextSeq, hasMore: app.management.readJob(id).logCursor > nextSeq }; json(response, 200, output); return;
      }
      if (action === "cancel" && method === "POST") { queries(url, []); const input = record(await body(request), ["commandId"], ["commandId"]); json(response, 202, app.management.cancel(id, command(input.commandId))); return; }
      if (action === "inspect" && method === "POST") { queries(url, []); record(await body(request), []); json(response, 200, await app.management.inspectNativeResult(id)); return; }
    }
    if (path === "/api/v1/providers") {
      queries(url, []);
      if (method === "GET") { json(response, 200, app.providers.list()); return; }
      if (method === "POST") { const input = record(await body(request), ["input", "commandId"], ["input", "commandId"]); json(response, 201, app.providers.create(input.input, command(input.commandId))); return; }
    }
    const providerRoute = /^\/api\/v1\/providers\/([^/]+)(\/probe)?$/u.exec(path);
    if (providerRoute) {
      queries(url, []); const id = providerRoute[1]!;
      if (method === "PATCH" && providerRoute[2] === undefined) {
        const input = record(await body(request), ["input", "expectedRevision", "commandId"], ["input", "expectedRevision", "commandId"]);
        json(response, 200, app.providers.update(id, input.input, integer(input.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "expected revision"), command(input.commandId))); return;
      }
      if (method === "POST" && providerRoute[2] === "/probe") { record(await body(request), []); json(response, 200, await app.providers.probe(id)); return; }
    }
    if (path === "/api/v1/workspaces/choose" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["start"]);
      const closed = new AbortController(), gone = () => { if (!response.writableEnded) closed.abort(); };
      response.once("close", gone);
      try { json(response, 200, { path: await chooseFolder({ prompt: "选择项目文件夹", start: input.start === undefined ? undefined : text(input.start, "start"), signal: closed.signal }) }); }
      catch (error) { if (error instanceof FolderDialogUnavailable) throw new HttpError(501, "FOLDER_DIALOG_UNAVAILABLE", "这台电脑上打不开系统的文件夹选择框"); throw error; }
      finally { response.off("close", gone); }
      return;
    }
    if (path === "/api/v1/sessions/import" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["workspace", "selection", "nativeId", "commandId"], ["selection", "nativeId", "commandId"]);
      const configuration = input.workspace === undefined ? options.configuration : await workspaceConfiguration(text(input.workspace, "workspace"));
      try { json(response, 201, conversations!.session((await app.runtime.importNative(configuration, select(input.selection), text(input.nativeId, "native session", 1024), command(input.commandId))).id)); }
      catch (error) { throw importFailure(error); }
      return;
    }
    if (path === "/api/v1/sessions") {
      if (method === "GET") { queries(url, ["after", "limit"]); json(response, 200, conversations!.sessions({ after: url.searchParams.get("after") ?? undefined, limit: url.searchParams.get("limit") ?? undefined })); return; }
      if (method === "POST") {
        queries(url, []); const input = record(await body(request), ["workspace", "scratch", "selection", "commandId"], ["selection", "commandId"]);
        if (input.scratch !== undefined && (input.scratch !== true || input.workspace !== undefined)) throw new HttpError(400, "INVALID_INPUT", "Invalid scratch");
        // Started without a folder (2026-11-13): the conversation gets one of its own, named by this request so a repeat names the same one.
        const configuration = input.scratch === true ? await workspaceConfiguration(await scratchFolder(scratchRoot, command(input.commandId)))
          : input.workspace === undefined ? options.configuration : await workspaceConfiguration(text(input.workspace, "workspace"));
        json(response, 201, conversations!.session((await app.runtime.create(configuration, select(input.selection), command(input.commandId))).id)); return;
      }
    }
    const streamRoute = /^\/api\/v1\/sessions\/([^/]+)\/events\/stream$/u.exec(path);
    if (streamRoute && method === "GET") {
      queries(url, ["afterSeq"]);
      const queryCursor = url.searchParams.get("afterSeq"), headerCursor = request.headers["last-event-id"];
      if (headerCursor !== undefined && typeof headerCursor !== "string") throw new HttpError(400, "INVALID_INPUT", "Invalid Last-Event-ID");
      if (queryCursor !== null && headerCursor !== undefined && queryCursor !== headerCursor) throw new HttpError(400, "INVALID_INPUT", "Conflicting session stream cursors");
      const after = cursor(queryCursor ?? headerCursor ?? null, 0, 0, Number.MAX_SAFE_INTEGER);
      streams.open(sessionId(streamRoute[1]!), after, login.expires, response, () => {
        headers(response); response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache, no-transform"); response.setHeader("Connection", "keep-alive"); response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders();
      });
      return;
    }
    // Approvals and questions waiting in any conversation (ADR-035): the current list, then live frames of it.
    if (path === "/api/v1/attention" && method === "GET") { queries(url, []); json(response, 200, attention.frame()); return; }
    if (path === "/api/v1/attention/stream" && method === "GET") {
      queries(url, []);
      attention.open(login.expires, response, () => {
        headers(response); response.statusCode = 200; response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache, no-transform"); response.setHeader("Connection", "keep-alive"); response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders();
      });
      return;
    }
    // Which conversations keep a native process and in which workspace, for the choice when one occupies a workspace (ADR-030).
    if (path === "/api/v1/kept-processes" && method === "GET") { queries(url, []); json(response, 200, { processes: app.runtime.keptProcesses() }); return; }
    // One Turn's diagnostics, assembled on request and never kept (ADR-037). Private text is scrubbed here, not in the page.
    const diagnosticsRoute = /^\/api\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/diagnostics$/u.exec(path);
    if (diagnosticsRoute && method === "GET") {
      queries(url, ["content"]); const content = url.searchParams.get("content");
      if (content !== null && content !== "0" && content !== "1") throw new HttpError(400, "INVALID_INPUT", "content must be 0 or 1");
      // A conversation that is not there, or was deleted, is not found; the Turn is read from its rows, and the conversation's words only when a log is checked against them.
      const id = sessionId(diagnosticsRoute[1]!); app.store.get(id);
      const turns = turnSource(app.store, id);
      let ordinal: number | null = null; try { ordinal = turns.ordinalOf(runId(diagnosticsRoute[2]!)); } catch { ordinal = null; }
      const turn = ordinal === null ? null : turns.turn(ordinal);
      if (turn === null) throw new HttpError(404, "RUN_NOT_FOUND", "this conversation has no such Turn");
      const run = turn.run, events: SessionEvent[] = []; let after = 0, complete = true;
      for (let page = 0; ; page++) {
        const batch = app.store.events(id, after, 100);
        for (const event of batch) if (event.data.runId === run.id) events.push(event);
        if (batch.length < 100) break;
        if (page >= 200) { complete = false; break; }
        after = batch.at(-1)!.seq;
      }
      const harness = harnesses.find(item => item.id === run.selection.harnessId), includeContent = content === "1";
      let user: string | null = null; try { user = userInfo().username; } catch { user = null; }
      const kept = app.runtime.runDiagnostics(id, run.id);
      const text = turnDiagnostics({ turn, turns: turns.count, messages: () => messageStarts(app.store, id), events, eventsComplete: complete, stderr: kept === null ? null : { text: kept.stderr, truncated: kept.truncated },
        harness: harness === undefined ? null : { name: harness.name, programVersion: harness.management.programVersion, installedVersion: harness.management.installedVersion },
        build: revision, runtime: { node: process.version, platform: process.platform, release: release(), arch: process.arch }, now: new Date(), includeContent,
        scrub: value => scrubDiagnostics(value, { redact: text => app.providers.redact(text), user }) });
      json(response, 200, { text, includesContent: includeContent }); return;
    }
    // The relay's reads and preferences (ADR-055 §12.4): a conversation's bindings and packets, a packet's stored text, and the
    // installation's relay preferences. A write here has passed the same Origin and CSRF checks as every other.
    if (await relayApi.handle(request, response, url, method)) return;
    // A conversation kept as rows is read in pages (ADR-057 3.4): its head and newest Turns, the Turns before a cursor, a Turn's items from a place on, one item whole, a byte range of an
    // item's text, and the changes of the whole conversation. Each read is of one moment; a conversation that was deleted is not found by any of them.
    const turnsRoute = /^\/api\/v1\/sessions\/([^/]+)\/turns$/u.exec(path);
    if (turnsRoute && method === "GET") { queries(url, ["before", "limit"]); json(response, 200, conversations!.turns(turnsRoute[1]!, { before: url.searchParams.get("before") ?? undefined, limit: url.searchParams.get("limit") ?? undefined })); return; }
    const itemsRoute = /^\/api\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/items$/u.exec(path);
    if (itemsRoute && method === "GET") { queries(url, ["after", "limit"]); json(response, 200, conversations!.runItems(itemsRoute[1]!, itemsRoute[2]!, { after: url.searchParams.get("after") ?? undefined, limit: url.searchParams.get("limit") ?? undefined })); return; }
    const itemRoute = /^\/api\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/items\/([^/]+)$/u.exec(path);
    if (itemRoute && method === "GET") { queries(url, []); json(response, 200, conversations!.item(itemRoute[1]!, itemRoute[2]!, itemRoute[3]!)); return; }
    const textRoute = /^\/api\/v1\/sessions\/([^/]+)\/runs\/([^/]+)\/items\/([^/]+)\/text$/u.exec(path);
    if (textRoute && method === "GET") { queries(url, ["from", "to"]); json(response, 200, conversations!.itemText(textRoute[1]!, textRoute[2]!, textRoute[3]!, { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined })); return; }
    const changesRoute = /^\/api\/v1\/sessions\/([^/]+)\/changes$/u.exec(path);
    if (changesRoute && method === "GET") { queries(url, ["before", "limit"]); json(response, 200, conversations!.changes(changesRoute[1]!, { before: url.searchParams.get("before") ?? undefined, limit: url.searchParams.get("limit") ?? undefined })); return; }
    const sessionRoute = /^\/api\/v1\/sessions\/([^/]+)(?:\/(messages|switches|resume|cancel|close|events|export|fork|branch|delegate|retention|end-process|native-resume))?$/u.exec(path);
    if (sessionRoute) {
      const id = sessionId(sessionRoute[1]!), action = sessionRoute[2];
      if (action === undefined && method === "GET") { queries(url, []); json(response, 200, conversations!.session(id)); return; }
      if (action === "export" && method === "GET") {
        // A download of the public conversation; private native state and stored bytes stay out.
        queries(url, ["format"]); const format = url.searchParams.get("format") ?? "markdown";
        if (format !== "markdown" && format !== "json") throw new HttpError(400, "INVALID_INPUT", "export format must be markdown or json");
        // Written a Turn at a time, straight into the response: an export is as long as the conversation, and nothing but the Turn being written is held (src/web/conversation-export.ts).
        // The JSON is the conversation as it is stored (the Runs as they were kept, with the relay's reading of each in); the Markdown is worded from the Turns as the page words them.
        // A conversation that is not there is found out before anything is sent; a failure after that ends the connection.
        const head = conversations!.head(id), now = new Date();
        const pieces = format === "json" ? exportJson(rowsJsonExport(app.store, head, app.store.get(id).switches, runRelay.of(id)), now) : exportMarkdown(rowsExport(app.store, id, conversations!.turnView(id)), now);
        if (response.destroyed || response.writableEnded) return;
        await sendPieces(response, pieces, () => {
          headers(response); response.statusCode = 200;
          response.setHeader("Content-Type", format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8");
          response.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent("harnesshub-" + id + (format === "json" ? ".json" : ".md")));
        });
        return;
      }
      // How to continue the current native session in the Harness's own program (ADR-039); read on demand, never exported.
      if (action === "native-resume" && method === "GET") {
        queries(url, []); const snapshot = app.store.get(id), selection = snapshot.selection;
        // A binding that opens a new native session (opensNew) names the one it gave up: there is none to continue yet.
        const binding = selection.provider === undefined ? snapshot.nativeBindings?.find(item => item.harnessId === selection.harnessId && item.controlId === selection.controlId && item.status === "ready" && item.opensNew !== true) : undefined;
        // The commands do not depend on the installed version, so this read scans nothing (ADR-050 item 30 as ADR-053 changed it).
        // Whether the workspace is a Git repository decides one program's flag; it is only looked at.
        const git = binding === undefined ? false : await stat(join(snapshot.configuration.workspace, ".git")).then(() => true, () => false);
        json(response, 200, { resume: binding === undefined ? null : nativeResume(selection.harnessId, binding.checkpoint, { git }) }); return;
      }
      if (action === "events" && method === "GET") {
        queries(url, ["afterSeq", "limit"]); const after = cursor(url.searchParams.get("afterSeq"), 0, 0, Number.MAX_SAFE_INTEGER), limit = cursor(url.searchParams.get("limit"), 50, 1, 100);
        const events = app.store.events(id, after, limit).map(item => relayApi.publicEvent(item)), nextSeq = events.at(-1)?.seq ?? after;
        const output: EventPage = { events, nextSeq, hasMore: app.store.head(id).lastSeq > nextSeq }; json(response, 200, output); return;
      }
      if (method === "POST") {
        queries(url, []);
        if (action === "messages") {
          const input = record(await body(request, MAX_MESSAGE_BODY_BYTES), ["text", "commandId", "attachments", "relay", "branchFrom"], ["text", "commandId"]); if (typeof input.text !== "string") throw new HttpError(400, "INVALID_INPUT", "Message text required");
          if (input.branchFrom !== undefined && typeof input.branchFrom !== "string") throw new HttpError(400, "INVALID_INPUT", "Invalid branch point");
          if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.some(value => typeof value !== "string"))) throw new HttpError(400, "INVALID_INPUT", "Invalid attachments");
          // The user's relay choice (ADR-055 §12.4), checked before the Runtime sees it: it goes with the input, and so into the
          // command's fingerprint. The relay never refuses an input.
          const relay = parseSendRelay(input.relay);
          // `branchFrom`: the message goes from the place of that Turn (its message edited and sent again, or its reply tried again), on a branch of its own.
          json(response, 202, app.runtime.send(id, input.text, command(input.commandId), (input.attachments ?? []) as string[], relay.choices, input.branchFrom as string | undefined));
          return;
        }
        // A part of the work goes to a Harness of its own (2026-11-13): a conversation that starts from this one's history, with the task as its first message.
        if (action === "delegate") {
          const input = record(await body(request, MAX_MESSAGE_BODY_BYTES), ["selection", "text", "commandId", "messageCommandId"], ["selection", "text", "commandId", "messageCommandId"]);
          if (typeof input.text !== "string" || !input.text.trim()) throw new HttpError(400, "INVALID_INPUT", "Message text required");
          const child = await app.runtime.delegate(id, select(input.selection), command(input.commandId));
          // A repeat of the request finds the conversation it made, and the task already in it.
          if (child.runs.length === 0) app.runtime.send(child.id, input.text, command(input.messageCommandId), [], undefined, undefined);
          json(response, 201, conversations!.session(child.id)); return;
        }
        // Another branch of the conversation becomes its path (the alternative of a Turn: `runId`); nothing runs.
        if (action === "branch") { const input = record(await body(request), ["runId", "commandId"], ["runId", "commandId"]); json(response, 200, conversations!.session(app.runtime.selectBranch(id, text(input.runId, "Run identity", 160), command(input.commandId)).id)); return; }
        if (action === "switches") { const input = record(await body(request), ["selection", "commandId"], ["selection", "commandId"]); json(response, 202, app.runtime.switch(id, select(input.selection), command(input.commandId))); return; }
        if (action === "fork") {
          const input = record(await body(request), ["commandId", "throughRunId"], ["commandId"]);
          if (input.throughRunId !== undefined && typeof input.throughRunId !== "string") throw new HttpError(400, "INVALID_INPUT", "Invalid branch point");
          const branch = app.runtime.fork(id, command(input.commandId), input.throughRunId as string | undefined);
          json(response, 201, conversations!.session(branch.id)); return;
        }
        if (action === "resume") {
          const input = record(await body(request), ["selection", "commandId", "acknowledgeUnknown"], ["selection", "commandId"]);
          if (input.acknowledgeUnknown !== undefined && typeof input.acknowledgeUnknown !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Invalid unknown-result acknowledgement");
          json(response, 202, app.runtime.resume(id, select(input.selection), command(input.commandId), input.acknowledgeUnknown === true)); return;
        }
        if (action === "cancel") { const input = record(await body(request), ["runId", "commandId"], ["commandId"]); json(response, 202, app.runtime.cancel(id, command(input.commandId), input.runId === undefined ? undefined : text(input.runId, "Run identity", 128))); return; }
        if (action === "close") { const input = record(await body(request), ["commandId"], ["commandId"]); json(response, 200, conversations!.session((await app.runtime.closeSession(id, command(input.commandId))).id)); return; }
        if (action === "retention") {
          const input = record(await body(request), ["enabled", "commandId"], ["enabled", "commandId"]);
          if (typeof input.enabled !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Expected whether to keep the native process");
          json(response, 200, conversations!.session(app.runtime.setRetention(id, input.enabled, command(input.commandId)).id)); return;
        }
        // Ends the kept process with the normal stop chain; answers once its close is recorded.
        if (action === "end-process") { const input = record(await body(request), ["commandId"], ["commandId"]); json(response, 200, conversations!.session((await app.runtime.endKept(id, command(input.commandId))).id)); return; }
      }
    }
    throw new HttpError(404, "NOT_FOUND", "API route not found");
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    // A disconnected client is independent of the durable command it may already have submitted.
    response.on("error", () => {});
    watchIdle(request, options.requestIdleMs ?? REQUEST_IDLE_MS);
    if (running >= MAX_REQUESTS) { json(response, 429, { code: "CLIENT_LIMIT", message: "Too many concurrent requests" }); request.resume(); return; }
    running++;
    void route(request, response).catch(error => {
      const fault = publicFailure(error, homeForms());
      json(response, fault.status, { code: fault.code, message: app.providers.redact(fault.message) }); request.resume();
    }).finally(() => { running--; });
  });
  // The time a request takes to arrive is not limited (an upload takes as long as its bytes do, watchIdle ends one that falls silent); its headers must come within ten seconds.
  server.headersTimeout = 10000; server.requestTimeout = 0; server.keepAliveTimeout = 5000; server.maxConnections = MAX_CONNECTIONS;
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopping = true; table.listening(null); table.toolsIn(null);
    streams.close(); attention.close();
    closing = (async () => {
      const listener = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      // Bound even sockets that have not completed their headers; durable execution is closed separately.
      const deadline = setTimeout(() => server.closeAllConnections(), 12000); deadline.unref();
      server.closeIdleConnections();
      let failure: unknown = streams.readFailure?.error ?? streams.diagnosticFailure;
      try { await app.runtime.close(); } catch (error) { failure = error; }
      try { await nativeModels.close(); } catch (error) { failure ??= error; }
      try { await listener; } catch (error) { failure ??= error; } finally { clearTimeout(deadline); }
      try { await app.management.shutdown(); } catch (error) { failure ??= error; }
      try { await app.providers.shutdown(); } catch (error) { failure ??= error; }
      try { await capabilityChanges.close(); } catch (error) { failure ??= error; }
      try { app.store.close(); } catch (error) { failure ??= error; }
      logins.clear();
      if (failure) throw failure;
    })();
    return closing;
  };
  try {
    // Processes conversations kept under a service that ended without closing them are ended (or left quarantined) first.
    const left = app.store.listKept().length;
    if (left > 0) process.stderr.write("HarnessGateway: ending " + left + " native process(es) kept by the previous service (up to about 6 s each)\n");
    const reaped = await app.runtime.reapKept();
    if (reaped.length > 0) {
      const count = (outcome: string) => reaped.filter(item => item.outcome === outcome).length;
      process.stderr.write("HarnessGateway: kept native processes of the previous service: " + count("terminated") + " ended, " + count("gone") + " already gone, "
        + count("unconfirmed") + " unconfirmed (workspace quarantined)\n");
    }
    await rescan();
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Local listener unavailable");
    host = "127.0.0.1:" + address.port; origin = "http://" + host;
    // A native process this Hub starts is told it has the Hub's tools only when its Harness's configuration holds the entry. Answered from the
    // last completed scan, not a new one: starting a process must not start a discovery.
    table.toolsIn(harnessId => capabilityChanges.hubToolsInstalled(harnessId, installedIn(harnesses)));
    table.listening(origin);
    return { url: origin + "/#token=" + bootstrap, close };
  } catch (error) {
    streams.close(); attention.close();
    await nativeModels.close();
    try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { try { await capabilityChanges.close(); } finally { app.store.close(); } } } }
    throw error;
  }
}
