import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { release, userInfo } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { application as composeApplication } from "../cli/session-application.js";
import { ProviderError } from "../contracts/provider.js";
import { ManagementError } from "../contracts/management.js";
import { SessionError, parseNativeOptions, sessionId, type SelectionRequest, type SessionConfiguration, type SessionEvent, type SessionSnapshot } from "../contracts/session.js";
import { MAX_CONTENT_BYTES, MAX_RUN_ATTACHMENTS } from "../contracts/content.js";
import type { EventPage, HarnessReadinessView, HarnessView, InstallationLogPage, InstallationUpgradeCheckView, KeptProcessView, MaintenanceView, NativeSessionListView, SessionSummary, SessionView, UninstallCheckView, InstallCheckView, WebState } from "../contracts/web.js";
import { inventory, officialInstallation } from "../infrastructure/catalog/inventory-composition.js";
import type { InstallationPolicy } from "../contexts/catalog/domain/catalog.js";
import { harnessEntry, productCommand } from "./harness-entry.js";
import { installationObservations, installationViews, unofficialView } from "./harness-installations.js";
import { homePathsIn } from "./shown-paths.js";
import { officialInstallMethod } from "../adapters/catalog-channels.js";
import { harnessTier } from "../adapters/catalog.js";
import type { InstallationJobView } from "../contracts/management.js";
import { prepareConfiguration } from "../infrastructure/session/binding-factory.js";
import { supportedProviderProtocols } from "../contexts/provider/domain/provider.js";
import { carriedNativeConfiguration } from "../contexts/session/domain/state.js";
import { observedPackageVersion } from "../infrastructure/management/system-version.js";
import { SessionStreamError, SessionStreamHub } from "./session-stream.js";
import { AttentionStreamHub } from "./attention-stream.js";
import { HarnessModels } from "./harness-models.js";
import { buildRevision, NativeCatalogCache, type NativeReadiness } from "./native-catalog-cache.js";
import { conversationMarkdown } from "./conversation-export.js";
import { runDiagnostics, scrubDiagnostics } from "./run-diagnostics.js";
import { nativeResume } from "../infrastructure/management/verified-versions.js";
import { LoginShellStore, readLoginShellPath, type LoginShellDirectories } from "../infrastructure/discovery/login-shell.js";
import { CapabilityService } from "../infrastructure/capabilities/service.js";
import { CapabilityChanges, homeText } from "../infrastructure/capabilities/changes.js";
import { CapabilityError, INSTRUCTION_CHECK_OPTIONS, type InstructionCheckOption, type McpDefinitionView } from "../contracts/capabilities.js";
import type { GithubFetch } from "../infrastructure/capabilities/github.js";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 16;
const COOKIE_NAME = "harnessgateway_session";
const BOOTSTRAP_MS = 10 * 60 * 1000;
const LOGIN_MS = 8 * 60 * 60 * 1000;
interface Login { readonly csrf: string; readonly expires: number }
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface WebServerOptions {
  readonly providerManagement?: boolean;
  readonly root: string;
  readonly configuration: SessionConfiguration;
  readonly port?: number;
  readonly assetsDirectory?: string;
  readonly application?: typeof composeApplication;
  /** The Turn budgets (ADR-036), resolved by `resolveTurnBudgets`; the defaults otherwise. */
  readonly budgets?: { readonly executionBudgetMs: number; readonly waitBudgetMs: number };
  /**
   * The login shell the user may ask to read PATH from (G(ii)) and the system's shell list; absent or false: not offered
   * (CI, sandboxes and tests that do not name a fixture shell).
   */
  readonly loginShell?: { readonly shell: string | null; readonly shells: string } | false;
  /** The workspace lock namespace (`resolveWorkspaceLockRoot`) when this server composes its own application; the default otherwise. */
  readonly workspaceLockRoot?: string;
  /** What counts as an installation (ADR-044) when this server composes its own application; the composition's default otherwise. */
  readonly installations?: InstallationPolicy;
  /** Fetches from GitHub without following redirects, for adding and updating skills (ADR-045 §4); the platform's `fetch` by default. */
  readonly github?: GithubFetch;
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
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024) throw new HttpError(400, "INVALID_INPUT", "Expected an instructions text");
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
  if (typeof input.description !== "string" || typeof input.prompt !== "string" || Buffer.byteLength(input.description, "utf8") > 8192 || Buffer.byteLength(input.prompt, "utf8") > 64 * 1024)
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
  // Only the Chinese web font comes from elsewhere (ADR-042): its stylesheet from Google Fonts, its files from gstatic.
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_RESPONSE_BYTES) throw new HttpError(413, "RESPONSE_LIMIT", "Response exceeds its byte budget");
  headers(response); response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Content-Length", bytes.length);
  response.end(bytes);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if ((request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new HttpError(415, "INVALID_CONTENT_TYPE", "JSON request body required");
  if (request.headers["content-encoding"] !== undefined) throw new HttpError(415, "INVALID_CONTENT_ENCODING", "Encoded request bodies are unsupported");
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) throw new HttpError(413, "BODY_LIMIT", "Request body exceeds 128 KiB");
  const chunks: Buffer[] = []; let length = 0;
  const timer = setTimeout(() => request.destroy(new HttpError(408, "BODY_TIMEOUT", "Request body timed out")), 10000);
  timer.unref();
  try {
    for await (const chunk of request) {
      if (!(chunk instanceof Buffer)) throw new HttpError(400, "INVALID_INPUT", "Invalid request bytes");
      length += chunk.length;
      if (length > MAX_BODY_BYTES) throw new HttpError(413, "BODY_LIMIT", "Request body exceeds 128 KiB");
      chunks.push(chunk);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown; }
    catch { throw new HttpError(400, "INVALID_JSON", "Request body must be valid UTF-8 JSON"); }
  } finally { clearTimeout(timer); }
}
/** How many of an entry's latest Runs set its usual startup time. */
const STARTUP_SAMPLES = 5;
/**
 * Each Harness entry's latest catalog read, with its usual startup: the median time from starting the program to its open
 * native session over its latest Runs in these Sessions. An entry with Runs but no read is unchecked.
 */
