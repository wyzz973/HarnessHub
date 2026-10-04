// SPDX-License-Identifier: MIT
/**
 * Where sync keeps its sealed file (docs/backup-sync.md): a WebDAV folder or
 * an S3-compatible bucket. Both read the file with its version and write it
 * only over the version read, so that two machines syncing at once cannot
 * overwrite each other unseen. The clients follow Magpie's
 * (yetone/magpie, MIT, internal/davsync); S3 requests are signed with AWS
 * Signature Version 4 by hand, as Magpie does, rather than with an SDK for
 * the five requests sync makes.
 */
import { createHash, createHmac } from "node:crypto";
import { HubError } from "@harnesshub/core/errors";
import { MAX_SEALED_BYTES } from "./backup-envelope.js";

/** The folder and file the sealed setup is kept in, under the address given. */
export const REMOTE_FOLDER = "harnesshub";
export const REMOTE_FILE = "harnesshub.harnesshub-backup";

/** How the server tells one version of the file from another. */
export interface RemoteVersion {
  etag?: string;
  /** Last-Modified, from a server without ETags; only for conditional reads. */
  modified?: string;
}

export type RemoteRead =
  | { status: "absent" }
  /** The file is still `have`; it was not sent again. */
  | { status: "unchanged" }
  | { status: "found"; data: Buffer; version: RemoteVersion };

/**
 * The file changed on the server since it was read: another machine wrote in
 * between. `intervening` is that machine's version when the write could not
 * be refused beforehand and was found to have followed it (an S3 server
 * without conditional writes but with versioning).
 */
export class RemoteChanged extends Error {
  constructor(readonly intervening?: { data: Buffer; version: RemoteVersion }) {
    super("The file on the server changed meanwhile");
    this.name = "RemoteChanged";
  }
}

/**
 * The server is limiting requests (HTTP 429, or 503 and S3's SlowDown):
 * `afterMs` is its Retry-After when it gave one. Code `SYNC_RATE_LIMITED`.
 */
export class RateLimited extends HubError {
  constructor(
    kind: string,
    status: number,
    readonly afterMs: number | undefined,
  ) {
    super(
      "SYNC_RATE_LIMITED",
      `The ${kind} server is limiting requests (HTTP ${status}); sync waits longer before trying again`,
      503,
    );
    this.name = "RateLimited";
  }
}

/** A failure talking to the server, with what it said; code `SYNC_REMOTE_FAILED`. */
export class RemoteError extends HubError {
  constructor(message: string) {
    super("SYNC_REMOTE_FAILED", message, 502);
    this.name = "RemoteError";
  }
}

export interface SyncRemote {
  readonly kind: "WebDAV" | "S3";
  /** Reads the file; with `have`, the version last read, only if it changed. */
  get(have: RemoteVersion, signal: AbortSignal): Promise<RemoteRead>;
  /**
   * Writes the file over the version read (`base`, its ETag), or, with none,
   * only where there is none yet.
   *
   * @throws RemoteChanged when another machine wrote in between.
   * @returns The version written, as far as the server tells it.
   */
  put(
    data: Buffer,
    base: string | undefined,
    signal: AbortSignal,
  ): Promise<RemoteVersion>;
}

/** The fetch sync uses; injectable, never the network in tests. */
export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface WebDavOptions {
  url: string;
  user?: string;
  password?: string;
  fetch?: Fetch;
}

export interface S3Options {
  /** `s3://bucket` or `s3://bucket/prefix`. */
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The server; none is AWS's own for the region. */
  endpoint?: string;
  /** Default `us-east-1`; `auto` for Cloudflare R2 endpoints. */
  region?: string;
  /** The bucket in the path rather than the host; implied for IP addresses and single-label hosts. */
  pathStyle?: boolean;
  fetch?: Fetch;
  now?: () => Date;
}

const globalFetch: Fetch = (input, init) => globalThis.fetch(input, init);

/** Reads a body up to the sealed-file limit. */
async function body(response: Response, what: string): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_SEALED_BYTES)
    throw new RemoteError(`${what} on the server is too large`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SEALED_BYTES)
    throw new RemoteError(`${what} on the server is too large`);
  return bytes;
}

/** Retry-After in milliseconds, as seconds or an HTTP date; undefined when absent. */
function retryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isInteger(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(at - now, 0) : undefined;
}

/**
 * The version an answer tells: its ETag, or a Last-Modified at least a second
 * before the server's Date, so that a write later in that same second
 * cannot go unseen.
 */
