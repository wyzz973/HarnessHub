// SPDX-License-Identifier: MIT
/**
 * The embedded console (ADR-P10; 06-interfaces sections 1 and 6): the Vite
 * build of `@harnesshub/console` served by the daemon on its own listener,
 * so one URL gives the whole UI. The pages hold no data; everything they show
 * comes from `/api/v1` with the console session, or from the legacy `/v1`
 * routes.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isModelGatewayPath } from "./model-gateway-mount.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * The console's Content-Security-Policy: scripts, styles, fonts and requests
 * from this origin only, no inline script, no framing. Inline styles stay
 * allowed: Radix dialogs add a scroll-lock `<style>` element and the syntax
 * highlighter colors code with style attributes.
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONSOLE_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** Hashed build output under `/assets/` never changes at the same URL. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Everything else, `index.html` above all, is revalidated on every load. */
const REVALIDATE = "no-cache";

/**
 * Paths that belong to the API, the model gateway and the health checks:
 * the console never answers them, so an unknown route there keeps its own
 * 404 (06 section 1).
 */
const RESERVED =
  /^\/(?:api|v1|v1beta|v1alpha|health|healthz|readyz|metrics|openapi\.json|assets)(?:\/|$)/;

/**
 * Whether the console's page may answer this path when no route does: not
 * a reserved prefix and not a model gateway path (`/models`, `/responses`,
 * ...). The console's own page paths must all pass.
 */
export function consolePagePath(pathname: string): boolean {
  return !RESERVED.test(pathname) && !isModelGatewayPath(pathname);
}
const SERVABLE =
  /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** The built console: its directory and the files it may serve, by URL path. */
export interface ConsoleBundle {
  readonly directory: string;
  /** URL path (`/index.html`, `/assets/index-1a2b.js`) to absolute file. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * Index the built console in `directory`. Only regular files with plain
 * names are indexed, so a request can never name anything else; files are
 * read when requested.
 *
 * @returns The bundle, or undefined when the directory or its `index.html`
 *   is missing (the console was not built).
 * @throws Error when the directory exists but cannot be read.
 */
export async function loadConsole(
  directory: string,
): Promise<ConsoleBundle | undefined> {
  let entries;
  try {
    entries = await readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, file).split(path.sep).join("/");
    if (SERVABLE.test(relative)) files.set(`/${relative}`, file);
  }
  return files.has("/index.html") ? { directory, files } : undefined;
}

function contentType(file: string): string {
  return (
    CONTENT_TYPES[path.extname(file).toLowerCase()] ??
    "application/octet-stream"
  );
}

/**
 * The shape of Fastify's own 404 body, which clients of the legacy routes
 * recognize, without the URL: a path may hold a Gateway Key put where the
 * gateway does not take it from (`/K/<key>/v1/...`).
 */
function routeNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    message: `No ${request.method} route has this path`,
    error: "Not Found",
    statusCode: 404,
  });
}

/**
 * Serve the console on `server` (06 section 1):
 *
 * - `GET /` and, for `GET` or `HEAD` requests that accept `text/html`, every
 *   path no route answers, except the reserved prefixes (`/api`, `/v1`,
 *   `/v1beta`, `/v1alpha`, `/health`, `/assets`, `/openapi.json`, ...) and
 *   the model gateway's paths: `index.html`, `Cache-Control: no-cache`.
 * - `GET /assets/*`: the hashed build files, cached for a year.
 * - The other top-level files of the build (`/theme-boot.js`, `/icon.svg`):
 *   `no-cache`.
 *
 * Console responses carry `CONSOLE_CSP`, `nosniff`, `no-referrer`, `DENY`
 * framing and same-origin opener and resource policies. Any other unmatched
 * request gets the shape of Fastify's 404 body, without the URL. Without a bundle (the console was not
 * built), the page answers 503 with how to build it. The server-wide Host
 * and Origin checks apply as to every route. Must be called before the
 * server starts; it sets the server's not-found handler.
 */
export function registerConsole(
  server: FastifyInstance,
  bundle: ConsoleBundle | undefined,
): void {
  const send = async (reply: FastifyReply, url: string, cache: string) => {
    const file = bundle?.files.get(url);
    if (!file) return undefined;
    return reply
      .headers(SECURITY_HEADERS)
      .header("cache-control", cache)
      .type(contentType(file))
      .send(await readFile(file));
  };
  const page = async (reply: FastifyReply) =>
    bundle
      ? send(reply, "/index.html", REVALIDATE)
      : reply
          .code(503)
          .headers(SECURITY_HEADERS)
          .header("cache-control", "no-store")
          .type("text/plain; charset=utf-8")
          .send(
            "The HarnessHub console is not built. Run pnpm build:console, then reload.\n",
          );
  server.get("/", { schema: { hide: true } }, async (_request, reply) =>
    page(reply),
  );
  server.get<{ Params: { "*": string } }>(
    "/assets/*",
    { schema: { hide: true } },
    async (request, reply) =>
      (await send(reply, `/assets/${request.params["*"]}`, IMMUTABLE)) ??
      routeNotFound(request, reply),
  );
  for (const url of bundle?.files.keys() ?? [])
    if (!url.startsWith("/assets/") && url !== "/index.html")
      server.get(url, { schema: { hide: true } }, async (_request, reply) =>
        send(reply, url, REVALIDATE),
      );
  server.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split("?")[0]!;
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (request.headers.accept ?? "").includes("text/html") &&
      consolePagePath(pathname)
    )
      return page(reply);
    return routeNotFound(request, reply);
  });
}
