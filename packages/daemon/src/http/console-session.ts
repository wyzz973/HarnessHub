// SPDX-License-Identifier: MIT
/**
 * Console sign-in and the credentials of `/api/v1` (07-data-security
 * sections 5.2 and 5.3, ADR 0024). The CLI authenticates with the local
 * admin token; the console page served by this daemon never sees that
 * token: `hh console` creates a one-time login code with it, and the page
 * exchanges the code for a console session.
 *
 * A console session has two parts, both needed on every request: the
 * browser's HttpOnly `hh_console` cookie, and the tab's session token,
 * which the page keeps in `sessionStorage` (scoped to this origin, port
 * included) and sends as `X-HH-CSRF`. Browsers send a cookie to every port
 * of a host (RFC 6265 has no port scope), so another local service can
 * receive the cookie; without the token it opens nothing, and the token is
 * returned only once, by the exchange.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HubError } from "@harnesshub/core/errors";
import { noContent, responses } from "./api-v1-schemas.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route signs in to the console and is reached without a credential. */
    consoleSignIn?: boolean;
  }
}

/** The browser's cookie: `HttpOnly; SameSite=Strict; Path=/`. */
export const CONSOLE_COOKIE = "hh_console";
/** The request header carrying the tab's session token. */
export const CSRF_HEADER = "x-hh-csrf";

/** A login code is valid for 60 s and once. */
const LINK_TTL_MS = 60_000;
/** A session ends after 12 hours without a request... */
const IDLE_TIMEOUT_MS = 12 * 60 * 60_000;
/** ...and 7 days after it was created in any case. */
const LIFETIME_MS = 7 * 24 * 60 * 60_000;
/** Outstanding codes and live sessions kept; the oldest is dropped beyond. */
const MAX_LINKS = 32;
const MAX_SESSIONS = 64;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const iso = (time: number) => new Date(time).toISOString();

interface SessionRecord {
  /** SHA-256 of the browser cookie the session is bound to. */
  readonly browser: string;
  readonly createdAt: number;
  usedAt: number;
}

/** A console session's times, as `GET /auth/console-sessions/current` returns them. */
export interface ConsoleSessionView {
  expiresAt: string;
  idleExpiresAt: string;
}

/** A new session as the exchange returns it: the tab's token, once. */
export interface ConsoleSignInView extends ConsoleSessionView {
  csrfToken: string;
}

/**
 * The daemon's console login codes and sessions, in memory only: a restart
 * signs every console out. Codes, browser keys and session tokens are
 * random (128 bits for codes, 256 bits otherwise) and kept as SHA-256
 * digests. A browser key is shared by the sessions of one browser (one per
 * tab); a session is found by its token and must be presented with the
 * browser key it was created with. One instance per daemon.
 */
export class ConsoleSessions {
  readonly #links = new Map<string, number>();
  readonly #sessions = new Map<string, SessionRecord>();

  /** @param clock Milliseconds since the epoch; injected by tests. */
  constructor(private readonly clock: () => number = Date.now) {}

  #prune(now: number) {
    for (const [key, expiresAt] of this.#links)
      if (expiresAt <= now) this.#links.delete(key);
    for (const [key, session] of this.#sessions)
      if (!this.#live(session, now)) this.#sessions.delete(key);
  }

  #live(session: SessionRecord, now: number) {
    return (
      now < session.createdAt + LIFETIME_MS &&
      now < session.usedAt + IDLE_TIMEOUT_MS
    );
  }

  #view(session: SessionRecord): ConsoleSessionView {
    return {
      expiresAt: iso(session.createdAt + LIFETIME_MS),
      idleExpiresAt: iso(session.usedAt + IDLE_TIMEOUT_MS),
    };
  }

  /** A new one-time login code, valid for 60 s. */
  createLink(): { code: string; expiresAt: string } {
    const now = this.clock();
    this.#prune(now);
    if (this.#links.size >= MAX_LINKS) {
      const [oldest] = this.#links.keys();
      if (oldest !== undefined) this.#links.delete(oldest);
    }
    const code = randomBytes(16).toString("base64url");
    this.#links.set(digest(code), now + LINK_TTL_MS);
    return { code, expiresAt: iso(now + LINK_TTL_MS) };
  }

