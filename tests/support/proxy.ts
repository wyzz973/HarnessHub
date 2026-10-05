// SPDX-License-Identifier: MIT
/**
 * The local proxies and TLS of tools/fake-proxy for outbound-proxy tests. It
 * is an uncompiled repository tool shared with the single executable's
 * command check, so it is loaded from the checkout by path, like the fake
 * provider; the interfaces are the tool's JSDoc contract.
 */

const TOOL = new URL("../../../tools/fake-proxy/index.mjs", import.meta.url);

/** Where a proxy sends a tunnel to `host:port`: a loopback port, or undefined to refuse. */
export type ProxyRoute = (host: string, port: number) => number | undefined;

/**
 * How a proxy treats a tunnel request: open it, close without answering,
 * never answer, answer that it is open and reset the connection at once,
 * or answer and reset it when the first bytes for the upstream arrive.
 */
export type ProxyBehaviour =
  "tunnel" | "close" | "silent" | "reset" | "reset-on-request";

export interface TestProxy {
  /** The proxy's address, without credentials. */
  readonly url: string;
  readonly port: number;
  /** `host:port` of every tunnel asked for, in order. */
  readonly tunnels: string[];
  /** The credentials each request carried (`user:password`), or undefined. */
  readonly credentials: (string | undefined)[];
  /** Connections accepted. */
  readonly connections: number;
  close(): Promise<void>;
}

interface ProxyModule {
  testCertificate(names: readonly string[]): { cert: string; key: string };
  startConnectProxy(options: {
    route: ProxyRoute;
    credentials?: string;
    behaviour?: ProxyBehaviour;
    tls?: { cert: string; key: string };
  }): Promise<TestProxy>;
  startSocksProxy(options: {
    route: ProxyRoute;
    credentials?: string;
    behaviour?: "tunnel" | "reset";
  }): Promise<TestProxy>;
  startTlsFront(
    target: number,
    tls: { cert: string; key: string },
  ): Promise<{ port: number; close(): Promise<void> }>;
  closedPort(): Promise<number>;
}

// The tool is plain JavaScript without declarations: `import()` of its URL is
// untyped, and the module is asserted to the members declared above.
const tool = (await import(TOOL.href)) as ProxyModule;

/** A fresh self-signed EC P-256 certificate and key (PEM) for DNS names or IPv4 addresses. */
export const testCertificate = tool.testCertificate;
/** An HTTP proxy that answers only CONNECT; 407 without `credentials`, HTTPS with `tls`. */
export const startConnectProxy = tool.startConnectProxy;
/** A SOCKS5 proxy; with `credentials` (`user:password`) it asks for them; it can reset a tunnel it opened. */
export const startSocksProxy = tool.startSocksProxy;
/** A TLS server passing each connection, decrypted, to the HTTP server on `target`. */
export const startTlsFront = tool.startTlsFront;
/** A port nothing listens on. */
export const closedPort = tool.closedPort;
