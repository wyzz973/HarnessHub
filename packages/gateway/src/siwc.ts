// SPDX-License-Identifier: MIT
/**
 * Sign in with ChatGPT for open-source and locally hosted apps (SIWC,
 * https://developers.openai.com/siwc/token-sharing-open-source): OpenAI's own
 * flow for third-party apps to use a user's ChatGPT plan. HarnessHub is a
 * public client it registers dynamically per account and host
 * (`client_id=dynamic_agent_client` the first time, the issued client ID
 * afterwards), with PKCE and a loopback callback on 127.0.0.1. Nothing here
 * copies another client's identity. Tokens are held by the caller's secret
 * store; this module never logs them.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import type { LogSink } from "@harnesshub/core/logging";
import type {
  ProviderConfig,
  ProviderCredential,
} from "@harnesshub/core/model-plane";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type { SiwcAccount } from "@harnesshub/core/subscriptions";

/** The fixed values of the flow, from OpenAI's SIWC documentation. */
export const SIWC = Object.freeze({
  issuer: "https://auth.openai.com",
  authorizePath: "/api/accounts/authorize",
  tokenPath: "/api/accounts/oauth/token",
  revokePath: "/api/accounts/oauth/revoke",
  jwksPath: "/.well-known/jwks.json",
  /** The audience of the tokens and the base of inference and model listing. */
  resource: "https://api.openai.com/v1",
  scope:
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  /** Without this granted scope the sign-in is valid but may not use the plan. */
  planScope: "chatgpt.tokens.use.direct",
  /** The entry point of the first registration; never saved or exchanged. */
  registrationClient: "dynamic_agent_client",
  /** `agent_name_hint`, the same on every installation. */
  agentName: "HarnessHub",
  /** The loopback callback path; only its port may vary between sign-ins. */
  callbackPath: "/auth/callback",
});

/** The function tools of a SIWC Responses request, grouped in one namespace as the preview requires. */
export const SIWC_TOOL_NAMESPACE = "functions";

/** The tokens of one account, as the secret store keeps them (single-line JSON). */
export interface SiwcBundle {
  v: 1;
  refreshToken?: string;
  accessToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** Kept for `id_token_hint` on a later sign-in; dropped when the bundle would be too long. */
  idToken?: string;
  scopes?: string[];
}

/** The secret store's limit on one value. */
const SECRET_LIMIT = 8 * 1024;

/** The bundle as a secret value; the access and then the ID token are left out if it is too long. */
export function encodeBundle(bundle: SiwcBundle): string {
  let text = JSON.stringify(bundle);
  if (text.length > SECRET_LIMIT) {
    const { accessToken: _access, expiresAt: _expires, ...rest } = bundle;
    text = JSON.stringify(rest);
  }
  if (text.length > SECRET_LIMIT) {
    const {
      accessToken: _access,
      expiresAt: _expires,
      idToken: _id,
      ...rest
    } = bundle;
    text = JSON.stringify(rest);
  }
  return text;
}

/** A stored bundle; a value that is not one is treated as signed out. */
export function decodeBundle(text: string): SiwcBundle {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const raw = value as Record<string, unknown>;
      const string = (key: string) =>
        typeof raw[key] === "string" && raw[key]
          ? (raw[key] as string)
          : undefined;
      const number = (key: string) =>
        typeof raw[key] === "number" && Number.isFinite(raw[key])
          ? (raw[key] as number)
          : undefined;
      const bundle: SiwcBundle = { v: 1 };
      const refreshToken = string("refreshToken");
      const accessToken = string("accessToken");
      const idToken = string("idToken");
      const expiresAt = number("expiresAt");
      if (refreshToken) bundle.refreshToken = refreshToken;
      if (accessToken) bundle.accessToken = accessToken;
      if (idToken) bundle.idToken = idToken;
      if (expiresAt !== undefined) bundle.expiresAt = expiresAt;
      if (Array.isArray(raw.scopes))
        bundle.scopes = raw.scopes.filter(
          (scope): scope is string => typeof scope === "string",
        );
      return bundle;
    }
  } catch {
    // Not a bundle.
  }
  return { v: 1 };
}