  /**
   * Consume a login code and start a session for one tab. The code is
   * spent by any attempt, so it cannot be replayed even when it had
   * expired. `browserKey` is the browser's cookie when it sent a
   * well-formed one; other sessions of that browser stay as they are.
   *
   * @returns The browser key for the cookie (the given one, or a new one),
   *   the tab's token and the session, or undefined when the code is
   *   unknown, used or expired.
   */
  exchange(
    code: string,
    browserKey?: string,
  ):
    | { browserKey: string; token: string; session: ConsoleSessionView }
    | undefined {
    const now = this.clock();
    const key = digest(code);
    const expiresAt = this.#links.get(key);
    this.#links.delete(key);
    this.#prune(now);
    if (expiresAt === undefined || expiresAt <= now) return undefined;
    if (this.#sessions.size >= MAX_SESSIONS) {
      const [oldest] = this.#sessions.keys();
      if (oldest !== undefined) this.#sessions.delete(oldest);
    }
    const browser =
      browserKey !== undefined && SECRET.test(browserKey)
        ? browserKey
        : randomBytes(32).toString("base64url");
    const token = randomBytes(32).toString("base64url");
    const session: SessionRecord = {
      browser: digest(browser),
      createdAt: now,
      usedAt: now,
    };
    this.#sessions.set(digest(token), session);
    return { browserKey: browser, token, session: this.#view(session) };
  }

  /**
   * The live session of a tab's token presented with its browser key;
   * using it restarts the idle timeout. An ended session is removed; a
   * token with another browser key, or a malformed one, gives undefined.
   */
  use(token: string, browserKey: string): ConsoleSessionView | undefined {
    if (!SECRET.test(token) || !SECRET.test(browserKey)) return undefined;
    const now = this.clock();
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (!this.#live(session, now)) {
      this.#sessions.delete(key);
      return undefined;
    }
    const presented = Buffer.from(digest(browserKey), "hex");
    const expected = Buffer.from(session.browser, "hex");
    if (!timingSafeEqual(presented, expected)) return undefined;
    session.usedAt = now;
    return this.#view(session);
  }

  /** End a tab's session at once; false when it was not live. */
  revoke(token: string): boolean {
    return this.#sessions.delete(digest(token));
  }

  /** Whether a live session still uses this browser key (its cookie is then kept). */
  bound(browserKey: string): boolean {
    const now = this.clock();
    const browser = digest(browserKey);
    for (const session of this.#sessions.values())
      if (session.browser === browser && this.#live(session, now)) return true;
    return false;
  }
}

/** How an `/api/v1` request was authenticated. */
export type ApiCredential =
  | { kind: "admin" }
  | {
      kind: "console";
      token: string;
      browserKey: string;
      session: ConsoleSessionView;
    };

const credentials = new WeakMap<FastifyRequest, ApiCredential>();

/** The credential `authenticateApiRequest` accepted for this request. */
export function requestCredential(
  request: FastifyRequest,
): ApiCredential | undefined {
  return credentials.get(request);
}

function cookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === CONSOLE_COOKIE)
      return part.slice(separator + 1).trim();
  }
  return undefined;
}

function cookie(request: FastifyRequest, value: string, maxAge: number) {
  return `${CONSOLE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${request.protocol === "https" ? "; Secure" : ""}`;
}

/**
 * Authenticate one `/api/v1` request; called by the API's `onRequest` hook
 * after the loopback check and before the route. Rules, in order:
 *
 * - `Sec-Fetch-Site`, when present, must be `same-origin` (403
 *   `LOCAL_ACCESS_REQUIRED`): pages of other origins, other ports of this
 *   host included, never reach the API, even through the address bar.
 * - Routes marked `consoleSignIn` need no credential (the code is one).
 * - `Authorization: Bearer` must carry the local admin token (401
 *   `ADMIN_TOKEN_INVALID`); a request that sends it is not looked at for a
 *   console session.
 * - Otherwise a console session needs both parts on every method, reads
 *   included: the `hh_console` cookie and the tab's token in `X-HH-CSRF`,
 *   naming a live session created with that cookie (401
 *   `CONSOLE_SESSION_INVALID`). A cookie alone, which a browser also sends
 *   to other ports of this host, or a token alone opens nothing.
 * - Without either: 401 `ADMIN_TOKEN_REQUIRED`.
 *
 * The cookie is never cleared here: it may belong to other tabs' sessions.
 * The Host and Origin checks of the whole server have already run.
 *
 * @throws HubError as listed; the reply may have gained a header.
 */
