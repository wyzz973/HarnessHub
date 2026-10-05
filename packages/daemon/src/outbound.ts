// SPDX-License-Identifier: MIT
/**
 * The daemon's outbound network policy: which of its own requests go
 * through a proxy, and the one fetch every component sends them with
 * (provider calls, model lists, the catalog, subscription sign-ins, search,
 * sync, OTLP). Follows Magpie's `internal/netproxy` (yetone/magpie@2e340f7,
 * MIT): one proxy for every vendor, a provider's own proxy or `direct`, and
 * loopback never proxied. HarnessHub also leaves private networks direct,
 * whichever proxy applies, and the `network.noProxy` hosts direct from the
 * daemon's proxy.
 *
 * Tunnels are opened here rather than by undici's ProxyAgent: a proxy that
 * closes the connection after `CONNECT` without answering makes ProxyAgent
 * reconnect in a tight loop until the caller's deadline (undici 7.29.1),
 * and its failures do not say that the proxy was at fault.
 */
import { BlockList, connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { Agent, buildConnector } from "undici";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";
import {
  displayProxy,
  parseProxyUrl,
  PROXY_FAILED,
  type OutboundFetch,
} from "@harnesshub/core/outbound";

/** The `network` settings as `startHub` takes them (config.jsonc, `--proxy`, the environment). */
export interface NetworkSettings {
  /**
   * The proxy for every outbound request: an `http://`, `https://`,
   * `socks5://` or `socks5h://` address (a bare `host:port` is HTTP), or
   * `direct`. Absent: no proxy.
   */
  proxy?: string;
  /** The proxy's password when its address names a user and no password. */
  proxyPassword?: SecretReference;
  /** Hosts that never go through the proxy: `NO_PROXY` entries. */
  noProxy?: readonly string[];
}

/** The settings after validation; the password is resolved by the caller. */
export interface ResolvedNetwork {
  proxy?: URL;
  proxyPassword?: SecretReference;
  noProxy: readonly string[];
}

function invalid(message: string): HubError {
  return new HubError("CONFIG_INVALID", message, 400);
}

/**
 * A `noProxy` entry's host and port: `[IPv6]:port`, a bare IPv6 address
 * (which cannot carry a port), or `name:port`; undefined when it is none.
 */
function entryParts(
  entry: string,
): { name: string; port?: number; bracketed: boolean } | undefined {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry);
  if (bracketed)
    return {
      name: bracketed[1]!,
      ...(bracketed[2] !== undefined ? { port: Number(bracketed[2]) } : {}),
      bracketed: true,
    };
  if (isIP(entry) === 6) return { name: entry, bracketed: false };
  const named = /^([^:]*)(?::(\d{1,5}))?$/.exec(entry);
  if (!named) return undefined;
  return {
    name: named[1]!,
    ...(named[2] !== undefined ? { port: Number(named[2]) } : {}),
    bracketed: false,
  };
}

/**
 * One `noProxy` entry's problem, or undefined. What it accepts is what
 * {@link noProxyMatches} compares: `*`, an address range, an IPv4 or IPv6
 * address in any notation (bracketed when it has a port), or a host or
 * domain with an optional leading `.` or `*.`, trailing dot and port.
 */
export function noProxyProblem(entry: string): string | undefined {
  if (entry === "*") return undefined;
  const [address, prefix] = entry.split("/");
  if (prefix !== undefined) {
    const family = isIP(address ?? "");
    const bits = Number(prefix);
    return family &&
      /^\d{1,3}$/.test(prefix) &&
      bits <= (family === 4 ? 32 : 128)
      ? undefined
      : `${entry} is not an address range such as 10.0.0.0/8`;
  }
  const what = `${entry} is not a host, domain (.example.com), address or range`;
  const parts = entryParts(entry);
  if (
    !parts ||
    (parts.port !== undefined && (parts.port < 1 || parts.port > 65_535))
  )
    return what;
  if (isIP(parts.name)) return undefined;
  // Brackets hold an IPv6 address only.
  if (parts.bracketed) return what;
  return /^(?:\*?\.)?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?$/.test(parts.name)
    ? undefined
    : what;
}

/**
 * Checks the `network` settings.
 *
 * @throws HubError `CONFIG_INVALID` naming the setting at fault.
 */
