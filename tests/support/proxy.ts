// SPDX-License-Identifier: MIT
/**
 * Local proxies and TLS for outbound-proxy tests: an HTTP CONNECT proxy
 * (over TCP or TLS) and a SOCKS5 proxy that map the hosts a test names to
 * loopback servers, record every tunnel and the credentials sent, and can
 * misbehave on purpose; and a self-signed certificate made at run time, so
 * that no private key is kept in the repository.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
} from "node:http";
import {
  connect,
  createServer as createTcpServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import { createServer as createTlsServer } from "node:tls";

// --- A self-signed certificate (DER by hand: Node can sign but not issue) ---

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);

function oid(text: string): Buffer {
  const [a, b, ...rest] = text.split(".").map(Number) as [
    number,
    number,
    ...number[],
  ];
  const bytes = [a * 40 + b];
  for (const value of rest) {
    const chunk: number[] = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function name(common: string): Buffer {
  return sequence(
    tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(common)))),
  );
}

/** UTCTime, as RFC 5280 wants for dates before 2050. */
function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  return tlv(0x17, Buffer.from(text));
}

/**
 * A fresh self-signed EC P-256 certificate and key (PEM) for `names`: DNS
 * names, or IP addresses. Valid from a day ago for a year; trust it by
 * passing the certificate as `ca`.
 */
export function testCertificate(names: readonly string[]): {
  cert: string;
  key: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const ecdsaSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const altNames = sequence(
    ...names.map((entry) =>
      isIP(entry) === 4
        ? tlv(0x87, Buffer.from(entry.split(".").map(Number)))
        : tlv(0x82, Buffer.from(entry)),
    ),
  );
  const now = Date.now();
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(
      0x02,
      Buffer.from([
        0x01,
        ...Array.from({ length: 8 }, () => Math.floor(Math.random() * 256)),
      ]),
    ),
    ecdsaSha256,
    name("HarnessHub test"),
    sequence(
      utcTime(new Date(now - 86_400_000)),
      utcTime(new Date(now + 365 * 86_400_000)),
    ),
    name("HarnessHub test"),
    publicKey.export({ type: "spki", format: "der" }),
    tlv(
      0xa3,
      sequence(
        sequence(
          oid("2.5.29.19"),
          tlv(0x01, Buffer.from([0xff])),
          tlv(0x04, sequence(tlv(0x01, Buffer.from([0xff])))),
        ),
        sequence(oid("2.5.29.17"), tlv(0x04, altNames)),
      ),
    ),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(
    tbs,
    ecdsaSha256,
    tlv(0x03, Buffer.from([0]), signature),
  );
  const pem = (label: string, body: Buffer) =>
    `-----BEGIN ${label}-----\n${body.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n?$/, "\n")}-----END ${label}-----\n`;
  return {
    cert: pem("CERTIFICATE", der),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

// --- Proxies ---

/** Where a proxy sends a tunnel to `host:port`: a loopback port, or undefined to refuse. */
export type ProxyRoute = (host: string, port: number) => number | undefined;

/** How a proxy treats a tunnel request. */
export type ProxyBehaviour =
  /** Open the tunnel. */
  | "tunnel"
  /** Close the connection after reading the request, without answering. */
  | "close"
  /** Read the request and never answer. */
  | "silent";

export interface TestProxy {
  /** The proxy's address, without credentials. */
  readonly url: string;
  readonly port: number;
  /** `host:port` of every tunnel asked for, in order. */
  readonly tunnels: string[];
  /** The credentials each request carried (`user:password`), or undefined. */
  readonly credentials: (string | undefined)[];
  /** Connections accepted. */
  connections: number;
  close(): Promise<void>;
}

function track(server: Server, sockets: Set<Socket>): void {
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return address.port;
}

function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
  };
}

