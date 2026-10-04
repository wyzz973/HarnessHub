// SPDX-License-Identifier: MIT
/**
 * Loopback WebDAV and S3-compatible servers for sync tests. They keep
 * objects in memory, answer conditional reads and writes as the protocols
 * define them, and record each request's method, path and status. The S3
 * server checks every request's AWS Signature Version 4 from the bytes it
 * received, independently of the client's signer. `beforeWrite` runs before
 * a PUT is applied, so a test can let another machine write in between a
 * read and a write.
 */
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface StoredObject {
  data: Buffer;
  etag: string;
  versionId: string;
}

export interface FakeStorage {
  /** Origin, `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The current object at a path (WebDAV) or key (S3). */
  object(key: string): StoredObject | undefined;
  /** Every request so far: method, path with query, status. */
  readonly requests: Array<{ method: string; path: string; status: number }>;
  /** Runs once before the next PUT of `key` is applied. */
  beforeWrite(key: string, action: () => Promise<void>): void;
  close(): Promise<void>;
}

interface Base {
  objects: Map<string, StoredObject[]>;
  hooks: Map<string, () => Promise<void>>;
  requests: FakeStorage["requests"];
  counter: number;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function current(base: Base, key: string): StoredObject | undefined {
  return base.objects.get(key)?.at(-1);
}

function store(base: Base, key: string, data: Buffer): StoredObject {
  base.counter += 1;
  const stored = {
    data,
    etag: `"${createHash("md5").update(data).digest("hex")}-${base.counter}"`,
    versionId: `v${base.counter}`,
  };
  base.objects.set(key, [...(base.objects.get(key) ?? []), stored]);
  return stored;
}

/** Whether the precondition headers allow a write over `existing`. */
function writable(
  request: IncomingMessage,
  existing: StoredObject | undefined,
): boolean {
  const match = request.headers["if-match"];
  const none = request.headers["if-none-match"];
  if (match !== undefined && match !== existing?.etag) return false;
  if (none === "*" && existing) return false;
  return true;
}

async function serve(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    base: Base,
  ) => Promise<void>,
): Promise<FakeStorage> {
  const base: Base = {
    objects: new Map(),
    hooks: new Map(),
    requests: [],
    counter: 0,
  };
  const server = createServer((request, response) => {
    response.on("finish", () =>
      base.requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        status: response.statusCode,
      }),
    );
    handler(request, response, base).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    object: (key) => current(base, key),
    requests: base.requests,
    beforeWrite: (key, action) => void base.hooks.set(key, action),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function runHook(base: Base, key: string): Promise<void> {
  const hook = base.hooks.get(key);
  if (hook) {
    base.hooks.delete(key);
    await hook();
  }
}

/**
 * A WebDAV server under `/dav`: Basic auth with `user`/`password`, MKCOL for
 * collections, GET/HEAD with If-None-Match, PUT with If-Match or
 * If-None-Match: `*` (412 when they fail, 409 when the collection is missing).
 */
export function startFakeWebDav(options: {
  user: string;
  password: string;
}): Promise<FakeStorage> {
  const collections = new Set(["/dav"]);
  const expected = `Basic ${Buffer.from(`${options.user}:${options.password}`).toString("base64")}`;
  return serve(async (request, response, base) => {
    const data = await body(request);
    const key = decodeURIComponent(new URL(request.url!, "http://x").pathname);
    if (request.headers.authorization !== expected) {
      response.statusCode = 401;
      response.end();
      return;
    }
    const existing = current(base, key);
    switch (request.method) {
      case "MKCOL": {
        const folder = key.replace(/\/+$/, "");
        response.statusCode = collections.has(folder) ? 405 : 201;
        collections.add(folder);
        response.end();
        return;
      }
      case "GET":
      case "HEAD": {
        if (!existing) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader("etag", existing.etag);
        if (request.headers["if-none-match"] === existing.etag) {
          response.statusCode = 304;
          response.end();
          return;
        }
        response.setHeader("content-length", existing.data.length);
        response.end(request.method === "GET" ? existing.data : undefined);
        return;
      }
      case "PUT": {
        if (!collections.has(key.slice(0, key.lastIndexOf("/")))) {
          response.statusCode = 409;
          response.end();
          return;
        }
        await runHook(base, key);
        if (!writable(request, current(base, key))) {
          response.statusCode = 412;
          response.end();
          return;
        }
        const stored = store(base, key, data);
        response.statusCode = existing ? 204 : 201;
        response.setHeader("etag", stored.etag);
        response.end();
        return;
      }
      default:
        response.statusCode = 405;
        response.end();
    }
  });
}

/**
 * An S3-compatible server with path-style addressing (`/bucket/key`). Every
 * request must carry a valid SigV4 signature for `accessKeyId` and
 * `secretAccessKey` and an `x-amz-content-sha256` matching its body.
 * `conditional: false` answers a conditional PUT with 501 NotImplemented, as
 * servers without conditional writes do; `versioning` keeps every version,
 * answers PUT with `x-amz-version-id`, `GET ?versionId=` and `?versions`.
 */
export function startFakeS3(options: {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  conditional: boolean;
  versioning: boolean;
}): Promise<FakeStorage> {
  return serve(async (request, response, base) => {
    const data = await body(request);
    const url = new URL(request.url!, "http://x");
    const error = (status: number, code: string) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/xml");
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      );
    };
    if (
      request.headers["x-amz-content-sha256"] !==
      createHash("sha256").update(data).digest("hex")
    )
      return error(400, "XAmzContentSHA256Mismatch");
    if (!signatureValid(request, options))
      return error(403, "SignatureDoesNotMatch");
    const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (bucket !== options.bucket) return error(404, "NoSuchBucket");
    const key = rest.join("/");
    if (!key && request.method === "GET" && url.searchParams.has("versions")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const versions = [...base.objects.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .flatMap(([name, list]) =>
          [...list]
            .reverse()
            .map(
              (item, index) =>
                `<Version><Key>${name}</Key><VersionId>${item.versionId}</VersionId><IsLatest>${index === 0}</IsLatest><ETag>${item.etag.replaceAll('"', "&quot;")}</ETag></Version>`,
            ),
        );
      response.setHeader("content-type", "application/xml");
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult>${versions.join("")}</ListVersionsResult>`,
      );
      return;
    }
    const versionId = url.searchParams.get("versionId");
    const existing = versionId
      ? base.objects.get(key)?.find((item) => item.versionId === versionId)
      : current(base, key);
    switch (request.method) {
      case "GET":
      case "HEAD": {
        if (!existing) {
          if (request.method === "HEAD") {
            response.statusCode = 404;
            response.end();
            return;
          }
          return error(404, "NoSuchKey");
        }
        response.setHeader("etag", existing.etag);
        if (request.headers["if-none-match"] === existing.etag) {
          response.statusCode = 304;
          response.end();
          return;
        }
        response.setHeader("content-length", existing.data.length);
        response.end(request.method === "GET" ? existing.data : undefined);
        return;
      }
      case "PUT": {
        const conditionalWrite =
          request.headers["if-match"] !== undefined ||
          request.headers["if-none-match"] !== undefined;
        if (conditionalWrite && !options.conditional)
          return error(501, "NotImplemented");
        await runHook(base, key);
        if (!writable(request, current(base, key)))
          return error(412, "PreconditionFailed");
        if (!options.versioning) base.objects.delete(key);
        const stored = store(base, key, data);
        response.setHeader("etag", stored.etag);
        if (options.versioning)
          response.setHeader("x-amz-version-id", stored.versionId);
        response.end();
        return;
      }
      default:
        return error(405, "MethodNotAllowed");
    }
  });
}

/** Checks the SigV4 Authorization header against the request as received. */
function signatureValid(
  request: IncomingMessage,
  options: { accessKeyId: string; secretAccessKey: string; region: string },
): boolean {
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      request.headers.authorization ?? "",
    );
  if (!match || match[1] !== options.accessKeyId || match[3] !== options.region)
    return false;
  const [, , day, region, signed, signature] = match;
  const names = signed!.split(";");
  if (!names.includes("host") || !names.includes("x-amz-date")) return false;
  const raw = request.url!;
  const question = raw.indexOf("?");
  const path = question < 0 ? raw : raw.slice(0, question);
  const escape = (text: string) =>
    encodeURIComponent(text).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const query =
    question < 0
      ? ""
      : raw
          .slice(question + 1)
          .split("&")
          .filter(Boolean)
          .map((pair) => {
            const [name, value = ""] = pair.split("=");
            return `${escape(decodeURIComponent(name!))}=${escape(decodeURIComponent(value))}`;
          })
          .sort()
          .join("&");
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value.join(",") : (value ?? ""))
      .trim()
      .replace(/\s+/g, " ");
  };
  const canonical = [
    request.method,
    path,
    query,
    names.map((name) => `${name}:${header(name)}\n`).join(""),
    signed,
    header("x-amz-content-sha256"),
  ].join("\n");
  const stamp = header("x-amz-date");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  let key: Buffer = Buffer.from(`AWS4${options.secretAccessKey}`);
  for (const part of [day!, region!, "s3", "aws4_request"])
    key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(toSign).digest("hex") === signature;
}