export function resolveNetworkSettings(input: unknown): ResolvedNetwork {
  if (input === undefined) return { noProxy: [] };
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw invalid("network must be an object");
  const { proxy, proxyPassword, noProxy, ...rest } = input as Record<
    string,
    unknown
  >;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined)
    throw invalid(`network.${unknown} is not a setting`);
  const resolved: ResolvedNetwork = { noProxy: [] };
  if (proxy !== undefined && proxy !== "direct") {
    if (typeof proxy !== "string")
      throw invalid("network.proxy must be a proxy address or direct");
    const parsed = parseProxyUrl(proxy, "allow");
    if ("problem" in parsed) throw invalid(`network.proxy ${parsed.problem}`);
    resolved.proxy = parsed.url;
  }
  if (proxyPassword !== undefined) {
    const ref = proxyPassword as Partial<SecretReference> | null;
    if (
      typeof ref !== "object" ||
      ref === null ||
      !["env", "file", "keychain", "store"].includes(String(ref.kind)) ||
      typeof ref.value !== "string" ||
      Object.keys(ref).length !== 2
    )
      throw invalid(
        'network.proxyPassword must be a secret reference {"kind": "env" | "file" | "keychain" | "store", "value": ...}',
      );
    resolved.proxyPassword = ref as SecretReference;
  }
  if (noProxy !== undefined) {
    if (
      !Array.isArray(noProxy) ||
      !noProxy.every((entry) => typeof entry === "string")
    )
      throw invalid("network.noProxy must be a list of hosts");
    for (const entry of noProxy as string[]) {
      const problem = noProxyProblem(entry.trim());
      if (problem) throw invalid(`network.noProxy: ${problem}`);
    }
    resolved.noProxy = (noProxy as string[]).map((entry) => entry.trim());
  }
  return resolved;
}

/** `NO_PROXY` as the environment gives it: entries separated by commas or spaces. */
export function splitNoProxy(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".home.arpa", ".internal"];

/**
 * This computer (loopback, and the unspecified addresses, a connection to
 * which reaches it too), private, link-local and shared (CGNAT, Tailscale)
 * addresses. BlockList also matches IPv4-mapped IPv6 forms
 * (`::ffff:127.0.0.1`, `::ffff:7f00:1`) and any IPv6 notation.
 */
const PRIVATE = (() => {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("0.0.0.0", "ipv4");
  list.addAddress("::1", "ipv6");
  list.addAddress("::", "ipv6");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  return list;
})();