function versionOf(headers: Headers): RemoteVersion {
  const etag = headers.get("etag");
  if (etag) return { etag };
  const modified = headers.get("last-modified");
  const date = headers.get("date");
  if (modified && date && Date.parse(date) - Date.parse(modified) >= 1000)
    return { modified };
  return {};
}

function conditions(have: RemoteVersion): Record<string, string> {
  if (have.etag) return { "if-none-match": have.etag };
  if (have.modified) return { "if-modified-since": have.modified };
  return {};
}

function limited(kind: string, response: Response): void {
  if (response.status === 429 || response.status === 503)
    throw new RateLimited(
      kind,
      response.status,
      retryAfter(response.headers.get("retry-after")),
    );
}

/** A WebDAV folder: `<url>/harnesshub/harnesshub.harnesshub-backup`. */
export class WebDavRemote implements SyncRemote {
  readonly kind = "WebDAV";
  private readonly base: URL;
  /** The folder's path without a trailing slash; "" for the root. */
  private readonly folder: string;
  private readonly authorization: string | undefined;
  private readonly send: Fetch;

  /** @throws RemoteError for an address that is not http(s) without credentials. */
  constructor(options: WebDavOptions) {
    this.base = parseHttp(options.url, "WebDAV");
    this.folder = this.base.pathname.replace(/\/+$/, "");
    this.authorization =
      options.user || options.password
        ? `Basic ${Buffer.from(`${options.user ?? ""}:${options.password ?? ""}`).toString("base64")}`
        : undefined;
    this.send = options.fetch ?? globalFetch;
  }

  async get(have: RemoteVersion, signal: AbortSignal): Promise<RemoteRead> {
    const cond = conditions(have);
    const response = await this.request("GET", this.file(), signal, cond);
    if (response.status === 304 && Object.keys(cond).length) {
      await response.body?.cancel();
      return { status: "unchanged" };
    }
    // 409: the folder is not there yet (Nutstore answers so where others 404).
    if ([404, 409, 410].includes(response.status)) {
      await response.body?.cancel();
      return { status: "absent" };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new RemoteError(
        `Reading ${REMOTE_FILE} from the WebDAV server failed: HTTP ${response.status}`,
      );
    }
    return {
      status: "found",
      data: await body(response, REMOTE_FILE),
      version: versionOf(response.headers),
    };
  }