/** The tokens a token-endpoint answer holds. */
export interface SiwcTokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

/** A failed token request; `terminal` when the account must sign in again. */
export class SiwcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly terminal: boolean,
  ) {
    super(message);
    this.name = "SiwcError";
  }
}

/** Refresh errors after which the tokens are unusable (OpenAI's "Refresh errors"). */
const TERMINAL_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

/** A PKCE verifier and its S256 challenge (RFC 7636), base64url without padding. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** A fresh random value for `state` or `nonce`. */
export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

function base64urlJson(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    ) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** What an account sign-in is given and remembers. */
export interface SiwcAuthorize {
  /** The issued client ID of an account signing in again; absent for a new registration. */
  clientId?: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  /** For a returning account. */
  idTokenHint?: string;
  loginHint?: string;
}

/**
 * The OAuth side of SIWC: authorization URLs, code exchange, refresh,
 * revocation and ID-token validation against OpenAI's published JWKS. The
 * issuer is fixed in production; tests point `issuer` at a loopback fake.
 */
export class SiwcClient {
  readonly issuer: string;
  #fetch: typeof fetch;
  #clock: () => number;
  #keys: { at: number; keys: JsonWebKey[] } | undefined;
  constructor(
    options: {
      issuer?: string;
      fetch?: typeof fetch;
      clock?: () => number;
    } = {},
  ) {
    this.issuer = (options.issuer ?? SIWC.issuer).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = options.clock ?? (() => Date.now());
  }