function bare(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Whether `address` is in `list`, in whichever notation; false for a name. */
function listed(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Whether `hostname` is on this computer or a private network: a loopback,
 * unspecified, private, link-local or shared address in any notation, a
 * name without dots, or a name under `.localhost`, `.local`, `.home.arpa`
 * or `.internal`. A public name that resolves to a private address is not
 * known without a lookup; list it in noProxy.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = bare(hostname);
  if (isIP(host)) return listed(PRIVATE, host);
  return (
    host === "localhost" ||
    !host.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/**
 * Whether a `noProxy` entry covers `hostname` on `port`. Addresses and
 * ranges compare as addresses, so any IPv6 notation and IPv4-mapped forms
 * match; names compare without case or a trailing dot.
 */
export function noProxyMatches(
  entry: string,
  hostname: string,
  port: number,
): boolean {
  if (entry === "*") return true;
  const host = bare(hostname);
  if (entry.includes("/")) {
    const [address, prefix] = entry.split("/") as [string, string];
    const want = isIP(address);
    if (!want) return false;
    const range = new BlockList();
    range.addSubnet(address, Number(prefix), want === 4 ? "ipv4" : "ipv6");
    return listed(range, host);
  }
  const parts = entryParts(entry);
  if (!parts) return false;
  if (parts.port !== undefined && parts.port !== port) return false;
  const family = isIP(parts.name);
  if (family) {
    const one = new BlockList();
    one.addAddress(parts.name, family === 4 ? "ipv4" : "ipv6");
    return listed(one, host);
  }
  const base = parts.name
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\*?\./, "");
  return host === base || host.endsWith(`.${base}`);
}

/** How long opening a tunnel may take: the connection to the proxy and its answer. */
export const PROXY_CONNECT_TIMEOUT_MS = 10_000;
/** The longest proxy answer to CONNECT read. */
const MAX_PROXY_ANSWER = 16 * 1024;

/** A proxy and the credentials it is sent. */
export interface ProxyTarget {
  url: URL;
  username?: string;
  password?: string;
}

/**
 * A failure of the proxy. `message` names the proxy (without credentials)
 * and the tunnel's target, for the daemon's log and its administrator;
 * `brief` names neither, for whoever made the request (a Gateway Key's
 * caller, a model reading a search result). Neither repeats text the proxy
 * sent.
 */
class ProxyError extends Error {
  readonly code = PROXY_FAILED;
  constructor(
    message: string,
    readonly brief: string,
  ) {
    super(message);
  }
}

/** `what` the proxy did; `brief` the same without the target or details. */
function proxyError(
  proxy: ProxyTarget,
  what: string,
  brief: string = what,
): ProxyError {
  return new ProxyError(
    `The proxy ${displayProxy(proxy.url)} ${what}`,
    `The outbound proxy ${brief}`,
  );
}

function authority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/**
 * Bytes from `socket` as they arrive, `need` at a time, failing on close,
 * error and the deadline the caller's timer enforces by destroying it.
 */
function reader(socket: Socket, fail: (what: string, brief?: string) => Error) {
  let buffered = Buffer.alloc(0);
  let waiting:
    | {
        test: (data: Buffer) => number;
        resolve: (n: number) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let ended: Error | undefined;
  const check = () => {
    if (!waiting) return;
    let n: number;
    try {
      n = waiting.test(buffered);
    } catch (error) {
      const { reject } = waiting;
      waiting = undefined;
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (n >= 0) {
      const { resolve } = waiting;
      waiting = undefined;
      resolve(n);
    } else if (ended) {
      const { reject } = waiting;
      waiting = undefined;
      reject(ended);
    }
  };
  const onData = (data: Buffer) => {
    buffered = Buffer.concat([buffered, data]);
    check();
  };
  const onEnd = () => {
    ended ??= fail("closed the connection without answering");
    check();
  };
  const onError = (error: Error) => {
    ended ??= fail(`failed: ${error.message}`, "failed");
    check();
  };
  socket.on("data", onData);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.on("error", onError);
  return {
    /** Wait until `test` says how many bytes make the next part; take them. */
    async take(test: (data: Buffer) => number): Promise<Buffer> {
      const n = await new Promise<number>((resolve, reject) => {
        waiting = { test, resolve, reject };
        check();
      });
      const part = buffered.subarray(0, n);
      buffered = buffered.subarray(n);
      return part;
    },
    /** Bytes read and not taken yet. */
    get pending(): number {
      return buffered.length;
    },
    /** Stop reading; nothing is left over (a proxy that sent more failed). */
    release(): void {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
    },
  };
}

/** HTTP CONNECT through `socket` to `host:port`. */
async function httpTunnel(
  proxy: ProxyTarget,
  socket: Socket,
  host: string,
  port: number,
  read: ReturnType<typeof reader>,
): Promise<void> {
  const target = authority(host, port);
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (proxy.username !== undefined)
    lines.push(
      `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}`,
    );
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const notHttp = () =>
    proxyError(proxy, "did not answer CONNECT as an HTTP proxy");
  const head = await read.take((data) => {
    const end = data.indexOf("\r\n\r\n");
    // Lines end with CRLF; a bare LF would only be read at the deadline.
    const lf = data.subarray(0, end >= 0 ? end + 4 : data.length);
    for (let at = lf.indexOf(10); at >= 0; at = lf.indexOf(10, at + 1))
      if (at === 0 || lf[at - 1] !== 13) throw notHttp();
    if (end >= 0) return end + 4;
    if (data.length > MAX_PROXY_ANSWER)
      throw proxyError(proxy, "sent an answer to CONNECT that is too long");
    return -1;
  });
  // The reason phrase is the proxy's text: it is not repeated.
  const status = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?\r\n/.exec(
    head.toString("latin1"),
  );
  if (!status) throw notHttp();
  const code = Number(status[1]);
  if (code >= 200 && code < 300) return;
  throw proxyError(
    proxy,
    `refused the tunnel to ${target}: ${code}${
      code === 407
        ? proxy.username === undefined
          ? " (it wants credentials: put them in the proxy address and network.proxyPassword, or in HTTPS_PROXY)"
          : " (it did not accept the credentials)"
        : ""
    }`,
    `refused the tunnel: ${code}`,
  );
}

const SOCKS_REPLIES: Readonly<Record<number, string>> = {
  1: "general failure",
  2: "connection not allowed by its rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused by the destination",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** A SOCKS5 CONNECT (RFC 1928, user name and password per RFC 1929); host names are resolved by the proxy. */
async function socksTunnel(
  proxy: ProxyTarget,
  socket: Socket,
  host: string,
  port: number,
  read: ReturnType<typeof reader>,
): Promise<void> {
  // The request gives a name's length in one byte.
  if (!isIP(host) && Buffer.byteLength(host) > 255)
    throw proxyError(
      proxy,
      `cannot be asked for ${host.slice(0, 32)}…, a host name longer than 255 bytes`,
      "cannot be asked for a host name longer than 255 bytes",
    );
  const auth = proxy.username !== undefined;
  socket.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const choice = await read.take((data) => (data.length >= 2 ? 2 : -1));
  if (choice[0] !== 5) throw proxyError(proxy, "is not a SOCKS5 proxy");
  if (choice[1] === 2 && auth) {
    const user = Buffer.from(proxy.username!, "utf8");
    const pass = Buffer.from(proxy.password ?? "", "utf8");
    if (user.length > 255 || pass.length > 255)
      throw proxyError(
        proxy,
        "cannot be sent credentials longer than 255 bytes",
      );
    socket.write(
      Buffer.concat([
        Buffer.from([1, user.length]),
        user,
        Buffer.from([pass.length]),
        pass,
      ]),
    );
    const status = await read.take((data) => (data.length >= 2 ? 2 : -1));
    if (status[0] !== 1)
      throw proxyError(proxy, "sent a reply HarnessHub cannot read");
    if (status[1] !== 0)
      throw proxyError(proxy, "did not accept the credentials");
  } else if (choice[1] !== 0)
    throw auth
      ? proxyError(proxy, "accepts none of the sign-in methods offered")
      : proxyError(
          proxy,
          "wants credentials: put them in the proxy address and network.proxyPassword, or in HTTPS_PROXY",
          "wants credentials",
        );
  const family = isIP(host);
  const address =
    family === 4
      ? Buffer.from([1, ...host.split(".").map(Number)])
      : family === 6
        ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
        : Buffer.concat([
            Buffer.from([3, Buffer.byteLength(host)]),
            Buffer.from(host, "utf8"),
          ]);
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, portBytes]));
  const reply = await read.take((data) => {
    if (data.length && data[0] !== 5)
      throw proxyError(proxy, "sent a reply HarnessHub cannot read");
    if (data.length < 5) return -1;
    const length =
      data[3] === 1
        ? 4
        : data[3] === 4
          ? 16
          : data[3] === 3
            ? 1 + data[4]!
            : -1;
    if (length < 0)
      throw proxyError(proxy, "sent a reply HarnessHub cannot read");
    return data.length >= 4 + length + 2 ? 4 + length + 2 : -1;
  });
  if (reply[1] !== 0) {
    const why = SOCKS_REPLIES[reply[1]!] ?? `reply ${reply[1]}`;
    throw proxyError(
      proxy,
      `refused the tunnel to ${authority(host, port)}: ${why}`,
      `refused the tunnel: ${why}`,
    );
  }
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail] = address.split("::") as [string, string | undefined];
  const parts = (text: string | undefined) =>
    text ? text.split(":").map((part) => parseInt(part, 16)) : [];
  const front = parts(head);
  const back = parts(tail);
  const words =
    tail === undefined
      ? front
      : [
          ...front,
          ...Array<number>(8 - front.length - back.length).fill(0),
          ...back,
        ];
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

/**
 * A socket to `host:port` through the proxy, ready for the request (or for
 * TLS to the upstream over it).
 *
 * @throws ProxyError (`code` PROXY_FAILED) when the proxy cannot be
 *   reached, refuses, closes the connection or does not finish within
 *   `timeoutMs`.
 */
export async function openTunnel(
  proxy: ProxyTarget,
  host: string,
  port: number,
  options: { timeoutMs: number; ca?: string | readonly string[] },
): Promise<Socket> {
  const { url } = proxy;
  const socks = url.protocol === "socks5:" || url.protocol === "socks5h:";
  const proxyHost = bare(url.hostname);
  const proxyPort =
    Number(url.port) || (socks ? 1080 : url.protocol === "https:" ? 443 : 80);
  const socket: Socket =
    url.protocol === "https:"
      ? connectTls({
          host: proxyHost,
          port: proxyPort,
          // SNI names a host, never an address (RFC 6066).
          ...(isIP(proxyHost) ? {} : { servername: proxyHost }),
          ...(options.ca ? { ca: options.ca as string | string[] } : {}),
          ALPNProtocols: ["http/1.1"],
        })
      : connectTcp({ host: proxyHost, port: proxyPort });
  const read = reader(socket, (what, brief) => proxyError(proxy, what, brief));
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const within =
        options.timeoutMs >= 1000
          ? `${Math.round(options.timeoutMs / 1000)} s`
          : `${options.timeoutMs} ms`;
      reject(
        proxyError(
          proxy,
          `did not open a tunnel to ${authority(host, port)} within ${within}`,
          `did not open the tunnel within ${within}`,
        ),
      );
    }, options.timeoutMs);
  });
  let unreachable: ((error: Error) => void) | undefined;
  let closed: (() => void) | undefined;
  try {
    await Promise.race([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          socket.once(
            url.protocol === "https:" ? "secureConnect" : "connect",
            resolve,
          );
          unreachable = (error) =>
            reject(
              proxyError(
                proxy,
                `could not be reached: ${error.message}`,
                "could not be reached",
              ),
            );
          closed = () => reject(proxyError(proxy, "closed the connection"));
          socket.once("error", unreachable);
          socket.once("close", closed);
        });
        if (socks) await socksTunnel(proxy, socket, host, port, read);
        else await httpTunnel(proxy, socket, host, port, read);
        // Neither HTTP nor TLS lets the server speak first: bytes after the
        // answer would be taken for the upstream's, and undici reconnects
        // without end when an answer comes before its request.
        if (read.pending > 0)
          throw proxyError(proxy, "sent more than its answer to the tunnel");
      })(),
      deadline,
    ]);
  } catch (error) {
    socket.destroy();
    throw error instanceof ProxyError
      ? error
      : proxyError(
          proxy,
          `failed: ${error instanceof Error ? error.message : String(error)}`,
          "failed",
        );
  } finally {
    clearTimeout(timer);
  }
  // From here the socket is the caller's; only this function's listeners go.
  read.release();
  if (unreachable) socket.off("error", unreachable);
  if (closed) socket.off("close", closed);
  return socket;
}

