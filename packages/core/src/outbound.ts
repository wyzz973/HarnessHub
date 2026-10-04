// SPDX-License-Identifier: MIT
/**
 * How HarnessHub's own requests leave the computer: the outbound fetch the
 * daemon hands to the gateway, the catalog refresh, subscription sign-ins,
 * sync and OTLP export, and the proxy addresses it takes. The daemon builds
 * the one fetch (`packages/daemon/src/outbound.ts`); packages that send
 * requests take it as an option and never read proxy settings themselves.
 */

/**
 * `fetch` through the daemon's proxy policy. `options.proxy` is a
 * provider's own choice ({@link ProxyChoice}); absent, the daemon's setting
 * applies. Loopback is never proxied. A failure of the proxy itself rejects
 * like a network failure, a `TypeError` whose `cause.code` is
 * {@link PROXY_FAILED}.
 */
export type OutboundFetch = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  options?: { proxy?: string },
) => Promise<Response>;

/**
 * The `code` of a fetch failure's cause when the proxy, not the upstream,
 * failed: it could not be reached, refused the tunnel (including 407 for
 * credentials), closed it, or did not answer in time.
 */
export const PROXY_FAILED = "PROXY_FAILED";

/** The cause of a fetch failure, when the proxy failed: its message names the proxy without credentials. */
export function proxyFailure(error: unknown): { message: string } | undefined {
  for (let cause = error, depth = 0; cause && depth < 4; depth++) {
    const value = cause as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (value.code === PROXY_FAILED && typeof value.message === "string")
      return { message: value.message };
    cause = value.cause;
  }
  return undefined;
}

/** The {@link OutboundFetch} options of a request made on a provider's behalf. */
export function providerProxy(provider: {
  readonly proxy?: string | undefined;
}): { proxy: string } | undefined {
  return provider.proxy === undefined ? undefined : { proxy: provider.proxy };
}

/**
 * `fetch` for requests made on a provider's behalf: through its own proxy
 * when it has one, else the daemon's.
 */
export function viaProvider(
  send: OutboundFetch,
  provider: { readonly proxy?: string | undefined },
): typeof fetch {
  const options = providerProxy(provider);
  return (input, init) => send(input, init, options);
}

/** The proxy schemes HarnessHub speaks: HTTP CONNECT, over TCP or TLS, and SOCKS5. */
export const PROXY_SCHEMES = [
  "http:",
  "https:",
  "socks5:",
  "socks5h:",
] as const;

/**
 * A provider's own proxy: `direct` for none, or a proxy address without
 * credentials (Magpie's per-provider proxy): provider records are not
 * secret.
 */
export type ProxyChoice = "direct" | (string & {});

/**
 * Reads a proxy address: `http://`, `https://`, `socks5://` or `socks5h://`
 * with a host and an optional port; a bare `host:port` is HTTP (Magpie's
 * reading). With `credentials: "refuse"` a password in the address is a
 * problem; a user name is allowed either way.
 *
 * @returns The address, or the reason it is not one.
 */
export function parseProxyUrl(
  text: string,
  credentials: "allow" | "refuse",
): { url: URL } | { problem: string } {
  const value = text.trim();
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `http://${value}`);
  } catch {
    return {
      problem:
        "must be a proxy address such as http://127.0.0.1:7890 or socks5://127.0.0.1:1080",
    };
  }
  if (!(PROXY_SCHEMES as readonly string[]).includes(url.protocol))
    return {
      problem: `must use http, https, socks5 or socks5h, not ${url.protocol.slice(0, -1)}`,
    };
  if (!url.hostname) return { problem: "must name the proxy's host" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash)
    return { problem: "must be the proxy's address alone, without a path" };
  if (credentials === "refuse" && url.password)
    return {
      problem:
        "must not hold a password; give it as a secret reference (network.proxyPassword) or in HTTPS_PROXY",
    };
  return { url };
}

/** A proxy address as logs, errors and `hh config show` print it: the password masked. */
export function displayProxy(url: URL | string): string {
  const parsed =
    typeof url === "string" ? parseProxyUrl(url, "allow") : { url };
  if (!("url" in parsed)) return "(invalid proxy address)";
  const { url: shown } = parsed;
  const user = shown.username
    ? `${shown.username}${shown.password ? ":***" : ""}@`
    : "";
  return `${shown.protocol}//${user}${shown.host}`;
}

/**
 * Checks a provider's own proxy ({@link ProxyChoice}).
 *
 * @returns The reason it is not one, or undefined.
 */
export function proxyChoiceProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "must be a string";
  if (value === "direct") return undefined;
  const parsed = parseProxyUrl(value, "allow");
  if ("problem" in parsed)
    return `must be direct or a proxy address: ${parsed.problem}`;
  if (parsed.url.username || parsed.url.password)
    return "must not hold credentials: a provider record is not secret; a proxy that needs them can only be the daemon's (network.proxy)";
  return undefined;
}