  /**
   * The authorization URL to open in the system browser. A new account
   * registers with `dynamic_agent_client` and `agent_name_hint`; a returning
   * one uses its issued client ID and the hints, without the name hint.
   */
  authorizeUrl(request: SiwcAuthorize): URL {
    const url = new URL(`${this.issuer}${SIWC.authorizePath}`);
    const params: Record<string, string | undefined> = {
      client_id: request.clientId ?? SIWC.registrationClient,
      agent_name_hint:
        request.clientId === undefined ? SIWC.agentName : undefined,
      ext_agent_host_id: request.hostId,
      id_token_hint: request.idTokenHint,
      login_hint: request.loginHint,
      response_type: "code",
      redirect_uri: request.redirectUri,
      scope: SIWC.scope,
      resource: SIWC.resource,
      state: request.state,
      nonce: request.nonce,
      code_challenge_method: "S256",
      code_challenge: request.challenge,
    };
    for (const [name, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(name, value);
    return url;
  }

  async #token(form: Record<string, string>): Promise<SiwcTokenSet> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.issuer}${SIWC.tokenPath}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      throw new SiwcError(
        "OpenAI's token endpoint could not be reached",
        "network_error",
        false,
      );
    }
    const text = await response.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null)
        body = parsed as Record<string, unknown>;
    } catch {
      // A body that is not JSON is reported by status only.
    }
    if (!response.ok) {
      const nested =
        typeof body.error === "object" && body.error !== null
          ? (body.error as Record<string, unknown>)
          : undefined;
      const code =
        typeof body.error === "string"
          ? body.error
          : typeof nested?.code === "string"
            ? nested.code
            : `http_${response.status}`;
      throw new SiwcError(
        `OpenAI's token endpoint refused the request (${code})`,
        code,
        TERMINAL_REFRESH.has(code),
      );
    }
    const access = body.access_token;
    const expiresIn = body.expires_in;
    if (typeof access !== "string" || !access)
      throw new SiwcError(
        "OpenAI's token endpoint answered without an access token",
        "invalid_response",
        false,
      );
    const now = this.#clock();
    return {
      accessToken: access,
      ...(typeof body.refresh_token === "string" && body.refresh_token
        ? { refreshToken: body.refresh_token }
        : {}),
      ...(typeof body.id_token === "string" && body.id_token
        ? { idToken: body.id_token }
        : {}),
      expiresAt:
        now +
        (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600) *
          1000,
      scopes:
        typeof body.scope === "string"
          ? body.scope.split(/\s+/).filter(Boolean)
          : [],
    };
  }

  /** Exchange the callback's code (no client secret: a public client). */
  exchange(request: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<SiwcTokenSet> {
    return this.#token({
      grant_type: "authorization_code",
      code: request.code,
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_verifier: request.verifier,
      resource: SIWC.resource,
    });
  }

  /** Renew with the rotating refresh token; the grant's scope is kept by omitting `scope`. */
  refresh(request: {
    clientId: string;
    refreshToken: string;
  }): Promise<SiwcTokenSet> {
    return this.#token({
      grant_type: "refresh_token",
      client_id: request.clientId,
      refresh_token: request.refreshToken,
      resource: SIWC.resource,
    });
  }

  /**
   * End the renewable session. True when OpenAI confirmed it (an empty 200,
   * also for a token that was already invalid); false when it could not be
   * confirmed.
   */
  async revoke(request: {
    clientId: string;
    refreshToken: string;
  }): Promise<boolean> {
    try {
      const response = await this.#fetch(`${this.issuer}${SIWC.revokePath}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: request.refreshToken,
          token_type_hint: "refresh_token",
          client_id: request.clientId,
        }).toString(),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  async #jwks(refresh: boolean): Promise<JsonWebKey[]> {
    const now = this.#clock();
    if (!refresh && this.#keys && now - this.#keys.at < 3_600_000)
      return this.#keys.keys;
    let keys: unknown;
    try {
      const response = await this.#fetch(`${this.issuer}${SIWC.jwksPath}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      keys = response.ok
        ? ((await response.json()) as { keys?: unknown }).keys
        : undefined;
    } catch {
      keys = undefined;
    }
    if (!Array.isArray(keys))
      throw new SiwcError(
        "OpenAI's signing keys could not be read",
        "jwks_unavailable",
        false,
      );
    this.#keys = { at: now, keys: keys as JsonWebKey[] };
    return this.#keys.keys;
  }

  /**
   * Validate an ID token as OpenAI requires: an RS256 signature by a key of
   * the issuer's JWKS, the issuer, the audience (the issued client ID), the
   * expiry and the nonce of this attempt. Returns the account identity.
   */
  async validateIdToken(
    token: string,
    expected: { clientId: string; nonce: string },
  ): Promise<{ subject: string; email?: string }> {
    const invalid = (why: string) =>
      new SiwcError(
        `The ID token is not valid: ${why}`,
        "invalid_id_token",
        true,
      );
    const parts = token.split(".");
    if (parts.length !== 3) throw invalid("malformed");
    const header = base64urlJson(parts[0]!);
    const claims = base64urlJson(parts[1]!);
    if (!header || !claims) throw invalid("malformed");
    if (header.alg !== "RS256") throw invalid("unsupported algorithm");
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2]!, "base64url");
    const check = (keys: JsonWebKey[]) =>
      keys
        .filter(
          (key) =>
            key.kty === "RSA" &&
            (kid === undefined || (key as { kid?: unknown }).kid === kid),
        )
        .some((key) => {
          try {
            return verifySignature(
              "RSA-SHA256",
              signed,
              createPublicKey({ key, format: "jwk" }),
              signature,
            );
          } catch {
            return false;
          }
        });
    // A key rotated since the last read is fetched once more.
    if (!check(await this.#jwks(false)) && !check(await this.#jwks(true)))
      throw invalid("bad signature");
    if (claims.iss !== this.issuer) throw invalid("wrong issuer");
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(expected.clientId)) throw invalid("wrong audience");
    if (
      typeof claims.exp !== "number" ||
      claims.exp * 1000 < this.#clock() - 60_000
    )
      throw invalid("expired");
    if (claims.nonce !== expected.nonce) throw invalid("wrong nonce");
    if (typeof claims.sub !== "string" || !claims.sub)
      throw invalid("no subject");
    return {
      subject: claims.sub,
      ...(typeof claims.email === "string" && claims.email
        ? { email: claims.email }
        : {}),
    };
  }
}

/**
 * Access tokens of subscription accounts for the gateway. The credential's
 * reference holds the account's token bundle.
 */