/** Options of {@link Outbound}. */
export interface OutboundOptions {
  /** How long opening a tunnel may take; {@link PROXY_CONNECT_TIMEOUT_MS} by default. */
  connectTimeoutMs?: number;
  /**
   * For tests only: certificates to trust besides the system's, for
   * upstreams and HTTPS proxies. Users with a TLS-inspecting proxy set
   * NODE_EXTRA_CA_CERTS instead.
   */
  ca?: string | readonly string[];
  /**
   * Where each proxy failure is recorded as `network.proxy_failed`, with
   * the proxy (without credentials) and the tunnel's target: the failure
   * requests report says neither.
   */
  log?: LogSink;
}

/**
 * `NO_PROXY` of the programs the daemon starts: what the daemon itself
 * sends directly, in the forms such programs read (curl, npm and Node read
 * names and suffixes; curl and newer tools also ranges). Names without dots
 * cannot be written; they may go through the proxy.
 */
const CHILD_NO_PROXY = [
  "localhost",
  ".localhost",
  "127.0.0.1",
  "::1",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
  "fe80::/10",
  ...LOCAL_SUFFIXES.filter((suffix) => suffix !== ".localhost"),
];

/** Agents kept for providers' own proxies; past this many the oldest closes. */
const MAX_OWN_AGENTS = 32;

