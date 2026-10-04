// SPDX-License-Identifier: MIT
/**
 * Subscription accounts (ADR-P09): signing in to ChatGPT with Sign in with
 * ChatGPT for open-source apps, signing out, and the allowance readings file.
 * The daemon owns the loopback callback listener of each sign-in attempt and
 * the account records; tokens go to the secret store only.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import type {
  CredentialId,
  ModelPlaneStore,
  ProviderConfig,
  ProviderCredential,
  ProviderId,
} from "@harnesshub/core/model-plane";
import { isProviderId } from "@harnesshub/core/model-plane";
import { isTimestamp } from "@harnesshub/core/model-plane-records";
import {
  SUBSCRIPTION_NOTICES,
  type SubscriptionAccount,
  type SubscriptionBackend,
  type SubscriptionNotice,
} from "@harnesshub/core/subscriptions";
import {
  decodeBundle,
  encodeBundle,
  pkcePair,
  randomToken,
  SIWC,
  SiwcError,
  type SiwcClient,
  type SubscriptionTokens,
} from "@harnesshub/gateway/siwc";
import type { StoredReading } from "@harnesshub/gateway/routing";
import type { ManagedSecrets } from "./http/api-v1.js";
import type {
  SignInView,
  SubscriptionAccountView,
  SubscriptionControl,
} from "./http/subscription-routes.js";

/** The provider a first ChatGPT sign-in creates when none is named. */
export const DEFAULT_SIWC_PROVIDER = "chatgpt" as ProviderId;
/** How long a sign-in attempt waits for the browser to come back. */
const ATTEMPT_MS = 10 * 60_000;
/** Finished attempts stay readable this long. */
const KEEP_FINISHED_MS = 10 * 60_000;

interface Attempt {
  view: SignInView;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The account signing in again, with its issued client ID. */
  returning?: { credential: CredentialId; clientId: string; subject: string };
  consentAt: string;
  server: Server;
  timer: NodeJS.Timeout;
}

function page(title: string, text: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui;margin:3rem"><h1>${escape(title)}</h1><p>${escape(text)}</p></body>`;
}

/**
 * Sign-in, sign-out and account listing of subscription providers. Writes
 * to providers go through `serialize`, the daemon's model-plane write queue.
 */
export class SubscriptionService implements SubscriptionControl {
  #attempts = new Map<string, Attempt>();
  #closed = false;
  constructor(
    private readonly options: {
      store: ModelPlaneStore;
      secrets: ManagedSecrets;
      environment: Readonly<NodeJS.ProcessEnv>;
      client: SiwcClient;
      tokens: SubscriptionTokens;
      /** `<dataDir>/subscriptions`: this host's SIWC host identifier lives here. */
      directory: string;
      /** The Responses base of a provider a first sign-in creates. */
      responsesBase: string;
      serialize: <T>(operation: () => Promise<T>) => Promise<T>;
      clock: () => number;
      log: LogSink;
    },
  ) {}

  notices(): ({ backend: SubscriptionBackend } & SubscriptionNotice)[] {
    return Object.entries(SUBSCRIPTION_NOTICES).map(([backend, notice]) => ({
      backend: backend as SubscriptionBackend,
      ...notice,
    }));
  }

  async accounts(): Promise<SubscriptionAccountView[]> {
    const views: SubscriptionAccountView[] = [];
    for (const provider of await this.options.store.listProviders()) {
      if (!provider.subscription) continue;
      for (const credential of provider.credentials) {
        const account = credential.account;
        if (!account) continue;
        const current =
          account.consent.notice ===
          SUBSCRIPTION_NOTICES[account.backend].version;
        views.push({
          provider: provider.id,
          credential: credential.id,
          backend: account.backend,
          ...(account.email ? { email: account.email } : {}),
          enabled: credential.enabled,
          signedIn: account.signedOutAt === undefined,
          noticeAccepted: current,
          acceptedAt: account.consent.acceptedAt,
          usable:
            credential.enabled && current && account.signedOutAt === undefined,
        });
      }
    }
    return views;
  }

  accessToken(
    provider: ProviderConfig,
    credential: ProviderCredential,
  ): Promise<string> {
    return this.options.tokens.accessToken(
      provider,
      credential,
      AbortSignal.timeout(60_000),
    );
  }