export function authenticateApiRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { adminTokenDigest: Buffer; sessions: ConsoleSessions },
): void {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin")
    throw new HubError(
      "LOCAL_ACCESS_REQUIRED",
      "The management API accepts same-origin requests only",
      403,
    );
  if (request.routeOptions.config?.consoleSignIn === true) return;
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/.exec(authorization);
    const presented = match
      ? createHash("sha256").update(match[1]!).digest()
      : undefined;
    if (!presented || !timingSafeEqual(presented, options.adminTokenDigest)) {
      reply.header("www-authenticate", 'Bearer error="invalid_token"');
      throw new HubError(
        "ADMIN_TOKEN_INVALID",
        "The admin token is not valid for this daemon",
        401,
      );
    }
    credentials.set(request, { kind: "admin" });
    return;
  }
  const browserKey = cookieValue(request.headers.cookie);
  const token = request.headers[CSRF_HEADER];
  if (browserKey === undefined && token === undefined) {
    reply.header("www-authenticate", 'Bearer realm="harnesshub"');
    throw new HubError(
      "ADMIN_TOKEN_REQUIRED",
      "Send the local admin token as a Bearer token, or open the console with hh console",
      401,
    );
  }
  const session =
    browserKey !== undefined && typeof token === "string"
      ? options.sessions.use(token, browserKey)
      : undefined;
  if (!session || browserKey === undefined || typeof token !== "string")
    throw new HubError(
      "CONSOLE_SESSION_INVALID",
      "The console session has ended or this tab has none; run hh console to sign in again",
      401,
    );
  credentials.set(request, { kind: "console", token, browserKey, session });
}

const sessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expiresAt", "idleExpiresAt"],
  properties: {
    expiresAt: { type: "string", format: "date-time" },
    idleExpiresAt: { type: "string", format: "date-time" },
  },
} as const;
const signInSchema = {
  ...sessionSchema,
  required: ["csrfToken", ...sessionSchema.required],
  properties: { csrfToken: { type: "string" }, ...sessionSchema.properties },
} as const;

function consoleSession(request: FastifyRequest) {
  const credential = requestCredential(request);
  if (credential?.kind !== "console")
    throw new HubError(
      "CONSOLE_SESSION_NOT_FOUND",
      "This request carries no console session",
      404,
    );
  return credential;
}

/**
 * Register the console sign-in routes inside the `/api/v1` plugin, whose
 * `onRequest` hook runs `authenticateApiRequest`:
 *
 * - `POST /auth/console-links` (admin token only, else 403
 *   `ADMIN_TOKEN_REQUIRED`): 201 with a one-time code.
 * - `POST /auth/console-sessions` `{code}` (no credential): 201 with the
 *   tab's token (`csrfToken`, returned only here) and the session's times,
 *   and `Set-Cookie` with the browser key (the cookie it sent, when
 *   well-formed, so other tabs' sessions go on); 401 `CONSOLE_LINK_INVALID`
 *   otherwise.
 * - `GET /auth/console-sessions/current`: the session's times; a reloaded
 *   tab checks its stored token with it.
 * - `DELETE /auth/console-sessions/current`: sign this tab out; 204, and
 *   the cookie is cleared when no other session uses it.
 *
 * The last two answer 404 `CONSOLE_SESSION_NOT_FOUND` to the admin token.
 */
export function registerConsoleSessionRoutes(
  api: FastifyInstance,
  sessions: ConsoleSessions,
): void {
  api.post(
    "/auth/console-links",
    {
      schema: {
        body: { type: "object", additionalProperties: false, properties: {} },
        response: responses(
          {
            type: "object",
            additionalProperties: false,
            required: ["code", "expiresAt"],
            properties: {
              code: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
            },
          },
          201,
        ),
      },
    },
    async (request, reply) => {
      if (requestCredential(request)?.kind !== "admin")
        throw new HubError(
          "ADMIN_TOKEN_REQUIRED",
          "Console links are created with the local admin token (hh console)",
          403,
        );
      return reply.code(201).send(sessions.createLink());
    },
  );
  api.post<{ Body: { code: string } }>(
    "/auth/console-sessions",
    {
      config: { consoleSignIn: true },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: {
            code: { type: "string", pattern: "^[A-Za-z0-9_-]{22}$" },
          },
        },
        response: responses(signInSchema, 201),
      },
    },
    async (request, reply) => {
      const created = sessions.exchange(
        request.body.code,
        cookieValue(request.headers.cookie),
      );
      if (!created)
        throw new HubError(
          "CONSOLE_LINK_INVALID",
          "The console link is unknown, used or expired; run hh console for a new one",
          401,
        );
      const signedIn: ConsoleSignInView = {
        csrfToken: created.token,
        ...created.session,
      };
      return reply
        .code(201)
        .header(
          "set-cookie",
          cookie(request, created.browserKey, Math.floor(LIFETIME_MS / 1000)),
        )
        .header("cache-control", "no-store")
        .send(signedIn);
    },
  );
  api.get(
    "/auth/console-sessions/current",
    { schema: { response: responses(sessionSchema) } },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(consoleSession(request).session),
  );
  api.delete(
    "/auth/console-sessions/current",
    { schema: { response: noContent } },
    async (request, reply) => {
      const credential = consoleSession(request);
      sessions.revoke(credential.token);
      // Other tabs of this browser may still use the cookie.
      if (!sessions.bound(credential.browserKey))
        reply.header("set-cookie", cookie(request, "", 0));
      return reply.code(204).send();
    },
  );
}
