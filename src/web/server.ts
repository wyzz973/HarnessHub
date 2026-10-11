import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { application as composeApplication } from "../cli/session-application.js";
import { ProviderError } from "../contracts/provider.js";
import { ManagementError } from "../contracts/management.js";
import { SessionError, parseNativeOptions, sessionId, type SelectionRequest, type SessionConfiguration, type SessionSnapshot } from "../contracts/session.js";
import type { EventPage, HarnessView, InstallationLogPage, SessionSummary, SessionView, WebState } from "../contracts/web.js";
import { inventory } from "../infrastructure/catalog/inventory-composition.js";
import { prepareConfiguration } from "../infrastructure/session/binding-factory.js";
import { supportedProviderProtocols } from "../contexts/provider/domain/provider.js";
import { observedPackageVersion } from "../infrastructure/management/system-version.js";
import { SessionStreamError, SessionStreamHub } from "./session-stream.js";
import { HarnessModels } from "./harness-models.js";

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
}
export interface WebServer { readonly url: string; close(): Promise<void> }
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
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
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
function summary(snapshot: SessionSnapshot): SessionSummary {
  const first = snapshot.messages.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim();
  return { id: snapshot.id, title: first ? first.slice(0, 80) : "新对话", status: snapshot.status, workspace: snapshot.configuration.workspace,
    selection: snapshot.selection, updatedSeq: snapshot.lastSeq, activeRunId: snapshot.activeRunId };
}
function view(snapshot: SessionSnapshot, permissions: SessionView["permissions"] = []): SessionView {
  return { id: snapshot.id, version: snapshot.version, lastSeq: snapshot.lastSeq, epoch: snapshot.epoch, status: snapshot.status,
    workspace: snapshot.configuration.workspace, selection: snapshot.selection, activeRunId: snapshot.activeRunId, pendingSwitchId: snapshot.pendingSwitchId,
    permissions, nativeStates: snapshot.nativeBindings?.flatMap(binding => binding.status === "archived" ? [] : [{ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status }]) ?? [], messages: snapshot.messages, runs: snapshot.runs, switches: snapshot.switches };
}
function publicFailure(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  if (error instanceof HttpError || error instanceof SessionStreamError) return error;
  if (error instanceof SessionError || error instanceof ProviderError || error instanceof ManagementError) {
    const code = error.code;
    const status = code.includes("NOT_FOUND") ? 404 : code === "INVALID_INPUT" ? 400 : code.includes("LIMIT") || code === "QUEUE_FULL" ? 429
      : code.startsWith("RECOVERY_") || code.includes("UNAVAILABLE") || code.includes("CLOSED") || code.includes("BLOCKED") || code.includes("CONFLICT") || code.includes("PENDING") || code.includes("REVISION") || code.includes("UNSUPPORTED") || code.includes("BUSY") || code.includes("ACTIVE") || code === "STALE_DEFAULT" || code === "DEFAULT_CHANGED" ? 409 : 502;
    return { status, code, message: error.message.slice(0, 512) };
  }
  return { status: 500, code: "GATEWAY_FAILED", message: "Gateway operation failed" };
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
  const streams = new SessionStreamHub(id => view(app.runtime.read(id), app.runtime.permissionRequests(id)), {}, failure => {
    const fault = publicFailure(failure.error);
    process.stderr.write("HarnessGateway: SESSION_STREAM_READ_FAILED (" + app.providers.redact(fault.code).slice(0, 128) + ")\n");
  });
  app = (options.application ?? composeApplication)(options.root, event => streams.publish(event));
  const nativeModels = new HarnessModels(app.factory);
  let origin = "", host = "", running = 0, stopping = false, closing: Promise<void> | null = null;
  const bootstrap = randomBytes(32).toString("hex"), bootstrapExpires = Date.now() + BOOTSTRAP_MS;
  let bootstrapAvailable = true;
  const logins = new Map<string, Login>();
  let harnesses: readonly HarnessView[] = [];
  let scan: Promise<readonly HarnessView[]> | null = null;
  const rescan = (): Promise<readonly HarnessView[]> => {
    if (scan) return scan;
    const pending = inventory({ ...(options.configuration.manifestPath === null ? {} : { manifest: options.configuration.manifestPath }),
      environment: app.factory.discoveryEnvironment.values, home: app.factory.discoveryEnvironment.home,
      searchDirs: options.configuration.searchDirs, packageRoots: options.configuration.packageRoots, pathOnly: options.configuration.pathOnly,
      managedResolver: app.management }).then(async observed => {
      app.management.setSystemObservations(observed.report.harnesses.flatMap(harness => harness.controls.flatMap(control => {
        if (control.state !== "candidate" || control.command === null || observed.managedBindings.has(control.id)) return [];
        const packageVersion = observedPackageVersion(control.diagnostics);
        return [{ harnessId: harness.id, controlId: control.id, command: control.command, ...(packageVersion === undefined ? {} : { packageVersion }) }];
      })));
      await app.management.refreshSystemVersions();
      await app.management.refreshNativeCapabilities();
      const management = new Map(app.management.views(observed.report.harnesses.map(item => item.id)).map(item => [item.harnessId, item]));
      harnesses = observed.report.harnesses.map(item => {
        const managed = management.get(item.id);
        if (!managed) throw new HttpError(503, "MANAGEMENT_UNAVAILABLE", "Harness management observation is unavailable");
        const installed = item.installation.candidates.length > 0 || item.controls.some(control => control.state === "candidate");
        const available = item.controls.filter(control => control.state === "candidate" && (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc"));
        const managedControls = available.filter(control => observed.managedBindings.has(control.id));
        const defaultControlId = managedControls.length === 1 ? managedControls[0]!.id : managedControls.length === 0 && available.length === 1 ? available[0]!.id : null;
        return { id: item.id, name: item.name, installed, defaultControlId,
        controls: item.controls.map(control => ({ id: control.id, protocol: control.protocol, available: control.state === "candidate" && (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc"),
          reason: control.state === "candidate" ? (control.protocol === "acp-v1" || control.protocol === "codex-app-server" || control.protocol === "pi-rpc" ? null : "Control Driver is not implemented") : control.missingDependencies.length ? "Missing: " + control.missingDependencies.join(", ") : "Control entry unavailable" })),
        providerProtocols: item.controls.some(control => control.state === "candidate" && ((item.id === "codex" && control.protocol === "codex-app-server") || (item.id === "gemini" && control.protocol === "acp-v1"))) ? supportedProviderProtocols(item.id) : [],
        management: { ...managed, source: managed.source === "managed" ? "managed" : installed ? "system" : "missing" } };
      });
      return harnesses;
    });
    scan = pending;
    void pending.then(() => { if (scan === pending) scan = null; }, () => { if (scan === pending) scan = null; });
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
    const write = method !== "GET";
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
    if (path === "/api/v1/state" && method === "GET") {
      queries(url, []); const output: WebState = { providerManagement: options.providerManagement ?? true, workspace: options.configuration.workspace, providers: app.providers.list(), harnesses: await rescan(), sessions: app.store.list(100).map(summary), jobs: app.management.listJobs().slice(0, 50) }; json(response, 200, output); return;
    }
    if (path === "/api/v1/harnesses" && method === "GET") { queries(url, []); json(response, 200, await rescan()); return; }
    const permissionRoute = /^\/api\/v1\/sessions\/(session-[a-zA-Z0-9-]+)\/permissions\/(permission-[a-zA-Z0-9-]+)$/u.exec(path);
    const nativeBranch = /^\/api\/v1\/sessions\/(session-[a-zA-Z0-9-]+)\/native-branch$/u.exec(path);
    if (nativeBranch && method === "POST") {
      queries(url, []); const input = record(await body(request), ["epoch", "commandId"], ["epoch", "commandId"]);
      if (typeof input.epoch !== "number" || !Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new HttpError(400, "INVALID_INPUT", "invalid native branch epoch");
      json(response, 200, view(app.runtime.resetNative(sessionId(nativeBranch[1]), text(input.commandId, "commandId", 128), input.epoch))); return;
    }
    if (permissionRoute && method === "POST") { queries(url, []); const input = record(await body(request), ["optionId", "commandId", "input"], ["optionId", "commandId"]); const id = sessionId(permissionRoute[1]); json(response, 200, await app.runtime.decidePermission(id, permissionRoute[2]!, text(input.optionId, "optionId", 512), text(input.commandId, "commandId", 128), input.input===undefined?undefined:(typeof input.input==="string"&&Buffer.byteLength(input.input)<=65536&&!input.input.includes("\0")?input.input:(()=>{throw new HttpError(400,"INVALID_INPUT","invalid native UI input")})()))); return; }
    const modelsRoute = /^\/api\/v1\/harnesses\/([a-z][a-z0-9-]{0,95})\/models$/u.exec(path);
    if (modelsRoute && method === "GET") {
      queries(url, ["controlId", "workspace", "refresh", "nativeModel"]);
      const refresh = url.searchParams.get("refresh"); if (refresh !== null && refresh !== "1") throw new HttpError(400, "INVALID_INPUT", "invalid model refresh flag");
      const controlId = url.searchParams.get("controlId"), workspace = url.searchParams.get("workspace");
      const configuration = workspace === null ? options.configuration : await prepareConfiguration({ workspace,
        ...(options.configuration.configHome === null ? {} : { configHome: options.configuration.configHome }),
        ...(options.configuration.manifestPath === null ? {} : { manifestPath: options.configuration.manifestPath }),
        packageRoots: options.configuration.packageRoots, searchDirs: options.configuration.searchDirs, pathOnly: options.configuration.pathOnly });
      const selected = select({ harnessId: modelsRoute[1], ...(controlId === null ? {} : { controlId }), ...(url.searchParams.get("nativeModel") === null ? {} : {nativeModel:url.searchParams.get("nativeModel")}) });
      try { json(response, 200, await nativeModels.read(selected, configuration, refresh === "1")); }
      catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "MODEL_DISCOVERY_FAILED";
        if (code === "GATEWAY_AUTH_REQUIRED" || code === "HARNESS_AUTH_REQUIRED") { json(response, 200, { models: [], defaultModel: null, authentication: "missing", canSelect: false }); return; }
        throw new HttpError(502, code, "无法读取这个 Harness 的本机模型列表。请检查它的登录和配置后刷新。");
      }
      return;
    }
    if (path === "/api/v1/harnesses/rescan" && method === "POST") { queries(url, []); record(await body(request), []); json(response, 200, await rescan()); return; }
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
        queries(url, []); const input = record(await body(request), ["harnessId", "controlId", "action", "commandId", "expectedDefaultRevision", "expectedNativeFingerprint"], ["harnessId", "action", "commandId"]);
        if (input.action !== "install" && input.action !== "upgrade") throw new HttpError(400, "INVALID_INPUT", "Expected install or upgrade action");
        await rescan();
        json(response, 202, app.management.submit({ harnessId: text(input.harnessId, "Harness identity", 96), action: input.action, commandId: command(input.commandId),
          ...(input.controlId === undefined ? {} : { controlId: text(input.controlId, "control identity", 96) }),
          ...(input.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: integer(input.expectedDefaultRevision, 0, Number.MAX_SAFE_INTEGER, "default revision") }),
          ...(input.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: text(input.expectedNativeFingerprint, "native fingerprint", 64) }) })); return;
      }
    }
    const jobRoute = /^\/api\/v1\/installation-jobs\/([^/]+)(?:\/(logs|cancel|inspect))?$/u.exec(path);
    if (jobRoute) {
      const id = jobRoute[1]!, action = jobRoute[2];
      if (action === undefined && method === "GET") { queries(url, []); json(response, 200, app.management.readJob(id)); return; }
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
    if (path === "/api/v1/sessions") {
      if (method === "GET") { queries(url, ["limit"]); json(response, 200, app.store.list(cursor(url.searchParams.get("limit"), 100, 1, 100)).map(summary)); return; }
      if (method === "POST") {
        queries(url, []); const input = record(await body(request), ["workspace", "selection", "commandId"], ["selection", "commandId"]);
        const configuration = input.workspace === undefined ? options.configuration : await prepareConfiguration({ workspace: text(input.workspace, "workspace"),
          ...(options.configuration.manifestPath === null ? {} : { manifestPath: options.configuration.manifestPath }),
          ...(options.configuration.configHome === null ? {} : { configHome: options.configuration.configHome }),
          packageRoots: options.configuration.packageRoots, searchDirs: options.configuration.searchDirs, pathOnly: options.configuration.pathOnly });
        json(response, 201, view(await app.runtime.create(configuration, select(input.selection), command(input.commandId)))); return;
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
    const sessionRoute = /^\/api\/v1\/sessions\/([^/]+)(?:\/(messages|switches|resume|cancel|close|events))?$/u.exec(path);
    if (sessionRoute) {
      const id = sessionId(sessionRoute[1]!), action = sessionRoute[2];
      if (action === undefined && method === "GET") { queries(url, []); json(response, 200, view(app.runtime.read(id), app.runtime.permissionRequests(id))); return; }
      if (action === "events" && method === "GET") {
        queries(url, ["afterSeq", "limit"]); const after = cursor(url.searchParams.get("afterSeq"), 0, 0, Number.MAX_SAFE_INTEGER), limit = cursor(url.searchParams.get("limit"), 50, 1, 100);
        const events = app.store.events(id, after, limit), nextSeq = events.at(-1)?.seq ?? after;
        const output: EventPage = { events, nextSeq, hasMore: app.runtime.read(id).lastSeq > nextSeq }; json(response, 200, output); return;
      }
      if (method === "POST") {
        queries(url, []);
        if (action === "messages") { const input = record(await body(request), ["text", "commandId"], ["text", "commandId"]); if (typeof input.text !== "string") throw new HttpError(400, "INVALID_INPUT", "Message text required"); json(response, 202, app.runtime.send(id, input.text, command(input.commandId))); return; }
        if (action === "switches") { const input = record(await body(request), ["selection", "commandId"], ["selection", "commandId"]); json(response, 202, app.runtime.switch(id, select(input.selection), command(input.commandId))); return; }
        if (action === "resume") {
          const input = record(await body(request), ["selection", "commandId", "acknowledgeUnknown"], ["selection", "commandId"]);
          if (input.acknowledgeUnknown !== undefined && typeof input.acknowledgeUnknown !== "boolean") throw new HttpError(400, "INVALID_INPUT", "Invalid unknown-result acknowledgement");
          json(response, 202, app.runtime.resume(id, select(input.selection), command(input.commandId), input.acknowledgeUnknown === true)); return;
        }
        if (action === "cancel") { const input = record(await body(request), ["runId", "commandId"], ["commandId"]); json(response, 202, app.runtime.cancel(id, command(input.commandId), input.runId === undefined ? undefined : text(input.runId, "Run identity", 128))); return; }
        if (action === "close") { const input = record(await body(request), ["commandId"], ["commandId"]); json(response, 200, view(await app.runtime.closeSession(id, command(input.commandId)))); return; }
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
      const fault = publicFailure(error);
      json(response, fault.status, { code: fault.code, message: app.providers.redact(fault.message) }); request.resume();
    }).finally(() => { running--; });
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000; server.maxConnections = 32;
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    streams.close();
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
      try { app.store.close(); } catch (error) { failure ??= error; }
      logins.clear();
      if (failure) throw failure;
    })();
    return closing;
  };
  try {
    await rescan();
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); done(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Local listener unavailable");
    host = "127.0.0.1:" + address.port; origin = "http://" + host;
    return { url: origin + "/#token=" + bootstrap, close };
  } catch (error) {
    streams.close();
    await nativeModels.close();
    try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
    throw error;
  }
}