/**
 * The daemon's outbound requests (Magpie `netproxy`): {@link fetch} sends
 * through the proxy in effect, or directly to loopback, private networks
 * and `noProxy` hosts. One agent per proxy choice keeps connections made
 * through one proxy from being reused through another. The owner awaits
 * {@link close} after every user of {@link fetch} stopped.
 */
export class Outbound {
  readonly #proxy: ProxyTarget | undefined;
  readonly #noProxy: readonly string[];
  readonly #options: Required<Pick<OutboundOptions, "connectTimeoutMs">> &
    OutboundOptions;
  readonly #log: LogSink;
  /** The agent of the daemon's proxy, made on first use. */
  #shared: Agent | undefined;
  /** Agents of providers' own proxies, oldest first. */
  readonly #own = new Map<string, Agent>();
  /** Closing agents that were dropped to keep {@link MAX_OWN_AGENTS}. */
  readonly #closing = new Set<Promise<void>>();
  #closed = false;

  /**
   * @param network From {@link resolveNetworkSettings}.
   * @param password The resolved `proxyPassword`, used when the proxy's
   *   address names a user and no password.
   */
  constructor(
    network: ResolvedNetwork,
    password?: string,
    options: OutboundOptions = {},
  ) {
    this.#proxy = network.proxy ? target(network.proxy, password) : undefined;
    this.#noProxy = network.noProxy;
    this.#options = {
      ...options,
      connectTimeoutMs: options.connectTimeoutMs ?? PROXY_CONNECT_TIMEOUT_MS,
    };
    this.#log = options.log ?? NO_LOG;
  }

  /** The proxy in effect for the daemon, its password masked; undefined for none. */
  get proxy(): string | undefined {
    return this.#proxy ? displayProxy(this.#proxy.url) : undefined;
  }

  /** Whether a request to `url` goes through the daemon's proxy. */
  proxies(url: URL | string): boolean {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return this.#routes(parsed.hostname, port(parsed));
  }

  #routes(hostname: string, portNumber: number): boolean {
    return (
      this.#proxy !== undefined &&
      !isPrivateHost(hostname) &&
      !this.#noProxy.some((entry) =>
        noProxyMatches(entry, hostname, portNumber),
      )
    );
  }

  /** {@link OutboundFetch}: the daemon's proxy, or `options.proxy` (`direct` or a provider's own). */
  readonly fetch: OutboundFetch = (input, init, options) => {
    let agent: Agent | undefined;
    try {
      agent = this.#agentFor(options?.proxy);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (!agent) return fetch(input, init);
    // Node's fetch takes an undici dispatcher; its types are undici-types'.
    return fetch(input, {
      ...init,
      dispatcher: agent,
    } as unknown as RequestInit);
  };

  #agentFor(choice: string | undefined): Agent | undefined {
    if (this.#closed) throw new Error("The outbound network is closed");
    if (choice === "direct") return undefined;
    if (choice === undefined && !this.#proxy) return undefined;
    const existing =
      choice === undefined ? this.#shared : this.#own.get(choice);
    if (existing) return existing;
    let own: ProxyTarget | undefined;
    if (choice !== undefined) {
      const parsed = parseProxyUrl(choice, "allow");
      if ("problem" in parsed)
        throw new HubError(
          "PROVIDER_INVALID",
          `The provider's proxy ${parsed.problem}`,
          400,
        );
      own = target(parsed.url);
    }
    const direct = buildConnector({
      ...(this.#options.ca ? { ca: this.#options.ca as string[] } : {}),
    });
    const timeoutMs = this.#options.connectTimeoutMs;
    const ca = this.#options.ca;
    const log = this.#log;
    const connector: buildConnector.connector = (options, callback) => {
      const host = bare(options.hostname);
      const portNumber =
        Number(options.port) || (options.protocol === "https:" ? 443 : 80);
      // A provider's own proxy leaves this computer and private networks
      // direct too: what may be sent there in plain text stays there.
      const via =
        own !== undefined
          ? isPrivateHost(host)
            ? undefined
            : own
          : this.#routes(host, portNumber)
            ? this.#proxy
            : undefined;
      if (!via) {
        direct(options, callback);
        return;
      }
      // The proxy's failures are logged in full; requests say less.
      const logged: buildConnector.Callback = (...args) => {
        if (args[0] instanceof ProxyError)
          log.info("network.proxy_failed", {
            proxy: displayProxy(via.url),
            target: authority(host, portNumber),
            message: args[0].message,
          });
        callback(...args);
      };
      openTunnel(via, host, portNumber, {
        timeoutMs,
        ...(ca ? { ca } : {}),
      }).then(
        (socket) => handOver(via, socket, options, logged, direct),
        (error: Error) => logged(error, null),
      );
    };
    const agent = new Agent({ connect: connector });
    if (choice === undefined) this.#shared = agent;
    else {
      if (this.#own.size >= MAX_OWN_AGENTS) {
        const [oldest, previous] = this.#own.entries().next().value!;
        this.#own.delete(oldest);
        const closing = finish(previous);
        this.#closing.add(closing);
        void closing.finally(() => this.#closing.delete(closing));
      }
      this.#own.set(choice, agent);
    }
    return agent;
  }

  /**
   * `environment` for a program the daemon starts that reaches the network
   * itself (npm, the Copilot host): its `*_PROXY` variables replaced by the
   * daemon's proxy, credentials included, and `NO_PROXY` naming loopback,
   * the private ranges and suffixes the daemon keeps direct, and the
   * `noProxy` hosts; without a proxy they are removed.
   */
  childEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment))
      if (value !== undefined && !/^(?:https?|all|no)_proxy$/i.test(name))
        result[name] = value;
    if (!this.#proxy) return result;
    const url = new URL(this.#proxy.url.href);
    if (this.#proxy.username !== undefined) {
      url.username = encodeURIComponent(this.#proxy.username);
      url.password = encodeURIComponent(this.#proxy.password ?? "");
    }
    const address = `${url.protocol}//${url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : ""}${url.host}`;
    const bypass = [...CHILD_NO_PROXY, ...this.#noProxy].join(",");
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
      result[name] = address;
      result[name.toLowerCase()] = address;
    }
    result.NO_PROXY = bypass;
    result.no_proxy = bypass;
    return result;
  }

  /** Close every agent: idle connections at once, requests in flight within two seconds. */
  async close(): Promise<void> {
    this.#closed = true;
    const agents = [
      ...(this.#shared ? [this.#shared] : []),
      ...this.#own.values(),
    ];
    this.#shared = undefined;
    this.#own.clear();
    await Promise.all([...agents.map(finish), ...this.#closing]);
  }
}

/**
 * Gives undici an open tunnel. Undici sets the type of service on the socket
 * of every request it writes, synchronously and outside any catch of its
 * own; on a socket the proxy reset right after its answer that fails
 * (EINVAL on macOS), and thrown from here it would be an unhandled rejection
 * that ends the daemon. So the socket is checked first, with the value
 * undici sets, which Node then does not set again: a tunnel that fails it is
 * the proxy's failure (PROXY_FAILED), not the upstream's. A throw while
 * handing over is still caught: the socket is destroyed with it, which fails
 * the request.
 */
function handOver(
  proxy: ProxyTarget,
  socket: Socket,
  options: buildConnector.Options,
  callback: buildConnector.Callback,
  direct: buildConnector.connector,
): void {
  let open = !socket.destroyed;
  if (open)
    try {
      // Node 24 has it; @types/node does not declare it yet. Undici checks too.
      (
        socket as Socket & { setTypeOfService?: (tos: number) => unknown }
      ).setTypeOfService?.(0);
    } catch {
      // The connection is gone (EINVAL after a reset); nothing else fails it.
      open = false;
    }
  if (!open) {
    socket.destroy();
    callback(
      proxyError(proxy, "closed the connection as soon as the tunnel opened"),
      null,
    );
    return;
  }
  try {
    if (options.protocol === "https:")
      direct({ ...options, httpSocket: socket }, callback);
    else callback(null, socket);
  } catch (error) {
    socket.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Close `agent`, destroying what is still in flight after two seconds. */
async function finish(agent: Agent): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), 2_000);
    timer.unref();
  });
  const result = await Promise.race([agent.close(), late]);
  clearTimeout(timer);
  if (result === "late") await agent.destroy();
}

function port(url: URL): number {
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

function target(url: URL, password?: string): ProxyTarget {
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const own = url.password ? decodeURIComponent(url.password) : undefined;
  const address = new URL(url.href);
  address.username = "";
  address.password = "";
  return {
    url: address,
    ...(username !== undefined ? { username } : {}),
    ...(username !== undefined && (own ?? password) !== undefined
      ? { password: (own ?? password)! }
      : {}),
  };
}