function pipeTo(
  port: number,
  client: Socket,
  head: Buffer,
  answer: () => void,
  refuse: () => void,
): void {
  const upstream = connect(port, "127.0.0.1", () => {
    answer();
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => refuse());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
}

/**
 * An HTTP proxy that answers only CONNECT. With `credentials`, a tunnel
 * without `Proxy-Authorization: Basic` of them gets 407. With `tls`, the
 * proxy itself speaks HTTPS.
 */
export async function startConnectProxy(options: {
  route: ProxyRoute;
  credentials?: string;
  behaviour?: ProxyBehaviour;
  tls?: { cert: string; key: string };
}): Promise<TestProxy> {
  const tunnels: string[] = [];
  const credentials: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    response.statusCode = 405;
    response.end();
  });
  const outer = options.tls
    ? createTlsServer(options.tls, (socket) =>
        server.emit("connection", socket),
      )
    : undefined;
  const state = { connections: 0 };
  (outer ?? server).on("connection", () => void state.connections++);
  server.on(
    "connect",
    (request: IncomingMessage, client: Socket, head: Buffer) => {
      const target = request.url ?? "";
      tunnels.push(target);
      const header = request.headers["proxy-authorization"];
      const sent =
        typeof header === "string" && header.startsWith("Basic ")
          ? Buffer.from(header.slice(6), "base64").toString("utf8")
          : undefined;
      credentials.push(sent);
      const behaviour = options.behaviour ?? "tunnel";
      if (behaviour === "close") return void client.destroy();
      if (behaviour === "silent") return;
      if (options.credentials !== undefined && sent !== options.credentials)
        return void client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n',
        );
      const match = /^(.*):(\d+)$/.exec(target);
      const port = match
        ? options.route(match[1]!.replace(/^\[|\]$/g, ""), Number(match[2]))
        : undefined;
      if (port === undefined)
        return void client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      pipeTo(
        port,
        client,
        head,
        () => client.write("HTTP/1.1 200 Connection Established\r\n\r\n"),
        () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
      );
    },
  );
  track(outer ?? server, sockets);
  const port = await listen(outer ?? server);
  const close = closer(outer ?? server, sockets);
  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
    port,
    tunnels,
    credentials,
    get connections() {
      return state.connections;
    },
    close,
  };
}

/** A SOCKS5 proxy (RFC 1928); with `credentials` (`user:password`) it asks for them (RFC 1929). */
export async function startSocksProxy(options: {
  route: ProxyRoute;
  credentials?: string;
}): Promise<TestProxy> {
  const tunnels: string[] = [];
  const credentials: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  const state = { connections: 0 };
  const server = createTcpServer((client) => {
    state.connections++;
    let buffered = Buffer.alloc(0);
    let step: "greeting" | "auth" | "request" = "greeting";
    let sent: string | undefined;
    const onData = (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      for (;;) {
        if (step === "greeting") {
          if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
          const methods = [...buffered.subarray(2, 2 + buffered[1]!)];
          buffered = buffered.subarray(2 + buffered[1]!);
          if (options.credentials !== undefined) {
            if (!methods.includes(2))
              return void client.end(Buffer.from([5, 0xff]));
            client.write(Buffer.from([5, 2]));
            step = "auth";
          } else {
            client.write(Buffer.from([5, 0]));
            step = "request";
          }
        } else if (step === "auth") {
          if (buffered.length < 2) return;
          const userLength = buffered[1]!;
          if (buffered.length < 3 + userLength) return;
          const passLength = buffered[2 + userLength]!;
          if (buffered.length < 3 + userLength + passLength) return;
          sent = `${buffered.subarray(2, 2 + userLength).toString()}:${buffered.subarray(3 + userLength, 3 + userLength + passLength).toString()}`;
          buffered = buffered.subarray(3 + userLength + passLength);
          if (sent !== options.credentials)
            return void client.end(Buffer.from([1, 1]));
          client.write(Buffer.from([1, 0]));
          step = "request";
        } else {
          if (buffered.length < 5) return;
          const type = buffered[3];
          const size = type === 1 ? 4 : type === 4 ? 16 : 1 + buffered[4]!;
          if (buffered.length < 4 + size + 2) return;
          const host =
            type === 1
              ? [...buffered.subarray(4, 8)].join(".")
              : type === 3
                ? buffered.subarray(5, 4 + size).toString()
                : "ipv6";
          const port = buffered.readUInt16BE(4 + size);
          const head = buffered.subarray(4 + size + 2);
          client.off("data", onData);
          tunnels.push(`${host}:${port}`);
          credentials.push(sent);
          const target = options.route(host, port);
          const reply = (code: number) =>
            Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
          if (target === undefined) return void client.end(reply(4));
          pipeTo(
            target,
            client,
            head,
            () => client.write(reply(0)),
            () => client.end(reply(5)),
          );
          return;
        }
      }
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
  track(server, sockets);
  const port = await listen(server);
  return {
    url: `socks5://127.0.0.1:${port}`,
    port,
    tunnels,
    credentials,
    get connections() {
      return state.connections;
    },
    close: closer(server, sockets),
  };
}

/**
 * A TLS server on loopback that passes each connection, decrypted, to the
 * plain HTTP server on `target`: an HTTPS upstream for a loopback fake.
 */
export async function startTlsFront(
  target: number,
  tls: { cert: string; key: string },
): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTlsServer(tls, (client) => {
    const upstream = connect(target, "127.0.0.1");
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  track(server, sockets);
  return { port: await listen(server), close: closer(server, sockets) };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server);
  server.close();
  await once(server, "close");
  return port;
}