export interface SubscriptionTokens {
  /**
   * A valid access token for the account. When it is about to expire it is
   * renewed first, at most one renewal per account at a time, and the
   * rotated tokens are stored before it resolves. Rejects with a terminal
   * {@link SiwcError} when the account must sign in again (that verdict is
   * kept until the stored tokens change), otherwise with a transient one.
   * `signal` only stops this caller's wait, never a renewal in progress.
   */
  accessToken(
    provider: ProviderConfig,
    credential: ProviderCredential,
    signal: AbortSignal,
  ): Promise<string>;
  /** The account's stored tokens changed elsewhere (a sign-in or sign-out): drop what is cached. */
  forget(credential: ProviderCredential): void;
}

/** Renew this long before the access token expires. */
const RENEW_BEFORE_MS = 5 * 60_000;

/** {@link SubscriptionTokens} of SIWC accounts, kept in the daemon's secret store. */
export class SiwcTokens implements SubscriptionTokens {
  #pending = new Map<string, Promise<string>>();
  #cache = new Map<string, { token: string; expiresAt: number }>();
  /** Refresh token → the terminal error it got. */
  #dead = new Map<string, SiwcError>();
  constructor(
    private readonly options: {
      client: SiwcClient;
      read(ref: SecretReference): Promise<string>;
      write(ref: SecretReference, value: string): Promise<void>;
      clock: () => number;
      log?: LogSink;
    },
  ) {}

  forget(credential: ProviderCredential): void {
    this.#cache.delete(
      JSON.stringify([credential.ref.kind, credential.ref.value]),
    );
  }

  async accessToken(
    provider: ProviderConfig,
    credential: ProviderCredential,
    signal: AbortSignal,
  ): Promise<string> {
    const account = credential.account;
    if (account?.backend !== "siwc" || account.signedOutAt !== undefined)
      throw new SiwcError(
        `The ChatGPT account of credential ${credential.id} is signed out`,
        "signed_out",
        true,
      );
    const key = JSON.stringify([credential.ref.kind, credential.ref.value]);
    const now = this.options.clock();
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt - now > RENEW_BEFORE_MS) return cached.token;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#renew(key, provider, { ...credential, account }).finally(
        () => this.#pending.delete(key),
      );
      this.#pending.set(key, pending);
    }
    signal.throwIfAborted();
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  async #renew(
    key: string,
    provider: ProviderConfig,
    credential: ProviderCredential & { account: SiwcAccount },
  ): Promise<string> {
    const { account } = credential;
    const bundle = decodeBundle(await this.options.read(credential.ref));
    const now = this.options.clock();
    if (
      bundle.accessToken &&
      bundle.expiresAt !== undefined &&
      bundle.expiresAt - now > RENEW_BEFORE_MS
    ) {
      this.#cache.set(key, {
        token: bundle.accessToken,
        expiresAt: bundle.expiresAt,
      });
      return bundle.accessToken;
    }
    if (!bundle.refreshToken)
      throw new SiwcError(
        `The ChatGPT account of credential ${credential.id} has no tokens; sign in again`,
        "signed_out",
        true,
      );
    const dead = this.#dead.get(bundle.refreshToken);
    if (dead) throw dead;
    let tokens: SiwcTokenSet;
    try {
      tokens = await this.options.client.refresh({
        clientId: account.clientId,
        refreshToken: bundle.refreshToken,
      });
    } catch (error) {
      if (error instanceof SiwcError && error.terminal) {
        this.#dead.set(bundle.refreshToken, error);
        this.options.log?.info("gateway.subscription.sign_in_needed", {
          provider: provider.id,
          credential: credential.id,
          code: error.code,
        });
      }
      throw error;
    }
    // The access token, its expiry, the scopes and the rotated refresh token
    // are replaced together.
    await this.options.write(
      credential.ref,
      encodeBundle({
        v: 1,
        refreshToken: tokens.refreshToken ?? bundle.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        ...(bundle.idToken ? { idToken: bundle.idToken } : {}),
        scopes: tokens.scopes.length ? tokens.scopes : (bundle.scopes ?? []),
      }),
    );
    this.#cache.set(key, {
      token: tokens.accessToken,
      expiresAt: tokens.expiresAt,
    });
    return tokens.accessToken;
  }
}
