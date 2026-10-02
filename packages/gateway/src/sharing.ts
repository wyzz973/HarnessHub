// SPDX-License-Identifier: MIT
/**
 * Gateway sharing (03-model-plane sections 1 and 2, 07-data-security
 * section 5.4): the `gateway.lan` and `gateway.publicBaseUrl` settings, and
 * the Host rules the shared gateway derives from them. The daemon
 * owns the LAN listener and persists the settings; the gateway only reads
 * the resulting {@link GatewayAccess} on every request.
 */
import { isIP } from "node:net";

/** Resolved sharing settings; {@link resolveGatewaySharing} fills the defaults. */
export interface GatewaySharing {
  lan: {
    /** The daemon also listens on `host:port` for model-protocol requests. */
    enabled: boolean;
    /**
     * IP address the LAN listener binds: an address of this machine, or
     * `0.0.0.0` / `::` for every address (then `names` or `publicBaseUrl`
     * must say which Host peers use).
     */
    host?: string;
    /** Port of the LAN listener; absent means the daemon's own port. */
    port?: number;
    /** Further Host names peers reach the LAN listener by (DNS names, other addresses). */
    names: string[];
  };
  /**
   * The address clients use behind a reverse proxy, without the gateway
   * paths (`https://hh.example.com`); its Host is accepted on both
   * listeners.
   */
  publicBaseUrl?: string;
}

/** Sharing off: the defaults when nothing is configured. */
export const SHARING_OFF: Readonly<GatewaySharing> = Object.freeze({
  lan: Object.freeze({ enabled: false, names: [] }),
});

/** An invalid sharing setting; `field` is its JSON Pointer (`/lan/host`). */
export class SharingConfigError extends RangeError {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SharingConfigError";
  }
}

const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_NAMES = 20;

function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** An IP literal as a Host header carries it: IPv6 in brackets. */
function hostLiteral(name: string): string {
  return isIP(name) === 6 ? `[${name}]` : name;
}

/**
 * The canonical form of a Host header (`name[:port]`, lowercase, IPv6
 * compressed, port 80 dropped), or undefined when it is malformed.
 */