  /** This host's `ext_agent_host_id`, created and kept on first use (`urn:uuid:…`). */
  async #hostId(): Promise<string> {
    const file = path.join(this.options.directory, "siwc-host.json");
    try {
      const value = JSON.parse(await readFile(file, "utf8")) as {
        extAgentHostId?: unknown;
      };
      if (
        typeof value.extAgentHostId === "string" &&
        /^urn:uuid:[0-9a-f-]{36}$/.test(value.extAgentHostId)
      )
        return value.extAgentHostId;
    } catch {
      // Created below.
    }
    const id = `urn:uuid:${randomUUID()}`;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, extAgentHostId: id })}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, file);
    return id;
  }

  async startSignIn(input: {
    backend: SubscriptionBackend;
    provider?: string;
    credential?: string;
    acceptNotice: string;
  }): Promise<SignInView> {
    if (this.#closed)
      throw new HubError("SUBSCRIPTIONS_CLOSED", "The daemon is stopping", 503);
    const notice = SUBSCRIPTION_NOTICES[input.backend];
    if (input.acceptNotice !== notice.version)
      throw new HubError(
        "SUBSCRIPTION_NOTICE_NOT_ACCEPTED",
        `Accept the current notice (${notice.version}) to sign in; read it with hh subscription notice`,
        409,
      );
    const providerId = (input.provider ?? DEFAULT_SIWC_PROVIDER) as ProviderId;
    if (!isProviderId(providerId))
      throw new HubError("PROVIDER_ID_INVALID", "Not a provider ID", 400);
    const existing = await this.options.store.getProvider(providerId);
    if (existing && existing.subscription?.backend !== input.backend)
      throw new HubError(
        "PROVIDER_NOT_SUBSCRIPTION",
        `Provider ${providerId} is not a ChatGPT subscription provider`,
        409,
      );
    let returning: Attempt["returning"];
    let loginHint: string | undefined;
    let idTokenHint: string | undefined;
    if (input.credential !== undefined) {
      const credential = existing?.credentials.find(
        (item) => item.id === input.credential,
      );
      if (!credential?.account)
        throw new HubError(
          "CREDENTIAL_NOT_FOUND",
          `Provider ${providerId} has no account ${JSON.stringify(input.credential).slice(0, 120)}`,
          404,
        );
      returning = {
        credential: credential.id,
        clientId: credential.account.clientId,
        subject: credential.account.subject,
      };
      loginHint = credential.account.email;
      try {
        idTokenHint = decodeBundle(
          await this.options.secrets.resolve(
            credential.ref,
            this.options.environment,
          ),
        ).idToken;
      } catch {
        idTokenHint = undefined;
      }
    }
    const hostId = await this.#hostId();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const redirectUri = `http://127.0.0.1:${port}${SIWC.callbackPath}`;
    const { verifier, challenge } = pkcePair();
    const state = randomToken();
    const nonce = randomToken();
    const now = this.options.clock();
    const id = randomUUID();
    const authorizeUrl = this.options.client
      .authorizeUrl({
        ...(returning ? { clientId: returning.clientId } : {}),
        hostId,
        redirectUri,
        state,
        nonce,
        challenge,
        ...(idTokenHint ? { idTokenHint } : {}),
        ...(loginHint ? { loginHint } : {}),
      })
      .toString();
    const attempt: Attempt = {
      view: {
        id,
        backend: input.backend,
        status: "pending",
        provider: providerId,
        authorizeUrl,
        expiresAt: new Date(now + ATTEMPT_MS).toISOString(),
      },
      state,
      nonce,
      verifier,
      redirectUri,
      ...(returning ? { returning } : {}),
      consentAt: new Date(now).toISOString(),
      server,
      timer: setTimeout(
        () =>
          this.#finish(attempt, {
            error: "The sign-in was not completed in time",
          }),
        ATTEMPT_MS,
      ),
    };
    attempt.timer.unref();
    this.#attempts.set(id, attempt);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (request.method !== "GET" || url.pathname !== SIWC.callbackPath) {
        response.writeHead(404).end();
        return;
      }
      void this.#callback(attempt, url.searchParams).then(
        (message) => {
          response.writeHead(message.ok ? 200 : 400, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(page(message.title, message.text));
        },
        () => response.destroy(),
      );
    });
    return { ...attempt.view };
  }

  signIn(id: string): SignInView | undefined {
    const attempt = this.#attempts.get(id);
    return attempt && { ...attempt.view };
  }

  async #callback(
    attempt: Attempt,
    query: URLSearchParams,
  ): Promise<{ ok: boolean; title: string; text: string }> {
    if (
      attempt.view.status !== "pending" ||
      query.get("state") !== attempt.state
    )
      return {
        ok: false,
        title: "This sign-in is not pending",
        text: "Start the sign-in again from HarnessHub.",
      };
    const fail = (message: string) => {
      this.#finish(attempt, { error: message });
      return { ok: false, title: "Sign-in did not complete", text: message };
    };
    if (query.get("error"))
      return fail(
        query.get("error") === "access_denied"
          ? "ChatGPT plan use was not allowed for HarnessHub"
          : `OpenAI returned ${query.get("error")!.slice(0, 64)}`,
      );
    const code = query.get("code");
    const issued = query.get("client_id") ?? undefined;
    if (!code) return fail("OpenAI returned no authorization code");
    if (attempt.returning && issued && issued !== attempt.returning.clientId)
      return fail("OpenAI returned another client than this account's");
    const clientId = attempt.returning?.clientId ?? issued;
    if (!clientId || clientId === SIWC.registrationClient)
      return fail("OpenAI did not complete the registration of HarnessHub");
    try {
      const tokens = await this.options.client.exchange({
        clientId,
        code,
        verifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
      });
      if (!tokens.idToken) return fail("OpenAI returned no ID token");
      const identity = await this.options.client.validateIdToken(
        tokens.idToken,
        { clientId, nonce: attempt.nonce },
      );
      if (attempt.returning && identity.subject !== attempt.returning.subject)
        return fail("That is another ChatGPT account than the one signing in");
      if (!tokens.scopes.includes(SIWC.planScope))
        return fail(
          "ChatGPT plan use was not granted; sign in again and allow it to use your ChatGPT plan",
        );
      if (!tokens.refreshToken) return fail("OpenAI returned no refresh token");
      const bundle = encodeBundle({
        v: 1,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        idToken: tokens.idToken,
        scopes: tokens.scopes,
      });
      const saved = await this.#save(attempt, clientId, identity, bundle);
      this.#finish(attempt, {
        credential: saved.credential,
        ...(identity.email ? { email: identity.email } : {}),
        firstSignIn: saved.first,
      });
      return {
        ok: true,
        title: "You're using your ChatGPT plan",
        text: "Eligible usage in HarnessHub uses your ChatGPT plan. You can close this window and return to HarnessHub.",
      };
    } catch (error) {
      this.options.log.info("subscriptions.sign_in_failed", {
        backend: attempt.view.backend,
        code: error instanceof SiwcError ? error.code : "internal",
      });
      return fail(
        error instanceof SiwcError
          ? error.message
          : "The sign-in could not be saved",
      );
    }
  }

  /** Store the account: a new credential, or the returning one with new tokens and consent. */
  async #save(
    attempt: Attempt,
    clientId: string,
    identity: { subject: string; email?: string },
    bundle: string,
  ): Promise<{ credential: CredentialId; first: boolean }> {
    const { store, secrets, serialize } = this.options;
    return serialize(async () => {
      const now = new Date(this.options.clock()).toISOString();
      const providerId = attempt.view.provider as ProviderId;
      const current =
        (await store.getProvider(providerId)) ??
        this.#newProvider(providerId, now);
      const account: SubscriptionAccount = {
        backend: attempt.view.backend,
        subject: identity.subject,
        ...(identity.email ? { email: identity.email } : {}),
        clientId,
        consent: {
          notice: SUBSCRIPTION_NOTICES[attempt.view.backend].version,
          acceptedAt: attempt.consentAt,
        },
      };
      const known = current.credentials.find(
        (item) =>
          item.account?.subject === identity.subject &&
          item.account.clientId === clientId,
      );
      if (known) {
        await secrets.rotate(known.ref, bundle);
        this.options.tokens.forget(known);
        await store.putProvider({
          ...current,
          credentials: current.credentials.map((item) =>
            item === known ? { ...item, enabled: true, account } : item,
          ),
          updatedAt: now,
        });
        return { credential: known.id, first: false };
      }
      const ref = await secrets.create(bundle);
      let index = current.credentials.length + 1;
      while (current.credentials.some((item) => item.id === `account-${index}`))
        index++;
      const credential: ProviderCredential = {
        id: `account-${index}` as CredentialId,
        name: identity.email ?? identity.subject.slice(0, 200),
        ref,
        enabled: true,
        account,
      };
      try {
        await store.putProvider({
          ...current,
          credentials: [...current.credentials, credential],
          updatedAt: now,
        });
      } catch (error) {
        await secrets.delete(ref).catch(() => undefined);
        throw error;
      }
      return { credential: credential.id, first: true };
    });
  }

  #newProvider(id: ProviderId, now: string): ProviderConfig {
    return {
      schemaVersion: 1,
      id,
      name: "ChatGPT plan",
      kind: "vendor",
      endpoints: { responses: this.options.responsesBase },
      auth: { apiKeyHeader: "authorization-bearer" },
      credentials: [],
      models: { source: "live", list: [], expose: "all" },
      subscription: { backend: "siwc" },
      createdAt: now,
      updatedAt: now,
    };
  }

  #finish(
    attempt: Attempt,
    result:
      | { error: string }
      | { credential: CredentialId; email?: string; firstSignIn: boolean },
  ): void {
    if (attempt.view.status !== "pending") return;
    clearTimeout(attempt.timer);
    attempt.view =
      "error" in result
        ? { ...attempt.view, status: "failed", error: result.error }
        : {
            ...attempt.view,
            status: "succeeded",
            credential: result.credential,
            ...(result.email ? { email: result.email } : {}),
            firstSignIn: result.firstSignIn,
          };
    // The browser's own request finishes first; then the listener closes.
    attempt.server.close();
    attempt.server.closeIdleConnections();
    const expire = setTimeout(
      () => this.#attempts.delete(attempt.view.id),
      KEEP_FINISHED_MS,
    );
    expire.unref();
  }

  async revoke(credential: ProviderCredential): Promise<boolean> {
    this.options.tokens.forget(credential);
    try {
      const bundle = decodeBundle(
        await this.options.secrets.resolve(
          credential.ref,
          this.options.environment,
        ),
      );
      return bundle.refreshToken && credential.account
        ? await this.options.client.revoke({
            clientId: credential.account.clientId,
            refreshToken: bundle.refreshToken,
          })
        : true;
    } catch {
      return false;
    }
  }

  async signOut(
    providerId: string,
    credentialId: string,
  ): Promise<{ revoked: boolean }> {
    const { store, secrets, serialize } = this.options;
    return serialize(async () => {
      const provider = await store.getProvider(providerId as ProviderId);
      const credential = provider?.credentials.find(
        (item) => item.id === credentialId,
      );
      if (!provider || !credential?.account)
        throw new HubError(
          "CREDENTIAL_NOT_FOUND",
          `No subscription account ${JSON.stringify(credentialId).slice(0, 120)} of provider ${JSON.stringify(providerId).slice(0, 120)}`,
          404,
        );
      let revoked = true;
      try {
        const bundle = decodeBundle(
          await secrets.resolve(credential.ref, this.options.environment),
        );
        if (bundle.refreshToken)
          revoked = await this.options.client.revoke({
            clientId: credential.account.clientId,
            refreshToken: bundle.refreshToken,
          });
      } catch {
        revoked = false;
      }
      // The tokens go; the registration (client ID, account) stays for a later sign-in.
      await secrets.rotate(credential.ref, encodeBundle({ v: 1 }));
      this.options.tokens.forget(credential);
      await store.putProvider({
        ...provider,
        credentials: provider.credentials.map((item) =>
          item === credential
            ? {
                ...item,
                enabled: false,
                account: {
                  ...credential.account!,
                  signedOutAt: new Date(this.options.clock()).toISOString(),
                },
              }
            : item,
        ),
        updatedAt: new Date(this.options.clock()).toISOString(),
      });
      return { revoked };
    });
  }

  /** Stop every pending attempt and its listener. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const attempt of this.#attempts.values()) {
      this.#finish(attempt, { error: "The daemon stopped" });
      attempt.server.closeAllConnections();
    }
    this.#attempts.clear();
  }
}

/**
 * The allowance readings file `<dataDir>/allowance-readings.json`
 * (`{schemaVersion: 1, readings}`, mode 0600, replaced atomically). A
 * missing or invalid file loads as no readings.
 */
