import { GatewayClient, type GatewayClientRequestError } from "@openclaw/gateway-client";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { DeviceStore, devicePath, gatewayTarget, publicKeyRaw, signPayload } from "./device.js";
import type { GatewayMethod } from "./methods.js";

/** What the Gateway said when it took the connection (hello-ok), as far as the driver reads it. */
export interface GatewayHello {
  readonly protocol: number;
  readonly serverVersion: string | null;
  /** The methods this Gateway serves; null when it did not list them. */
  readonly methods: ReadonlySet<string> | null;
  readonly scopes: readonly string[];
  readonly maxPayload: number | null;
  readonly attachments: { readonly maxBytes: number; readonly maxImageBytes: number } | null;
}
/** One connection to the Gateway; it reconnects by itself, and says so (LinkHandlers.reconnected). */
export interface GatewayLink {
  readonly hello: GatewayHello;
  connected(): boolean;
  request(method: GatewayMethod, params: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}
export interface LinkHandlers {
  event(name: string, payload: unknown): void;
  /** A new connection took the place of a lost one. */
  reconnected(hello: GatewayHello): void;
  disconnected(): void;
  /** The connection will not come back by itself (it was refused, or the Gateway paused reconnecting). */
  lost(error: Error): void;
}
export type GatewayConnector = (handlers: LinkHandlers, env: Readonly<Record<string, string>>, timeoutMs: number) => Promise<GatewayLink>;

/** The scopes HarnessHub's device asks for: admin is what cwd, compaction and rewind need (docs/gateway/protocol/operator-methods.md). */
export const SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"];
/** What this client implements (docs/gateway/clients.md client capabilities): tool events, both kinds of approval. */
export const CAPS = ["tool-events", "exec-approvals", "plugin-approvals", "approvals"];
export const CLIENT_VERSION = "2026.11.3";

function helloOf(raw: unknown): GatewayHello {
  const row = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const server = row.server !== null && typeof row.server === "object" ? row.server as Record<string, unknown> : {};
  const features = row.features !== null && typeof row.features === "object" ? row.features as Record<string, unknown> : {};
  const policy = row.policy !== null && typeof row.policy === "object" ? row.policy as Record<string, unknown> : {};
  const auth = row.auth !== null && typeof row.auth === "object" ? row.auth as Record<string, unknown> : {};
  const limits = policy.attachments !== null && typeof policy.attachments === "object" ? policy.attachments as Record<string, unknown> : null;
  return { protocol: typeof row.protocol === "number" ? row.protocol : 0, serverVersion: typeof server.version === "string" ? server.version.slice(0, 128) : null,
    methods: Array.isArray(features.methods) ? new Set(features.methods.filter((name): name is string => typeof name === "string")) : null,
    scopes: Array.isArray(auth.scopes) ? auth.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    maxPayload: typeof policy.maxPayload === "number" ? policy.maxPayload : null,
    attachments: limits !== null && typeof limits.maxBytes === "number" && typeof limits.maxImageBytes === "number" ? { maxBytes: limits.maxBytes, maxImageBytes: limits.maxImageBytes } : null };
}
/** A refusal from the Gateway as the driver's error: its code and words kept as the peer's own (never in the message). */
export function requestFailure(method: string, error: unknown): ControlError {
  const failure = error as Partial<GatewayClientRequestError> & { readonly name?: string; readonly message?: string };
  if (failure?.name === "GatewayClientRequestTimeoutError") return new ControlError("REQUEST_TIMEOUT", "the OpenClaw Gateway did not answer " + method);
  const code = typeof failure?.gatewayCode === "string" ? failure.gatewayCode : null;
  if (code === null) return new ControlError("CONNECTION_FAILED", "the OpenClaw Gateway connection failed during " + method);
  const details = failure.details !== null && typeof failure.details === "object" ? failure.details as Record<string, unknown> : {};
  const fields = Object.fromEntries(Object.entries(details).filter(([, value]) => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,64}$/u.test(value)).slice(0, 8)) as Record<string, string>;
  return new ControlError("REMOTE_ERROR", "the OpenClaw Gateway refused " + method + " (" + code.slice(0, 64) + ")", undefined,
    { code: -32000, ...(typeof failure.message === "string" ? { message: failure.message.slice(0, 2048) } : {}), fields: { gatewayCode: code.slice(0, 64), ...fields } });
}

/**
 * The real connection (`@openclaw/gateway-client`, MIT, pinned to the installed Gateway): HarnessHub's paired device signs the challenge; the
 * shared token goes only with the first connection, before the Gateway issued the device its own token (loopback pairs silently,
 * docs/gateway/pairing.md); protocol v4 exactly. The client is `gateway-client` in mode `cli`: as a `backend` on loopback the Gateway
 * would skip pairing (shouldSkipLocalBackendSelfPairing) and never issue the device a token of its own.
 */
export const connectGateway: GatewayConnector = async (handlers, env, timeoutMs) => {
  const target = await gatewayTarget(env), device = await DeviceStore.open(devicePath(env)), role = "operator";
  const stored = device.token(target.url, role), shared = stored === null ? await target.sharedToken() : undefined;
  let first: { resolve(hello: GatewayHello): void; reject(error: Error): void } | null = null, up = false, closed = false;
  const opened = new Promise<GatewayHello>((resolve, reject) => { first = { resolve, reject }; });
  const client = new GatewayClient({
    url: target.url, ...(shared ? { token: shared } : {}), clientName: "gateway-client", mode: "cli", clientDisplayName: "HarnessHub", clientVersion: CLIENT_VERSION, platform: process.platform,
    role, scopes: SCOPES, caps: CAPS, minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION, requestTimeoutMs: timeoutMs, deviceIdentity: device.identity,
    hostDeps: {
      signDevicePayload: signPayload, publicKeyRawBase64UrlFromPem: publicKeyRaw,
      loadDeviceAuthToken: ({ role: asked }) => device.token(target.url, asked),
      storeDeviceAuthToken: ({ role: asked, token, scopes }) => device.store(target.url, asked, token, scopes),
      clearDeviceAuthToken: ({ role: asked }) => device.clear(target.url, asked),
    },
    onHelloOk: raw => { const hello = helloOf(raw); up = true; if (first !== null) { const pending = first; first = null; pending.resolve(hello); } else handlers.reconnected(hello); },
    onConnectError: error => { if (first !== null) { const pending = first; first = null; pending.reject(new ControlError("NATIVE_CONNECTION_FAILED", "OpenClaw Gateway refused HarnessHub's connection: " + String(error.message).slice(0, 300))); } },
    onReconnectPaused: info => { if (!closed) handlers.lost(new ControlError("NATIVE_CONNECTION_FAILED", "OpenClaw Gateway stopped taking HarnessHub's connection (" + String(info.detailCode ?? info.code) + ")")); },
    onClose: () => { if (up && !closed) { up = false; handlers.disconnected(); } },
    onEvent: frame => { try { handlers.event(frame.event, frame.payload); } catch { /* the driver's handler reports its own failures */ } },
  });
  client.start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hello = await Promise.race([opened, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ControlError("NATIVE_INITIALIZE_TIMEOUT", "OpenClaw Gateway did not take the connection in time")), timeoutMs); })]);
    return {
      hello, connected: () => up && client.connected,
      request: async (method, params, ms) => { try { return await client.request(method, params, { timeoutMs: ms }); } catch (error) { throw requestFailure(method, error); } },
      close: async () => { closed = true; await client.stopAndWait({ timeoutMs: 3000 }).catch(() => {}); },
    };
  } catch (error) { closed = true; await client.stopAndWait({ timeoutMs: 3000 }).catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
};