export function canonicalHost(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z0-9.\-:[\]]{1,300}$/.test(value)) return undefined;
  try {
    return new URL(`http://${value}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `gateway` sharing settings: `undefined` gives
 * {@link SHARING_OFF}; an object may carry `lan` (`enabled`, `host`, `port`,
 * `names`) and `publicBaseUrl`. Unknown fields fail.
 *
 * @throws SharingConfigError naming the first invalid field: `lan.host` is
 *   required while enabled and must be an IP literal; `names` are DNS names
 *   or IP literals (at most 20); listening on every address needs `names` or
 *   `publicBaseUrl`; `publicBaseUrl` is an http(s) URL without credentials,
 *   query or fragment.
 */
export function resolveGatewaySharing(input: unknown): GatewaySharing {
  if (input === undefined) return SHARING_OFF;
  const object = (value: unknown, field: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SharingConfigError(
        field,
        `${field || "sharing"} must be an object`,
      );
    return value as Record<string, unknown>;
  };
  const only = (
    value: Record<string, unknown>,
    allowed: string[],
    field: string,
  ) => {
    for (const name of Object.keys(value))
      if (!allowed.includes(name))
        throw new SharingConfigError(
          `${field}/${name}`,
          `Unknown sharing setting ${name.slice(0, 64)}`,
        );
  };
  const root = object(input, "");
  only(root, ["lan", "publicBaseUrl"], "");
  const lanInput = root.lan === undefined ? {} : object(root.lan, "/lan");
  only(lanInput, ["enabled", "host", "port", "names"], "/lan");
  const enabled = lanInput.enabled ?? false;
  if (typeof enabled !== "boolean")
    throw new SharingConfigError(
      "/lan/enabled",
      "lan.enabled must be a boolean",
    );
  let host: string | undefined;
  if (lanInput.host !== undefined) {
    if (typeof lanInput.host !== "string" || !isIP(lanInput.host))
      throw new SharingConfigError(
        "/lan/host",
        "lan.host must be an IP address of this machine, or 0.0.0.0 or :: for every address",
      );
    host = lanInput.host;
  }
  let port: number | undefined;
  if (lanInput.port !== undefined) {
    if (
      typeof lanInput.port !== "number" ||
      !Number.isSafeInteger(lanInput.port) ||
      lanInput.port < 0 ||
      lanInput.port > 65535
    )
      throw new SharingConfigError(
        "/lan/port",
        "lan.port must be an integer from 0 to 65535",
      );
    port = lanInput.port;
  }
  const names: string[] = [];
  if (lanInput.names !== undefined) {
    if (!Array.isArray(lanInput.names) || lanInput.names.length > MAX_NAMES)
      throw new SharingConfigError(
        "/lan/names",
        `lan.names must be a list of at most ${MAX_NAMES} host names`,
      );
    lanInput.names.forEach((name: unknown, index) => {
      const lower = typeof name === "string" ? name.toLowerCase() : "";
      if (!isIP(lower) && !HOST_NAME.test(lower))
        throw new SharingConfigError(
          `/lan/names/${index}`,
          "lan.names entries must be DNS names or IP addresses",
        );
      if (!names.includes(lower)) names.push(lower);
    });
  }
  let publicBaseUrl: string | undefined;
  if (root.publicBaseUrl !== undefined) {
    const text = root.publicBaseUrl;
    let url: URL | undefined;
    try {
      url = typeof text === "string" ? new URL(text) : undefined;
    } catch {
      url = undefined;
    }
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new SharingConfigError(
        "/publicBaseUrl",
        "publicBaseUrl must be an http(s) URL without credentials, query or fragment",
      );
    publicBaseUrl = url.href.replace(/\/+$/, "");
  }
  if (enabled && host === undefined)
    throw new SharingConfigError(
      "/lan/host",
      "lan.host is required while LAN sharing is enabled",
    );
  if (
    enabled &&
    host !== undefined &&
    isWildcard(host) &&
    !names.length &&
    publicBaseUrl === undefined
  )
    throw new SharingConfigError(
      "/lan/names",
      "Listening on every address needs lan.names or publicBaseUrl: the Host that peers send is checked against them",
    );
  return {
    lan: {
      enabled,
      ...(host !== undefined ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      names,
    },
    ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
  };
}

/** What the gateway checks per request; derived by {@link sharingAccess}. */
export interface GatewayAccess {
  /** The LAN listener serves requests; false while sharing is off. */
  lan: boolean;
  /** Canonical Host values accepted on the LAN listener (besides `publicHosts`). */
  lanHosts: ReadonlySet<string>;
  /** Canonical Host of `publicBaseUrl`, accepted on both listeners. */
  publicHosts: ReadonlySet<string>;
}

/** No sharing: loopback connections with loopback Hosts only. */
export const LOOPBACK_ONLY: Readonly<GatewayAccess> = Object.freeze({
  lan: false,
  lanHosts: new Set<string>(),
  publicHosts: new Set<string>(),
});

/**
 * The rules for the current settings. `lanPort` is the port the LAN
 * listener actually bound; without it (sharing off, or the listener failed)
 * the LAN rules accept nothing, and only `publicBaseUrl` is added to the
 * loopback rules.
 */
export function sharingAccess(
  sharing: GatewaySharing,
  lanPort: number | undefined,
): GatewayAccess {
  const lanHosts = new Set<string>();
  const publicHosts = new Set<string>();
  const lan = sharing.lan.enabled && lanPort !== undefined;
  if (lan) {
    const names = [
      ...(sharing.lan.host !== undefined && !isWildcard(sharing.lan.host)
        ? [sharing.lan.host]
        : []),
      ...sharing.lan.names,
    ];
    for (const name of names) {
      const host = canonicalHost(`${hostLiteral(name)}:${lanPort}`);
      if (host === undefined) continue;
      lanHosts.add(host);
    }
  }
  if (sharing.publicBaseUrl !== undefined) {
    const url = new URL(sharing.publicBaseUrl);
    const host = canonicalHost(url.host);
    if (host !== undefined) publicHosts.add(host);
  }
  return { lan, lanHosts, publicHosts };
}