export function allowanceFile(dataDir: string): {
  load(): Promise<StoredReading[]>;
  save(readings: StoredReading[]): Promise<void>;
} {
  const file = path.join(dataDir, "allowance-readings.json");
  const valid = (value: unknown): value is StoredReading => {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Record<string, unknown>;
    const reading = item.reading as Record<string, unknown> | undefined;
    return (
      typeof item.provider === "string" &&
      typeof item.credential === "string" &&
      typeof reading === "object" &&
      reading !== null &&
      typeof reading.window === "string" &&
      typeof reading.usedPercent === "number" &&
      reading.usedPercent >= 0 &&
      reading.usedPercent <= 100 &&
      (reading.resetsAt === undefined || isTimestamp(reading.resetsAt)) &&
      (reading.spanSeconds === undefined ||
        (typeof reading.spanSeconds === "number" && reading.spanSeconds > 0)) &&
      isTimestamp(reading.observedAt)
    );
  };
  return {
    async load() {
      try {
        const value = JSON.parse(await readFile(file, "utf8")) as {
          schemaVersion?: unknown;
          readings?: unknown;
        };
        return value.schemaVersion === 1 && Array.isArray(value.readings)
          ? value.readings.filter(valid)
          : [];
      } catch {
        return [];
      }
    },
    async save(readings) {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, readings })}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, file);
    },
  };
}
