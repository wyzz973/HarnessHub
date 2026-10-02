// SPDX-License-Identifier: MIT
/**
 * Gateway sharing on the local network (03-model-plane section 1,
 * 06-interfaces section 1, 07-data-security section 5.4): the persisted
 * sharing settings and the second, LAN listener of the daemon. That listener
 * serves the model protocol paths only, through the shared gateway's LAN
 * entry; every other path, the management API included, does not exist on it.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import {
  LOOPBACK_ONLY,
  resolveGatewaySharing,
  SHARING_OFF,
  SharingConfigError,
  sharingAccess,
  type GatewayAccess,
  type GatewaySharing,
} from "@harnesshub/gateway/sharing";
import { ApiProblem } from "./http/api-v1.js";
import type { GatewayShareStatus } from "./http/gateway-share-routes.js";
import { isModelGatewayPath, requestPath } from "./http/model-gateway-mount.js";

/** The settings file in the data root. */
export const GATEWAY_SHARING_FILE = "gateway-sharing.json";

interface Listener {
  server: Server;
  host: string;
  /** As configured; 0 lets the system choose. */
  requestedPort: number;
  port: number;
}

function hostLiteral(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function wildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function listenError(host: string, port: number, error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const reason =
    code === "EADDRINUSE"
      ? "the port is in use (choose another lan.port)"
      : code === "EADDRNOTAVAIL"
        ? "the address does not belong to this machine"
        : code === "EACCES"
          ? "permission denied"
          : error instanceof Error
            ? error.message.slice(0, 200)
            : "unknown error";
  return `Cannot listen on ${hostLiteral(host)}:${port}: ${reason}`;
}

/**
 * Owns the sharing settings file and the LAN listener. Changes are
 * serialized. The owner calls {@link load} before the gateway starts,
 * {@link listen} once the daemon's own listener is bound, and {@link close}
 * after the gateway closed.
 */
export class GatewayShare {
  #settings: GatewaySharing = SHARING_OFF;
  #access: GatewayAccess = LOOPBACK_ONLY;
  #listener: Listener | undefined;
  #error: string | undefined;
  #closing = new Set<Promise<void>>();
  #closingServers = new Set<Server>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly options: {
      /** The data root; the settings are `<dataDir>/gateway-sharing.json`. */
      dataDir: string;
      /** The shared gateway's LAN entry (`GatewayHandler.lan`). */
      handle(request: IncomingMessage, response: ServerResponse): void;
      /** Applied as the LAN listener's `headersTimeout`. */
      headersTimeoutMs: number;
      /** The daemon's bound port: the LAN port when the settings name none. */
      daemonPort(): number | undefined;
      log: LogSink;
    },
  ) {}

  get file(): string {
    return path.join(this.options.dataDir, GATEWAY_SHARING_FILE);
  }

  /** The gateway's rules for the current settings; read once per request. */
  access(): GatewayAccess {
    return this.#access;
  }

  /**
   * Read the settings file (absent: sharing off). `publicBaseUrl` applies
   * from here on; the LAN listener starts with {@link listen}.
   *
   * @throws HubError `INVALID_CONFIG` when the file is not valid settings.
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    let settings: GatewaySharing;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
      )
        throw new SharingConfigError(
          "/schemaVersion",
          "schemaVersion must be 1",
        );
      const { schemaVersion: _version, ...rest } = parsed as Record<
        string,
        unknown
      >;
      settings = resolveGatewaySharing(rest);
    } catch (error) {
      throw new HubError(
        "INVALID_CONFIG",
        `${this.file} is not valid gateway sharing settings: ${
          error instanceof Error ? error.message.slice(0, 200) : "invalid JSON"
        }`,
      );
    }
    this.#settings = settings;
    this.#access = sharingAccess(settings, undefined);
  }

  /**
   * Start the LAN listener when the loaded settings enable it. A failed bind
   * does not fail the daemon: it is logged as `gateway.lan.listen_failed`
   * and reported by {@link status} until the settings are changed, so that
   * sharing can still be turned off or moved to another address.
   */
  listen(): Promise<void> {
    return this.#serialized(() => this.#apply(this.#settings, false));
  }

  status(): GatewayShareStatus {
    const listener = this.#listener;
    const lan = this.#settings.lan;
    const urls: string[] = [];
    if (listener) {
      const names = [
        ...(lan.host !== undefined && !wildcard(lan.host) ? [lan.host] : []),
        ...lan.names.filter((name) => name !== lan.host),
      ];
      for (const name of names)
        urls.push(`http://${hostLiteral(name)}:${listener.port}`);
    }
    if (this.#settings.publicBaseUrl !== undefined)
      urls.push(this.#settings.publicBaseUrl);
    return {
      lan: { ...lan, names: [...lan.names] },
      ...(this.#settings.publicBaseUrl !== undefined
        ? { publicBaseUrl: this.#settings.publicBaseUrl }
        : {}),
      listening: listener !== undefined,
      ...(listener ? { boundPort: listener.port } : {}),
      urls,
      ...(this.#error !== undefined ? { error: this.#error } : {}),
    };
  }

  /**
   * Replace the settings (the body of `PUT /api/v1/gateway/share`). A new
   * listener address is bound before the file is written and before the old
   * listener closes; when the two overlap, turn sharing off first. Requests
   * in flight on a closed listener finish; new ones are refused.
   *
   * @throws ApiProblem `GATEWAY_SHARE_INVALID` (400) for invalid
   *   settings, with the field in `errors[]`; HubError
   *   `GATEWAY_SHARE_LISTEN_FAILED` (409) when the address cannot be bound.
   *   Nothing changes in either case; a failed file write closes the new
   *   listener and rejects with that error.
   */
  update(input: unknown): Promise<GatewayShareStatus> {
    return this.#serialized(async () => {
      let next: GatewaySharing;
      try {
        next = resolveGatewaySharing(input);
      } catch (error) {
        if (!(error instanceof SharingConfigError)) throw error;
        throw new ApiProblem(
          "GATEWAY_SHARE_INVALID",
          "The gateway sharing settings are invalid",
          400,
          { errors: [{ pointer: error.field, detail: error.message }] },
        );
      }
      await this.#apply(next, true);
      return this.status();
    });
  }

  /**
   * Stop the LAN listener and wait until its connections ended; connections
   * still open are destroyed, so call it after the gateway aborted its
   * in-flight calls. Idempotent.
   */
  close(): Promise<void> {
    this.#closed = true;
    return this.#serialized(async () => {
      if (this.#listener) this.#stop(this.#listener);
      this.#listener = undefined;
      this.#access = LOOPBACK_ONLY;
      for (const listener of this.#closingServers)
        listener.closeAllConnections();
      await Promise.allSettled([...this.#closing]);
    });
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #bind(host: string, port: number): Promise<Listener> {
    const handle = this.options.handle;
    const server = createServer((request, response) => {
      if (isModelGatewayPath(requestPath(request.url))) {
        handle(request, response);
        return;
      }
      request.resume();
      response.on("error", () => undefined);
      response.writeHead(404, {
        "content-type": "application/json",
        "x-hh-error-source": "gateway",
      });
      response.end(
        JSON.stringify({
          error: {
            code: "route_not_found",
            message: "The LAN listener serves the model gateway paths only",
          },
        }),
      );
    });
    server.headersTimeout = this.options.headersTimeoutMs;
    server.listen({ host, port });
    try {
      await once(server, "listening");
    } catch (error) {
      server.close();
      throw error;
    }
    server.on("error", (error) =>
      this.options.log.info("gateway.lan.error", {
        message: error.message.slice(0, 200),
      }),
    );
    const address = server.address();
    const bound = address && typeof address === "object" ? address.port : port;
    this.options.log.info("gateway.lan.listen", { host, port: bound });
    return { server, host, requestedPort: port, port: bound };
  }

  #stop(listener: Listener): void {
    const { server } = listener;
    this.#closingServers.add(server);
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    ).finally(() => {
      this.#closingServers.delete(server);
      this.#closing.delete(closed);
    });
    this.#closing.add(closed);
    server.closeIdleConnections();
    this.options.log.info("gateway.lan.stop", {
      host: listener.host,
      port: listener.port,
    });
  }

  async #apply(next: GatewaySharing, strict: boolean): Promise<void> {
    if (this.#closed)
      throw new HubError("GATEWAY_CLOSING", "The daemon is shutting down", 503);
    const current = this.#listener;
    const want = next.lan.enabled
      ? {
          host: next.lan.host!,
          port: next.lan.port ?? this.options.daemonPort() ?? 0,
        }
      : undefined;
    const reuse =
      want !== undefined &&
      current !== undefined &&
      current.host === want.host &&
      current.requestedPort === want.port;
    let opened: Listener | undefined;
    let error: string | undefined;
    if (want && !reuse)
      try {
        opened = await this.#bind(want.host, want.port);
      } catch (cause) {
        error = listenError(want.host, want.port, cause);
        if (strict)
          throw new HubError("GATEWAY_SHARE_LISTEN_FAILED", error, 409);
        this.options.log.info("gateway.lan.listen_failed", {
          host: want.host,
          port: want.port,
          message: error,
        });
      }
    if (strict)
      try {
        await this.#persist(next);
      } catch (cause) {
        if (opened) this.#stop(opened);
        throw cause;
      }
    const listener = reuse ? current : opened;
    if (current && current !== listener) this.#stop(current);
    this.#listener = listener;
    this.#settings = next;
    this.#error = error;
    this.#access = sharingAccess(next, listener?.port);
  }

  async #persist(settings: GatewaySharing): Promise<void> {
    const file = this.file;
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, ...settings }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, file);
    } catch (error) {
      // The write or rename error is the result; the previous file is intact.
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