function readinessViews(observed: readonly NativeReadiness[], snapshots: readonly SessionSnapshot[]): HarnessReadinessView[] {
  const samples = new Map<string, { readonly at: number; readonly ms: number }[]>();
  for (const snapshot of snapshots) for (const run of snapshot.runs) {
    const timing = run.timing;
    // A Turn on a kept process did not start the program, so it says nothing about startup (ADR-030).
    if (run.reused === true || timing?.preparingAt === undefined || timing.readyAt === undefined || timing.readyAt < timing.preparingAt) continue;
    const key = run.selection.harnessId + "\0" + run.selection.controlId;
    samples.set(key, [...samples.get(key) ?? [], { at: timing.preparingAt, ms: timing.readyAt - timing.preparingAt }]);
  }
  const startup = (key: string) => {
    const latest = [...samples.get(key) ?? []].sort((a, b) => b.at - a.at).slice(0, STARTUP_SAMPLES).map(sample => sample.ms).sort((a, b) => a - b);
    return latest.length ? { startupMs: latest[Math.floor(latest.length / 2)]! } : {};
  };
  const views: HarnessReadinessView[] = observed.map(item => ({ harnessId: item.harnessId, controlId: item.controlId, state: item.state, checkedAt: item.checkedAt,
    ...(item.signedIn === undefined ? {} : { signedIn: item.signedIn }), ...(item.failureCode === undefined ? {} : { failureCode: item.failureCode }), ...startup(item.harnessId + "\0" + item.controlId) }));
  for (const key of samples.keys()) {
    const [harnessId, controlId] = key.split("\0") as [string, string];
    if (!views.some(view => view.harnessId === harnessId && view.controlId === controlId)) views.push({ harnessId, controlId, state: "unchecked", checkedAt: null, ...startup(key) });
  }
  return views;
}
function summary(snapshot: SessionSnapshot): SessionSummary {
  const first = snapshot.messages.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim();
  // A branch or a continued native session without its own input yet is named after where it came from.
  const quoted = snapshot.origin?.history.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim();
  const inherited = snapshot.origin?.kind === "import" ? "接续 · " + (snapshot.origin.title ?? quoted ?? snapshot.origin.harnessId) : quoted ? "分支 · " + quoted : null;
  return { id: snapshot.id, title: first ? first.slice(0, 80) : inherited ? inherited.slice(0, 80) : "新对话", status: snapshot.status, workspace: snapshot.configuration.workspace,
    selection: snapshot.selection, updatedSeq: snapshot.lastSeq, activeRunId: snapshot.activeRunId };
}
function view(snapshot: SessionSnapshot, permissions: SessionView["permissions"] = [], kept: KeptProcessView | null = null, lost: NonNullable<SessionView["retention"]>["lost"] | null = null,
  queue: SessionView["queue"] | null = null, busyHolders: SessionView["busyHolders"] = {}, outside: NonNullable<SessionView["retention"]>["outside"] | null = null,
  upgraded: NonNullable<SessionView["retention"]>["upgraded"] | null = null): SessionView {
  return { id: snapshot.id, version: snapshot.version, lastSeq: snapshot.lastSeq, epoch: snapshot.epoch, status: snapshot.status,
    workspace: snapshot.configuration.workspace, selection: snapshot.selection, activeRunId: snapshot.activeRunId, pendingSwitchId: snapshot.pendingSwitchId,
    permissions, nativeStates: snapshot.nativeBindings?.flatMap(binding => {
      if (binding.status === "archived") return [];
      const carried = binding.harnessId === snapshot.selection.harnessId && binding.controlId === snapshot.selection.controlId ? carriedNativeConfiguration(snapshot, snapshot.selection, snapshot.epoch) : null;
      return [{ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status === "fork-pending" || binding.status === "forking" ? "forking" as const : binding.status,
        ...(binding.observed === undefined ? {} : { observed: binding.observed }), ...(carried === null ? {} : { carried }) }];
    }) ?? [],
    ...(snapshot.origin === undefined ? {} : { origin: snapshot.origin }), ...(queue === null ? {} : { queue }), ...(Object.keys(busyHolders).length ? { busyHolders } : {}),
    ...(snapshot.schemaVersion < 11 ? {} : { retention: { enabled: snapshot.retainNative === true, process: kept, ...(lost === null ? {} : { lost }), ...(outside === null ? {} : { outside }), ...(upgraded === null ? {} : { upgraded }) } }), messages: snapshot.messages, runs: snapshot.runs, switches: snapshot.switches };
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
    const status = code.includes("NOT_FOUND") ? 404 : code === "INVALID_INPUT" ? 400 : code.includes("LIMIT") || code === "QUEUE_FULL" ? 429
      : code.startsWith("RECOVERY_") || code.includes("UNAVAILABLE") || code.includes("CLOSED") || code.includes("BLOCKED") || code.includes("CONFLICT") || code.includes("PENDING") || code.includes("REVISION") || code.includes("UNSUPPORTED") || code.includes("BUSY") || code.includes("ACTIVE") || code === "STALE_DEFAULT" || code.endsWith("_CHANGED") || code.includes("REFUSED") || code.endsWith("_EXPIRED") || code.includes("INCOMPATIBLE") ? 409 : 502;
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
  // A Turn waits for its workspace or, when every slot is taken, for a slot (ADR-036).
  const queueOf = (id: SessionSnapshot["id"]): NonNullable<SessionView["queue"]> | null => {
    const workspace = app.runtime.queueState(id), slot = workspace === null ? app.runtime.slotWait(id) : null;
    return workspace !== null ? { kind: "workspace", ...workspace } : slot !== null ? { kind: "slot", ...slot } : null;
  };
  // A conversation's view with the live state of the native process it keeps (ADR-030).
  const sessionView = (snapshot: SessionSnapshot, permissions: SessionView["permissions"] = []): SessionView => view(snapshot, permissions, app.runtime.keptProcess(snapshot.id), app.runtime.keptLoss(snapshot.id),
    queueOf(snapshot.id), Object.fromEntries(snapshot.runs.flatMap(run => { const holder = app.runtime.busyHolderOf(run.id); return holder === null ? [] : [[run.id, holder]]; })),
    app.runtime.keptOutside(snapshot.id), app.runtime.keptUpgrade(snapshot.id));
  const streams = new SessionStreamHub(id => sessionView(app.runtime.read(id), app.runtime.permissionRequests(id)), {}, failure => {
    const fault = publicFailure(failure.error, homeForms());
    process.stderr.write("HarnessGateway: SESSION_STREAM_READ_FAILED (" + app.providers.redact(fault.code).slice(0, 128) + ")\n");
  }, () => attention.frame());
  // Waiting approvals and questions of every conversation, refreshed after each published event (ADR-035). A page with a
  // conversation open gets them on that conversation's stream; a page without one subscribes to them alone.
  const attention = new AttentionStreamHub(() => app.runtime.attention(), {}, frame => streams.attentionChanged(frame));
  app = (options.application ?? ((root, publish) => composeApplication(root, publish, { ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.workspaceLockRoot === undefined ? {} : { workspaceLockRoot: options.workspaceLockRoot }),
    ...(options.installations === undefined ? {} : { installations: options.installations }) })))(options.root, event => {
    try { streams.publish(event); } finally { if (app !== undefined) attention.changed(); }
  });
  // This build: every compiled Gateway file by name and content (ADR-033), also named in a Turn's diagnostics (ADR-037).
  const revision = buildRevision(fileURLToPath(new URL("..", import.meta.url)));
  // Derived observations only; a file this version cannot adopt is reported and left as it is. Catalogs are reused only by
  // the build that read them (every compiled Gateway file), since its drivers decide what a catalog contains.
  const nativeModels = new HarnessModels(app.factory, new NativeCatalogCache(realpathSync(options.root), { assertOwner: () => app.store.assertOwner(),
    report: problem => process.stderr.write("HarnessGateway: NATIVE_CATALOG_CACHE_UNAVAILABLE (" + problem + ")\n"), revision }));
  // Directories the user took from the login shell's PATH (G(ii)) extend discovery and new conversations until removed.
  const loginShells = new LoginShellStore(realpathSync(options.root));
  // What each installed Harness reads besides its model (ADR-045 step 1), from the user's own files; read-only.
  const capabilities = new CapabilityService(app.factory.discoveryEnvironment);
  let loginDirs: LoginShellDirectories | null = await loginShells.load();
  const searchDirs = (): readonly string[] => [...options.configuration.searchDirs, ...(loginDirs?.dirs ?? []).filter(dir => !options.configuration.searchDirs.includes(dir))];
  const loginShellView = () => ({ available: options.loginShell !== undefined && options.loginShell !== false && options.loginShell.shell !== null,
    ...(options.loginShell && options.loginShell.shell !== null ? { shell: basename(options.loginShell.shell) } : {}), dirs: loginDirs?.dirs ?? [], readAt: loginDirs?.readAt ?? null });
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
    environment: app.factory.discoveryEnvironment, homes: homeForms(), ...(options.github === undefined ? {} : { github: options.github }) });
  /**
   * The installed Harnesses a capability read or change covers: each one's official installation the Gateway uses, as a
   * scan at this request finds them (these reads and checks are the user's own requests; ADR-050 leaves them as they were).
   */
  const installedHarnesses = async () => (await rescan()).flatMap(harness => {
    const products = harness.installations.filter(item => item.role === "product"), chosen = products.find(item => item.active) ?? products[0];
    return chosen ? [{ harnessId: harness.id, name: harness.name, version: chosen.version }] : [];
  });
  /** Answers with a capability value only when it names no path by its absolute home form (ADR-044's privacy guard). */
  const privateJson = (response: ServerResponse, value: unknown) => {
    if (homePathsIn(value, homeForms(), 1 << 20).length) throw new HttpError(500, "PRIVACY_GUARD", "a capability answer named a path by its absolute home form");
    json(response, 200, value);
  };
  let origin = "", host = "", running = 0, stopping = false, closing: Promise<void> | null = null;
  const bootstrap = randomBytes(32).toString("hex"), bootstrapExpires = Date.now() + BOOTSTRAP_MS;
  let bootstrapAvailable = true;
  const logins = new Map<string, Login>();
  // The last completed scan of this computer's Harnesses and when it began (ADR-050). Reading the state shows these and
  // never scans. A scan runs at startup, on the user's request, after the login shell's directories change, before a
  // management task is checked or accepted, after an update check, and once a task's end has been read.
  let harnesses: readonly HarnessView[] = [];
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
      if (scannedAt === "" || Date.parse(startedAt) >= Date.parse(scannedAt)) { harnesses = views; scannedAt = startedAt; }
      return views;
    });
    const running = { startedAt, done: pending };
    scan = running;
    void pending.then(() => { if (scan === running) scan = null; }, () => { if (scan === running) scan = null; });
    return pending;
  };
  const authenticated = (request: IncomingMessage): Login => {
    const token = cookie(request), login = token === null ? undefined : logins.get(token);
    if (!login || login.expires < Date.now()) { if (token !== null) logins.delete(token); throw new HttpError(401, "AUTH_REQUIRED", "Open the Gateway startup link to connect"); }
    return login;
  };
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (stopping) throw new HttpError(503, "GATEWAY_STOPPING", "Gateway is stopping");
    if (request.headers.host !== host) throw new HttpError(403, "HOST_REJECTED", "Invalid local Host");
    const receivedOrigin = request.headers.origin;
    if (receivedOrigin !== undefined && receivedOrigin !== origin) throw new HttpError(403, "ORIGIN_REJECTED", "Cross-origin request rejected");
    if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "ORIGIN_REJECTED", "Cross-site request rejected");
    if (!request.url || !request.url.startsWith("/") || request.url.startsWith("//") || request.url.length > 4096 || /%(?:2f|5c|00)|\\/iu.test(request.url.split("?", 1)[0]!)) throw new HttpError(400, "INVALID_PATH", "Invalid request path");
    const url = new URL(request.url, origin), path = url.pathname, method = request.method ?? "GET";
    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      queries(url, []); await asset(assets, path, response, method); return;
    }
    const write = method !== "GET" && method !== "HEAD";
    if (write && receivedOrigin !== origin) throw new HttpError(403, "ORIGIN_REQUIRED", "Same-origin write required");
    if (path === "/api/v1/auth/bootstrap") {
      if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST required");
      queries(url, []);
      const value = record(await body(request), ["token"], ["token"]), token = text(value.token, "startup token", 128);
      if (!bootstrapAvailable || Date.now() > bootstrapExpires || !equal(token, bootstrap)) throw new HttpError(401, "AUTH_REQUIRED", "Startup link expired or already used");
      bootstrapAvailable = false;
      const loginId = randomBytes(32).toString("hex"), csrf = randomBytes(32).toString("hex");
      logins.set(loginId, { csrf, expires: Date.now() + LOGIN_MS });
      response.setHeader("Set-Cookie", COOKIE_NAME + "=" + loginId + "; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=" + LOGIN_MS / 1000);
      json(response, 200, { csrfToken: csrf }); return;
    }
    const login = authenticated(request);
    if (write && (typeof request.headers["x-csrf-token"] !== "string" || !equal(request.headers["x-csrf-token"], login.csrf))) throw new HttpError(403, "CSRF_REJECTED", "Invalid write token");
    if (path === "/api/v1/auth/session" && method === "GET") { queries(url, []); json(response, 200, { csrfToken: login.csrf }); return; }
    // Both answer with the last completed scan (ADR-050): reading them starts no discovery, and a scan still running is
    // not waited for. The startup scan ends before the listener opens, so there always is one.
    if (path === "/api/v1/state" && method === "GET") {
      queries(url, []); const snapshots = app.store.list(100);
      const output: WebState = { providerManagement: options.providerManagement ?? true, workspace: options.configuration.workspace, providers: app.providers.list(), harnesses, harnessesScannedAt: scannedAt,
        sessions: snapshots.map(summary), jobs: app.management.listJobs().slice(0, 50), readiness: readinessViews(nativeModels.readiness(), snapshots), installationPolicy: app.factory.installations };
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
      queries(url, []); const input = record(await body(request), ["name", "description", "body", "overwrite"], ["name", "description", "body"]);
      if (typeof input.description !== "string" || typeof input.body !== "string" || Buffer.byteLength(input.description, "utf8") > 8192 || Buffer.byteLength(input.body, "utf8") > 64 * 1024)
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
    // HarnessHub's instructions (ADR-045 §6, step 4): saving the texts changes no Harness file; writing them into a Harness
    // goes through a check shown first and /changes.
    if (path === "/api/v1/capabilities/instructions" && method === "GET") { queries(url, []); privateJson(response, await capabilityChanges.instructionsView(await installedHarnesses())); return; }
    if (path === "/api/v1/capabilities/instructions" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["shared", "additions"], ["shared"]);
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
      queries(url, []); const input = record(await body(request), ["name", "definition", "replace"], ["name", "definition"]);
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
    if (path === "/api/v1/harnesses/readiness" && method === "GET") { queries(url, []); json(response, 200, { readiness: readinessViews(nativeModels.readiness(), app.store.list(100)) }); return; }
    if (path === "/api/v1/attachments" && method === "POST") {
      // Raw bytes, not JSON: the declared type is checked against the bytes and the upload is bound to this workspace.
      queries(url, ["name", "commandId"]);
      if (request.headers["content-encoding"] !== undefined) throw new HttpError(415, "INVALID_CONTENT_ENCODING", "Encoded uploads are unsupported");
      const length = request.headers["content-length"];
      if (length === undefined || !/^[0-9]{1,9}$/u.test(length)) throw new HttpError(411, "LENGTH_REQUIRED", "Attachment uploads need Content-Length");
      if (Number(length) < 1 || Number(length) > MAX_CONTENT_BYTES) throw new HttpError(413, "ATTACHMENT_LIMIT", "Attachments must contain 1 byte to 20 MiB");
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
      json(response, 200, sessionView(app.runtime.resetNative(sessionId(nativeBranch[1]), text(input.commandId, "commandId", 128), input.epoch))); return;
    }
    if (permissionRoute && method === "POST") { queries(url, []); const input = record(await body(request), ["optionId", "commandId", "input"], ["optionId", "commandId"]); const id = sessionId(permissionRoute[1]); json(response, 200, await app.runtime.decidePermission(id, permissionRoute[2]!, text(input.optionId, "optionId", 512), text(input.commandId, "commandId", 128), input.input===undefined?undefined:(typeof input.input==="string"&&Buffer.byteLength(input.input)<=65536&&!input.input.includes("\0")?input.input:(()=>{throw new HttpError(400,"INVALID_INPUT","invalid native UI input")})()))); return; }
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
      try { json(response, 200, await nativeModels.read(selected, configuration, refresh === "1")); }
      catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "MODEL_DISCOVERY_FAILED";
        if (code === "GATEWAY_AUTH_REQUIRED" || code === "HARNESS_AUTH_REQUIRED" || code === "NATIVE_AUTH_REQUIRED") { json(response, 200, { models: [], defaultModel: null, authentication: "missing", canSelect: false }); return; }
        throw new HttpError(502, code, "无法读取这个 Harness 的本机模型列表。请检查它的登录和配置后刷新。");
      }
      return;
    }
    const maintenanceRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/maintenance$/u.exec(path);
    if (maintenanceRoute && method === "GET") {
      queries(url, []); await rescan();
      const check = await app.management.maintenance(maintenanceRoute[1]!);
      const output: MaintenanceView = { ...check, conversations: check.conversations.map(item => {
        let title = "对话";
        try { title = summary(app.runtime.read(sessionId(item.sessionId))).title; } catch { /* a conversation closed meanwhile keeps the generic name */ }
        return { ...item, title };
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
        let title = "对话";
        try { title = summary(app.runtime.read(sessionId(item.sessionId))).title; } catch { /* a conversation closed meanwhile keeps the generic name */ }
        return { ...item, title };
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
        let title = "对话";
        try { title = summary(app.runtime.read(sessionId(item.sessionId))).title; } catch { /* a conversation closed meanwhile keeps the generic name */ }
        return { ...item, title };
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
        queries(url, []); const input = record(await body(request), ["harnessId", "controlId", "action", "commandId", "expectedDefaultRevision", "expectedNativeFingerprint", "restartServices", "installation", "expectedInstallationFingerprint", "stopServices", "expectedInstallFingerprint"], ["harnessId", "action", "commandId"]);
        if (input.action !== "install" && input.action !== "upgrade" && input.action !== "uninstall") throw new HttpError(400, "INVALID_INPUT", "Expected install, upgrade or uninstall action");
        await rescan();
        if (input.action === "install" && input.expectedInstallFingerprint !== undefined) {
          json(response, 202, app.management.submitOfficialInstall({ harnessId: text(input.harnessId, "Harness identity", 96), action: "install", commandId: command(input.commandId), expectedInstallFingerprint: input.expectedInstallFingerprint,
            ...(input.controlId === undefined ? {} : { controlId: input.controlId }), ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: input.expectedDefaultRevision }),
            ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: input.expectedNativeFingerprint }), ...(input.restartServices === undefined ? {} : { restartServices: input.restartServices }) })); return;
        }
        if (input.action === "upgrade" && input.installation !== undefined) {
          json(response, 202, await app.management.submitInstallationUpgrade({ harnessId: text(input.harnessId, "Harness identity", 96), action: "upgrade", commandId: command(input.commandId),
            installation: input.installation, ...(input.expectedInstallationFingerprint === undefined ? {} : { expectedInstallationFingerprint: input.expectedInstallationFingerprint }),
            ...(input.stopServices === undefined ? {} : { stopServices: input.stopServices }), ...(input.controlId === undefined ? {} : { controlId: input.controlId }),
            ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: input.expectedDefaultRevision }),
            ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: input.expectedNativeFingerprint }), ...(input.restartServices === undefined ? {} : { restartServices: input.restartServices }) })); return;
        }
        if (input.action === "uninstall") {
          json(response, 202, await app.management.submitUninstall({ harnessId: text(input.harnessId, "Harness identity", 96), action: "uninstall", commandId: command(input.commandId),
            installation: input.installation, expectedInstallationFingerprint: input.expectedInstallationFingerprint, ...(input.stopServices === undefined ? {} : { stopServices: input.stopServices }),
            ...(input.controlId === undefined ? {} : { controlId: input.controlId }), ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: input.expectedDefaultRevision }),
            ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: input.expectedNativeFingerprint }), ...(input.restartServices === undefined ? {} : { restartServices: input.restartServices }) })); return;
        }
        json(response, 202, app.management.submit({ harnessId: text(input.harnessId, "Harness identity", 96), action: input.action, commandId: command(input.commandId),
          ...(input.controlId === undefined ? {} : { controlId: text(input.controlId, "control identity", 96) }),
          ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: integer(input.expectedDefaultRevision, 0, Number.MAX_SAFE_INTEGER, "default revision") }),
          ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: text(input.expectedNativeFingerprint, "native fingerprint", 64) }),
          ...(input.restartServices === undefined ? {} : { restartServices: input.restartServices }) })); return;
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
    if (path === "/api/v1/sessions/import" && method === "POST") {
      queries(url, []); const input = record(await body(request), ["workspace", "selection", "nativeId", "commandId"], ["selection", "nativeId", "commandId"]);
      const configuration = input.workspace === undefined ? options.configuration : await workspaceConfiguration(text(input.workspace, "workspace"));
      try { json(response, 201, sessionView(await app.runtime.importNative(configuration, select(input.selection), text(input.nativeId, "native session", 1024), command(input.commandId)))); }
      catch (error) { throw importFailure(error); }
      return;
    }
    if (path === "/api/v1/sessions") {
      if (method === "GET") { queries(url, ["limit"]); json(response, 200, app.store.list(cursor(url.searchParams.get("limit"), 100, 1, 100)).map(summary)); return; }
      if (method === "POST") {
        queries(url, []); const input = record(await body(request), ["workspace", "selection", "commandId"], ["selection", "commandId"]);
        const configuration = input.workspace === undefined ? options.configuration : await prepareConfiguration({ workspace: text(input.workspace, "workspace"),
          ...(options.configuration.manifestPath === null ? {} : { manifestPath: options.configuration.manifestPath }),
          ...(options.configuration.configHome === null ? {} : { configHome: options.configuration.configHome }),
          packageRoots: options.configuration.packageRoots, searchDirs: searchDirs(), pathOnly: options.configuration.pathOnly });
        json(response, 201, sessionView(await app.runtime.create(configuration, select(input.selection), command(input.commandId)))); return;
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
      const id = sessionId(diagnosticsRoute[1]!), snapshot = app.runtime.read(id), run = snapshot.runs.find(item => item.id === diagnosticsRoute[2]);
      if (run === undefined) throw new HttpError(404, "RUN_NOT_FOUND", "this conversation has no such Turn");
      const events: SessionEvent[] = []; let after = 0, complete = true;
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
      const text = runDiagnostics({ session: snapshot, run, events, eventsComplete: complete, stderr: kept === null ? null : { text: kept.stderr, truncated: kept.truncated },
        harness: harness === undefined ? null : { name: harness.name, programVersion: harness.management.programVersion, installedVersion: harness.management.installedVersion },
        build: revision, runtime: { node: process.version, platform: process.platform, release: release(), arch: process.arch }, now: new Date(), includeContent,
        scrub: value => scrubDiagnostics(value, { redact: text => app.providers.redact(text), user }) });
      json(response, 200, { text, includesContent: includeContent }); return;
    }
    const sessionRoute = /^\/api\/v1\/sessions\/([^/]+)(?:\/(messages|switches|resume|cancel|close|events|export|fork|retention|end-process|native-resume))?$/u.exec(path);
    if (sessionRoute) {
      const id = sessionId(sessionRoute[1]!), action = sessionRoute[2];
      if (action === undefined && method === "GET") { queries(url, []); json(response, 200, sessionView(app.runtime.read(id), app.runtime.permissionRequests(id))); return; }
      if (action === "export" && method === "GET") {
        // A download of the public conversation; private native state and stored bytes stay out.
        queries(url, ["format"]); const format = url.searchParams.get("format") ?? "markdown";
        if (format !== "markdown" && format !== "json") throw new HttpError(400, "INVALID_INPUT", "export format must be markdown or json");
        // Names come from the catalog, the same in every scan: the last one is enough.
        const current = sessionView(app.runtime.read(id)), now = new Date(), names = new Map(harnesses.map(harness => [harness.id, harness.name]));
        const bytes = Buffer.from(format === "json" ? JSON.stringify({ application: "HarnessHub", exportedAt: now.toISOString(), session: current }, null, 2) + "\n" : conversationMarkdown(current, harnessId => names.get(harnessId) ?? harnessId, now));
        if (bytes.length > MAX_RESPONSE_BYTES) throw new HttpError(413, "RESPONSE_LIMIT", "Conversation export exceeds its byte budget");
        if (response.destroyed || response.writableEnded) return;
        headers(response); response.statusCode = 200;
        response.setHeader("Content-Type", format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8"); response.setHeader("Content-Length", bytes.length);
        response.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent("harnesshub-" + id + (format === "json" ? ".json" : ".md")));
        response.end(bytes); return;
      }
      // How to continue the current native session in the Harness's own program (ADR-039); read on demand, never exported.
      if (action === "native-resume" && method === "GET") {
        queries(url, []); const snapshot = app.runtime.read(id), selection = snapshot.selection;
        const binding = selection.provider === undefined ? snapshot.nativeBindings?.find(item => item.harnessId === selection.harnessId && item.controlId === selection.controlId && item.status === "ready") : undefined;
        // A command to run is only given for the version installed now, so this read scans like a management check (ADR-050).
        const verification = binding === undefined ? null : (await rescan()).find(harness => harness.id === selection.harnessId)?.management.verification ?? null;
        // Whether the workspace is a Git repository decides one program's flag; it is only looked at.
        const git = binding === undefined ? false : await stat(join(snapshot.configuration.workspace, ".git")).then(() => true, () => false);
        json(response, 200, { resume: binding === undefined ? null : nativeResume(selection.harnessId, binding.checkpoint, verification, { git }) }); return;
      }
      if (action === "events" && method === "GET") {
        queries(url, ["afterSeq", "limit"]); const after = cursor(url.searchParams.get("afterSeq"), 0, 0, Number.MAX_SAFE_INTEGER), limit = cursor(url.searchParams.get("limit"), 50, 1, 100);
        const events = app.store.events(id, after, limit), nextSeq = events.at(-1)?.seq ?? after;
        const output: EventPage = { events, nextSeq, hasMore: app.runtime.read(id).lastSeq > nextSeq }; json(response, 200, output); return;
      }
      if (method === "POST") {
        queries(url, []);
        if (action === "messages") {
          const input = record(await body(request), ["text", "commandId", "attachments"], ["text", "commandId"]); if (typeof input.text !== "string") throw new HttpError(400, "INVALID_INPUT", "Message text required");
          if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > MAX_RUN_ATTACHMENTS || input.attachments.some(value => typeof value !== "string"))) throw new HttpError(400, "INVALID_INPUT", "Invalid attachments");
          json(response, 202, app.runtime.send(id, input.text, command(input.commandId), (input.attachments ?? []) as string[])); return;
        }
        if (action === "switches") { const input = record(await body(request), ["selection", "commandId"], ["selection", "commandId"]); json(response, 202, app.runtime.switch(id, select(input.selection), command(input.commandId))); return; }
        if (action === "fork") {
          const input = record(await body(request), ["commandId", "throughRunId"], ["commandId"]);
          if (input.throughRunId !== undefined && typeof input.throughRunId !== "string") throw new HttpError(400, "INVALID_INPUT", "Invalid branch point");
          const branch = app.runtime.fork(id, command(input.commandId), input.throughRunId as string | undefined);
          json(response, 201, sessionView(branch, app.runtime.permissionRequests(branch.id))); return;
        }
        if (action === "resume") {
          const input = record(await body(request), ["selection", "commandId", "acknowledgeUnknown"], ["selection", "commandId"]);
          if (input.acknowledgeUnknown !== undefined && typeof input.acknowledgeUnknown !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Invalid unknown-result acknowledgement");
          json(response, 202, app.runtime.resume(id, select(input.selection), command(input.commandId), input.acknowledgeUnknown === true)); return;
        }
        if (action === "cancel") { const input = record(await body(request), ["runId", "commandId"], ["commandId"]); json(response, 202, app.runtime.cancel(id, command(input.commandId), input.runId === undefined ? undefined : text(input.runId, "Run identity", 128))); return; }
        if (action === "close") { const input = record(await body(request), ["commandId"], ["commandId"]); json(response, 200, sessionView(await app.runtime.closeSession(id, command(input.commandId)))); return; }
        if (action === "retention") {
          const input = record(await body(request), ["enabled", "commandId"], ["enabled", "commandId"]);
          if (typeof input.enabled !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Expected whether to keep the native process");
          json(response, 200, sessionView(app.runtime.setRetention(id, input.enabled, command(input.commandId)), app.runtime.permissionRequests(id))); return;
        }
        // Ends the kept process with the normal stop chain; answers once its close is recorded.
        if (action === "end-process") { const input = record(await body(request), ["commandId"], ["commandId"]); json(response, 200, sessionView(await app.runtime.endKept(id, command(input.commandId)), app.runtime.permissionRequests(id))); return; }
      }
    }
    throw new HttpError(404, "NOT_FOUND", "API route not found");
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    // A disconnected client is independent of the durable command it may already have submitted.
    response.on("error", () => {});
    if (running >= MAX_REQUESTS) { json(response, 429, { code: "CLIENT_LIMIT", message: "Too many concurrent requests" }); request.resume(); return; }
    running++;
    void route(request, response).catch(error => {
      const fault = publicFailure(error, homeForms());
      json(response, fault.status, { code: fault.code, message: app.providers.redact(fault.message) }); request.resume();
    }).finally(() => { running--; });
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000; server.maxConnections = 32;
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
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
    return { url: origin + "/#token=" + bootstrap, close };
  } catch (error) {
    streams.close(); attention.close();
    await nativeModels.close();
    try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { try { await capabilityChanges.close(); } finally { app.store.close(); } } } }
    throw error;
  }
}