  async put(
    data: Buffer,
    base: string | undefined,
    signal: AbortSignal,
  ): Promise<RemoteVersion> {
    let match = base;
    let folderMade = false;
    // A relay that cuts a long upload short leaves a file that no longer
    // opens; the size is read back and a short write is tried again over
    // the version it left, up to three writes.
    for (let writes = 0; ;) {
      const response = await this.request(
        "PUT",
        this.file(),
        signal,
        {
          "content-type": "application/octet-stream",
          ...(match ? { "if-match": match } : { "if-none-match": "*" }),
        },
        data,
      );
      await response.body?.cancel();
      if (response.status === 412) throw new RemoteChanged();
      if ([404, 409].includes(response.status) && !folderMade) {
        await this.makeFolder(signal);
        folderMade = true;
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new RemoteError(
          `Writing ${REMOTE_FILE} to the WebDAV server failed: HTTP ${response.status}`,
        );
      writes += 1;
      const written = response.headers.get("etag") ?? undefined;
      const head = await this.request("HEAD", this.file(), signal, {});
      await head.body?.cancel();
      const kept = Number(head.headers.get("content-length") ?? "-1");
      if (head.status !== 200 || kept < 0 || kept >= data.length)
        return written ? { etag: written } : {};
      if (writes >= 3)
        throw new RemoteError(
          `The WebDAV server kept ${kept} of ${data.length} bytes of ${REMOTE_FILE}: the write was cut short`,
        );
      match = written ?? head.headers.get("etag") ?? undefined;
    }
  }

  private async makeFolder(signal: AbortSignal): Promise<void> {
    const response = await this.request(
      "MKCOL",
      this.at(`${REMOTE_FOLDER}/`),
      signal,
      {},
    );
    await response.body?.cancel();
    // 405: it is there already.
    if (response.status >= 300 && response.status !== 405)
      throw new RemoteError(
        response.status === 409
          ? `There is no folder ${this.folder || "/"} on the WebDAV server: make it first, or leave it out of the address`
          : `Making the folder ${REMOTE_FOLDER} on the WebDAV server failed: HTTP ${response.status}`,
      );
  }

  private file(): URL {
    return this.at(`${REMOTE_FOLDER}/${REMOTE_FILE}`);
  }

  /** `path` under the folder of the address. */
  private at(path: string): URL {
    const url = new URL(this.base.href);
    url.pathname = `${this.folder}/${path}`;
    return url;
  }

  private async request(
    method: string,
    url: URL,
    signal: AbortSignal,
    headers: Record<string, string>,
    data?: Buffer,
  ): Promise<Response> {
    const response = await this.send(url, {
      method,
      headers: {
        ...headers,
        ...(this.authorization ? { authorization: this.authorization } : {}),
      },
      ...(data ? { body: new Uint8Array(data) } : {}),
      signal,
      redirect: "manual",
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new RemoteError(
        "The WebDAV server refused the user name or password (HTTP 401)",
      );
    }
    if (response.status === 403) {
      await response.body?.cancel();
      throw new RemoteError(
        `The WebDAV server does not let this account use ${this.folder || "/"} (HTTP 403): the folder may not be there, or the account may not write in it`,
      );
    }
    limited("WebDAV", response);
    return response;
  }
}

/** An S3-compatible bucket: `<prefix>/harnesshub/harnesshub.harnesshub-backup`. */
export class S3Remote implements SyncRemote {
  readonly kind = "S3";
  private readonly endpoint: URL;
  /** A path the server is under, without a trailing slash; "" for none. */
  private readonly root: string;
  private readonly bucket: string;
  private readonly key: string;
  private readonly pathStyle: boolean;
  private readonly signer: SigV4Credentials;
  private readonly send: Fetch;
  private readonly now: () => Date;
  /** Set once the server refused a conditional write as unsupported. */
  private unconditional = false;

  /** @throws RemoteError for an address or endpoint that cannot be used. */
  constructor(options: S3Options) {
    const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(\/.*)?$/i.exec(
      options.url.trim(),
    );
    if (!match)
      throw new RemoteError(
        `${JSON.stringify(options.url.slice(0, 200))} is not an S3 address (s3://bucket or s3://bucket/prefix)`,
      );
    this.bucket = match[1]!;
    const prefix = (match[2] ?? "").replace(/^\/+|\/+$/g, "");
    this.key = [prefix, REMOTE_FOLDER, REMOTE_FILE].filter(Boolean).join("/");
    const endpointText = options.endpoint?.trim()
      ? options.endpoint.includes("://")
        ? options.endpoint.trim()
        : `https://${options.endpoint.trim()}`
      : "";
    const region =
      options.region?.trim() ||
      (/\.r2\.cloudflarestorage\.com$/i.test(
        endpointText ? new URL(endpointText).hostname : "",
      )
        ? "auto"
        : "us-east-1");
    this.endpoint = parseHttp(
      endpointText || `https://s3.${region}.amazonaws.com`,
      "S3 endpoint",
    );
    this.root = this.endpoint.pathname.replace(/\/+$/, "");
    const host = this.endpoint.hostname;
    // A bucket cannot go before an address or a single-label host, nor one
    // with a dot before a certificate for *.host: it goes in the path then.
    this.pathStyle =
      options.pathStyle === true ||
      /^[\d.]+$/.test(host) ||
      host.includes(":") ||
      !host.includes(".") ||
      (this.endpoint.protocol === "https:" && this.bucket.includes("."));
    this.signer = {
      accessKeyId: options.accessKeyId.trim(),
      secretAccessKey: options.secretAccessKey,
      region,
      service: "s3",
    };
    this.send = options.fetch ?? globalFetch;
    this.now = options.now ?? (() => new Date());
  }

  async get(have: RemoteVersion, signal: AbortSignal): Promise<RemoteRead> {
    const cond = conditions(have);
    const response = await this.request("GET", this.objectUrl(), signal, cond);
    if (response.status === 304 && Object.keys(cond).length) {
      await response.body?.cancel();
      return { status: "unchanged" };
    }
    if (response.status !== 200) {
      const error = await s3Error(response);
      if (response.status === 404 && error.code !== "NoSuchBucket")
        return { status: "absent" };
      throw this.explain("read", response.status, error);
    }
    return {
      status: "found",
      data: await body(response, REMOTE_FILE),
      version: versionOf(response.headers),
    };
  }

  async put(
    data: Buffer,
    base: string | undefined,
    signal: AbortSignal,
  ): Promise<RemoteVersion> {
    if (!this.unconditional) {
      const response = await this.request(
        "PUT",
        this.objectUrl(),
        signal,
        {
          "content-type": "application/octet-stream",
          ...(base ? { "if-match": base } : { "if-none-match": "*" }),
        },
        data,
      );
      if (response.status >= 200 && response.status < 300) {
        await response.body?.cancel();
        return etagOf(response);
      }
      const error = await s3Error(response);
      // 409 ConditionalRequestConflict: AWS's for two conditional writes at once.
      if (
        response.status === 412 ||
        error.code === "ConditionalRequestConflict"
      )
        throw new RemoteChanged();
      if (!noConditions(response.status, error))
        throw this.explain("write", response.status, error);
      this.unconditional = true;
    }
    return this.putUnconditional(data, base, signal);
  }

  /**
   * A server without conditional writes (an older MinIO, Ceph or Garage, many
   * a NAS): the ETag is compared just before an unconditional PUT. When the
   * bucket keeps versions, the version before the one written is compared
   * as well afterwards, which also catches a write in the moment between.
   */
  private async putUnconditional(
    data: Buffer,
    base: string | undefined,
    signal: AbortSignal,
  ): Promise<RemoteVersion> {
    const head = await this.request("HEAD", this.objectUrl(), signal, {});
    await head.body?.cancel();
    if (head.status !== 200 && head.status !== 404)
      throw this.explain("read", head.status, {});
    const current = head.status === 200 ? head.headers.get("etag") : null;
    if ((current === null) !== (base === undefined)) throw new RemoteChanged();
    if (current !== null && bareEtag(current) !== bareEtag(base!))
      throw new RemoteChanged();
    const response = await this.request(
      "PUT",
      this.objectUrl(),
      signal,
      { "content-type": "application/octet-stream" },
      data,
    );
    if (response.status < 200 || response.status >= 300)
      throw this.explain("write", response.status, await s3Error(response));
    await response.body?.cancel();
    const written = etagOf(response);
    const versionId = response.headers.get("x-amz-version-id");
    if (versionId && versionId !== "null") {
      const previous = await this.previousVersion(versionId, signal);
      const expected = base === undefined ? undefined : bareEtag(base);
      if (previous && previous.etag !== expected) {
        const read = await this.request(
          "GET",
          this.objectUrl({ versionId: previous.versionId }),
          signal,
          {},
        );
        if (read.status !== 200)
          throw this.explain("read", read.status, await s3Error(read));
        throw new RemoteChanged({
          data: await body(read, REMOTE_FILE),
          version: written,
        });
      }
    }
    return written;
  }

  /** The version listed right before `versionId`, newest first; none when it is the first. */
  private async previousVersion(
    versionId: string,
    signal: AbortSignal,
  ): Promise<{ versionId: string; etag: string } | undefined> {
    const response = await this.request(
      "GET",
      this.bucketUrl({ versions: "", prefix: this.key, "max-keys": "10" }),
      signal,
      {},
    );
    if (response.status !== 200)
      throw this.explain("read", response.status, await s3Error(response));
    const xml = await response.text();
    const versions = [...xml.matchAll(/<Version>([\s\S]*?)<\/Version>/g)]
      .map((entry) => ({
        key: tag(entry[1]!, "Key"),
        versionId: tag(entry[1]!, "VersionId") ?? "",
        etag: bareEtag(decodeXml(tag(entry[1]!, "ETag") ?? "")),
      }))
      .filter((entry) => entry.key === this.key);
    const index = versions.findIndex((entry) => entry.versionId === versionId);
    return index >= 0 ? versions[index + 1] : undefined;
  }

  private objectUrl(query: Record<string, string> = {}): URL {
    return this.url(`/${this.key}`, query);
  }

  private bucketUrl(query: Record<string, string>): URL {
    return this.url("/", query);
  }

  private url(path: string, query: Record<string, string>): URL {
    const url = new URL(this.endpoint.href);
    const prefix = this.root;
    if (this.pathStyle)
      url.pathname = awsEscape(
        `${prefix}/${this.bucket}${path === "/" ? "" : path}`,
        true,
      );
    else {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = awsEscape(`${prefix}${path}`, true);
    }
    url.search = Object.entries(query)
      .map(
        ([name, value]) =>
          `${awsEscape(name, false)}=${awsEscape(value, false)}`,
      )
      .join("&");
    return url;
  }

  private async request(
    method: string,
    url: URL,
    signal: AbortSignal,
    headers: Record<string, string>,
    data?: Buffer,
  ): Promise<Response> {
    const payload = sha256Hex(data ?? Buffer.alloc(0));
    const signed = signV4(
      this.signer,
      method,
      url,
      { ...headers, "x-amz-content-sha256": payload },
      payload,
      this.now(),
    );
    const response = await this.send(url, {
      method,
      headers: signed,
      ...(data ? { body: new Uint8Array(data) } : {}),
      signal,
      redirect: "manual",
    });
    return response;
  }

  private explain(
    operation: "read" | "write",
    status: number,
    error: { code?: string; message?: string; region?: string; after?: number },
  ): HubError {
    const where = `${this.bucket}/${this.key} at ${this.endpoint.host}`;
    if (status === 429 || status === 503 || error.code === "SlowDown")
      return new RateLimited("S3", status, error.after);
    if (
      error.code === "InvalidAccessKeyId" ||
      error.code === "SignatureDoesNotMatch" ||
      status === 401
    )
      return new RemoteError(
        `The S3 server refused the access key ID or secret (HTTP ${status} ${error.code ?? ""})`.trim(),
      );
    if (error.code === "RequestTimeTooSkewed")
      return new RemoteError(
        "The S3 server says this computer's clock is off; set it right and sync again",
      );
    if (error.region && error.region !== this.signer.region)
      return new RemoteError(
        `The bucket ${this.bucket} is in the region ${error.region}, not ${this.signer.region}: set region=${error.region}`,
      );
    if (error.code === "NoSuchBucket")
      return new RemoteError(
        `There is no bucket ${this.bucket} at ${this.endpoint.host}; make it first`,
      );
    if (status === 403)
      return new RemoteError(
        `The S3 server does not let this access key ${operation} ${where} (HTTP 403)`,
      );
    return new RemoteError(
      `${operation === "read" ? "Reading" : "Writing"} ${where} failed: HTTP ${status}${error.code ? ` ${error.code}` : ""}`,
    );
  }
}

function parseHttp(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new RemoteError(
      `${JSON.stringify(text.slice(0, 200))} is not a ${what} address (https://…)`,
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RemoteError(
      `The ${what} address must be http(s) without credentials, query or fragment`,
    );
  return url;
}

function etagOf(response: Response): RemoteVersion {
  const etag = response.headers.get("etag");
  return etag ? { etag } : {};
}

function bareEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** An answer to a conditional PUT saying the server does not do them. */
function noConditions(
  status: number,
  error: { code?: string; message?: string },
): boolean {
  if (status === 501 || error.code === "NotImplemented") return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    status === 400 &&
    ["if-match", "if-none-match", "conditional"].some((word) =>
      message.includes(word),
    )
  );
}

async function s3Error(response: Response): Promise<{
  code?: string;
  message?: string;
  region?: string;
  after?: number;
}> {
  const text = response.status === 304 ? "" : await response.text();
  const code = tag(text, "Code");
  const message = tag(text, "Message");
  const region =
    tag(text, "Region") ??
    response.headers.get("x-amz-bucket-region") ??
    undefined;
  const after = retryAfter(response.headers.get("retry-after"));
  return {
    ...(code ? { code } : {}),
    ...(message ? { message: decodeXml(message) } : {}),
    ...(region ? { region } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

function decodeXml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Credentials and scope of AWS Signature Version 4. */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Signs a request with AWS Signature Version 4: returns `headers` with
 * `x-amz-date` and `authorization` added, signed over every header given and
 * the URL's host. `url` must already carry its path escaped as `awsEscape`
 * does; `payload` is the body's SHA-256 in hex.
 */
export function signV4(
  credentials: SigV4Credentials,
  method: string,
  url: URL,
  headers: Readonly<Record<string, string>>,
  payload: string,
  at: Date,
): Record<string, string> {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const all: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries({
    ...headers,
    "x-amz-date": stamp,
  }))
    all[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  const names = Object.keys(all).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${all[name]}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const query = [...url.searchParams.entries()]
    .map(
      ([name, value]) => `${awsEscape(name, false)}=${awsEscape(value, false)}`,
    )
    .sort()
    .join("&");
  const request = [
    method,
    url.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    payload,
  ].join("\n");
  const scope = `${day}/${credentials.region}/${credentials.service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256Hex(request)}`;
  let key: Buffer = Buffer.from(`AWS4${credentials.secretAccessKey}`);
  for (const part of [
    day,
    credentials.region,
    credentials.service,
    "aws4_request",
  ])
    key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const result: Record<string, string> = { ...headers, "x-amz-date": stamp };
  result.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return result;
}

/**
 * URI encoding as SigV4 has it: every byte but A-Z a-z 0-9 - _ . ~ as %XX in
 * upper case, and `/` kept in a path.
 */
export function awsEscape(text: string, path: boolean): string {
  let result = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const character = String.fromCharCode(byte);
    result +=
      /[A-Za-z0-9\-_.~]/.test(character) || (path && character === "/")
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}
