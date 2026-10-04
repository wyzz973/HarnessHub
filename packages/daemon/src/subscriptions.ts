// SPDX-License-Identifier: MIT
/**
 * Subscription accounts (ADR-P09): signing in to ChatGPT with Sign in with
 * ChatGPT for open-source apps and to GitHub Copilot with the user's
 * installed Copilot CLI, signing out, and the allowance readings file. The
 * daemon owns the loopback callback listener of each ChatGPT sign-in attempt
 * and the account records; tokens go to the secret store only.
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
  ProviderModel,
} from "@harnesshub/core/model-plane";
import { isProviderId } from "@harnesshub/core/model-plane";
import { isTimestamp } from "@harnesshub/core/model-plane-records";
import {
  SUBSCRIPTION_NOTICES,
  type CopilotAccount,
  type CopilotAuth,
  type SiwcAccount,
  type SubscriptionBackend,
  type SubscriptionNotice,
} from "@harnesshub/core/subscriptions";
import { CopilotError } from "@harnesshub/gateway/copilot";
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
import {
  encodeCopilotSecret,
  isFineGrainedToken,
  type CopilotHosts,
} from "./copilot.js";
import type { ManagedSecrets } from "./http/api-v1.js";
import { ModelListError } from "./http/model-list.js";
import type {
  CopilotSetup,
  SignInInput,
  SignInView,
  SubscriptionAccountView,
  SubscriptionControl,
} from "./http/subscription-routes.js";

/** The provider a first sign-in creates when none is named, by backend. */
export const DEFAULT_SUBSCRIPTION_PROVIDERS: Readonly<
  Record<SubscriptionBackend, ProviderId>
> = { siwc: "chatgpt" as ProviderId, copilot: "copilot" as ProviderId };
const PROVIDER_NAMES: Readonly<Record<SubscriptionBackend, string>> = {
  siwc: "ChatGPT plan",
  copilot: "GitHub Copilot",
};
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
  /** Finished Copilot sign-ins, which complete within their request. */
  #finished = new Map<string, SignInView>();
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
      /** Copilot accounts' clients; without it Copilot sign-ins fail as unavailable. */
      copilot?: CopilotHosts;
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
          ...(account.backend === "copilot"
            ? { login: account.subject, auth: account.auth }
            : {}),
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

  async listModels(
    _provider: ProviderConfig,
    credential: ProviderCredential,
  ): Promise<ProviderModel[]> {
    if (!this.options.copilot)
      throw new ModelListError(
        "Copilot accounts are not available in this daemon",
      );
    try {
      return await this.options.copilot.models(credential);
    } catch (error) {
      if (!(error instanceof CopilotError)) throw error;
      throw new ModelListError(error.message);
    }
  }

  async copilotSetup(): Promise<CopilotSetup> {
    return this.#copilot().setup();
  }

  async installCopilot(): Promise<CopilotSetup> {
    return this.#copilot().install();
  }

  #copilot(): CopilotHosts {
    if (!this.options.copilot)
      throw new HubError(
        "COPILOT_UNAVAILABLE",
        "Copilot accounts are not available in this daemon",
        503,
      );
    return this.options.copilot;
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

  async startSignIn(input: SignInInput): Promise<SignInView> {
    if (this.#closed)
      throw new HubError("SUBSCRIPTIONS_CLOSED", "The daemon is stopping", 503);
    const notice = SUBSCRIPTION_NOTICES[input.backend];
    if (input.acceptNotice !== notice.version)
      throw new HubError(
        "SUBSCRIPTION_NOTICE_NOT_ACCEPTED",
        `Accept the current notice (${notice.version}) to sign in; read it with hh subscription notice`,
        409,
      );
    if (
      input.backend !== "copilot" &&
      (input.auth ?? input.token) !== undefined
    )
      throw new HubError(
        "SIGN_IN_INVALID",
        "auth and token apply to Copilot sign-ins only",
        400,
      );
    const providerId = (input.provider ??
      DEFAULT_SUBSCRIPTION_PROVIDERS[input.backend]) as ProviderId;
    if (!isProviderId(providerId))
      throw new HubError("PROVIDER_ID_INVALID", "Not a provider ID", 400);
    const existing = await this.options.store.getProvider(providerId);
    if (existing && existing.subscription?.backend !== input.backend)
      throw new HubError(
        "PROVIDER_NOT_SUBSCRIPTION",
        `Provider ${providerId} is not a ${PROVIDER_NAMES[input.backend]} subscription provider`,
        409,
      );
    const returningCredential =
      input.credential === undefined
        ? undefined
        : existing?.credentials.find((item) => item.id === input.credential);
    if (input.credential !== undefined && !returningCredential?.account)
      throw new HubError(
        "CREDENTIAL_NOT_FOUND",
        `Provider ${providerId} has no account ${JSON.stringify(input.credential).slice(0, 120)}`,
        404,
      );
    if (input.backend === "copilot")
      return this.#copilotSignIn(input, providerId, returningCredential);
    let returning: Attempt["returning"];
    let loginHint: string | undefined;
    let idTokenHint: string | undefined;
    if (returningCredential) {
      const credential = returningCredential;
      if (credential.account?.backend !== "siwc")
        throw new HubError(
          "CREDENTIAL_NOT_FOUND",
          `Provider ${providerId} has no ChatGPT account ${credential.id}`,
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
    const view = attempt?.view ?? this.#finished.get(id);
    return view && { ...view };
  }

  /**
   * A Copilot sign-in, finished within the request: Copilot reports who the
   * user's CLI login or the given token signs in as, and the account is
   * saved. A token must be a fine-grained personal access token.
   */
  async #copilotSignIn(
    input: SignInInput,
    providerId: ProviderId,
    returning: ProviderCredential | undefined,
  ): Promise<SignInView> {
    const copilot = this.options.copilot;
    if (!copilot)
      throw new HubError(
        "COPILOT_UNAVAILABLE",
        "Copilot accounts are not available in this daemon",
        503,
      );
    const auth: CopilotAuth =
      input.auth ?? (input.token !== undefined ? "token" : "login");
    if (auth === "token" && !isFineGrainedToken(input.token ?? ""))
      throw new HubError(
        "COPILOT_TOKEN_INVALID",
        "Use a fine-grained personal access token (github_pat_...) with the Copilot Requests permission",
        400,
      );
    if (auth === "login" && input.token !== undefined)
      throw new HubError(
        "SIGN_IN_INVALID",
        "A token signs in with auth token, not login",
        400,
      );
    const previous = returning?.account;
    if (
      returning &&
      (previous?.backend !== "copilot" || previous.auth !== auth)
    )
      throw new HubError(
        "CREDENTIAL_NOT_FOUND",
        `Provider ${providerId} has no Copilot ${auth} account ${returning.id}`,
        404,
      );
    const now = this.options.clock();
    let view: SignInView = {
      id: randomUUID(),
      backend: "copilot",
      status: "pending",
      provider: providerId,
    };
    try {
      const identity = await copilot.identify(auth, input.token);
      if (previous && previous.subject !== identity.login)
        throw new CopilotError(
          "That is another GitHub account than the one signing in",
          "signed_out",
        );
      const account: CopilotAccount = {
        backend: "copilot",
        subject: identity.login,
        host: identity.host,
        auth,
        consent: {
          notice: SUBSCRIPTION_NOTICES.copilot.version,
          acceptedAt: new Date(now).toISOString(),
        },
      };
      const saved = await this.#store(
        providerId,
        "copilot",
        account,
        (item) =>
          item.account?.backend === "copilot" &&
          item.account.subject === account.subject &&
          item.account.host === account.host &&
          item.account.auth === auth,
        encodeCopilotSecret({
          v: 1,
          ...(auth === "token" ? { token: input.token! } : {}),
        }),
        identity.login,
      );
      view = {
        ...view,
        status: "succeeded",
        credential: saved.credential,
        login: identity.login,
        firstSignIn: saved.first,
      };
    } catch (error) {
      if (!(error instanceof CopilotError)) throw error;
      this.options.log.info("subscriptions.sign_in_failed", {
        backend: "copilot",
        code: error.code,
      });
      view = { ...view, status: "failed", error: error.message };
    }
    this.#finished.set(view.id, view);
    const expire = setTimeout(
      () => this.#finished.delete(view.id),
      KEEP_FINISHED_MS,
    );
    expire.unref();
    return { ...view };
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

  /** Store a ChatGPT account. */
  #save(
    attempt: Attempt,
    clientId: string,
    identity: { subject: string; email?: string },
    bundle: string,
  ): Promise<{ credential: CredentialId; first: boolean }> {
    const account: SiwcAccount = {
      backend: "siwc",
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      clientId,
      consent: {
        notice: SUBSCRIPTION_NOTICES.siwc.version,
        acceptedAt: attempt.consentAt,
      },
    };
    return this.#store(
      attempt.view.provider as ProviderId,
      "siwc",
      account,
      (item) =>
        item.account?.backend === "siwc" &&
        item.account.subject === identity.subject &&
        item.account.clientId === clientId,
      bundle,
      identity.email ?? identity.subject,
    );
  }

  /**
   * Store an account: a new credential, or the known one with its new
   * secret and consent. Creates the provider on a first sign-in.
   */
  async #store(
    providerId: ProviderId,
    backend: SubscriptionBackend,
    account: SiwcAccount | CopilotAccount,
    known: (credential: ProviderCredential) => boolean,
    secret: string,
    name: string,
  ): Promise<{ credential: CredentialId; first: boolean }> {
    const { store, secrets, serialize } = this.options;
    return serialize(async () => {
      const now = new Date(this.options.clock()).toISOString();
      const current =
        (await store.getProvider(providerId)) ??
        this.#newProvider(providerId, backend, now);
      const found = current.credentials.find(known);
      if (found) {
        await secrets.rotate(found.ref, secret);
        await this.#forget(found);
        await store.putProvider({
          ...current,
          credentials: current.credentials.map((item) =>
            item === found ? { ...item, enabled: true, account } : item,
          ),
          updatedAt: now,
        });
        return { credential: found.id, first: false };
      }
      const ref = await secrets.create(secret);
      let index = current.credentials.length + 1;
      while (current.credentials.some((item) => item.id === `account-${index}`))
        index++;
      const credential: ProviderCredential = {
        id: `account-${index}` as CredentialId,
        name: name.slice(0, 200),
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

  #newProvider(
    id: ProviderId,
    backend: SubscriptionBackend,
    now: string,
  ): ProviderConfig {
    return {
      schemaVersion: 1,
      id,
      name: PROVIDER_NAMES[backend],
      kind: "vendor",
      // Copilot answers through the user's installed client.
      endpoints:
        backend === "siwc" ? { responses: this.options.responsesBase } : {},
      auth: { apiKeyHeader: "authorization-bearer" },
      credentials: [],
      models: { source: "live", list: [], expose: "all" },
      subscription: { backend },
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Drop what is cached for an account: SIWC tokens, or its Copilot host. */
  async #forget(credential: ProviderCredential): Promise<void> {
    if (credential.account?.backend === "copilot")
      await this.options.copilot?.stop(credential);
    else this.options.tokens.forget(credential);
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
    const account = credential.account;
    try {
      await this.#forget(credential);
      // Copilot holds no session of HarnessHub's own to end.
      if (account?.backend !== "siwc") return true;
      const bundle = decodeBundle(
        await this.options.secrets.resolve(
          credential.ref,
          this.options.environment,
        ),
      );
      return bundle.refreshToken
        ? await this.options.client.revoke({
            clientId: account.clientId,
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
      const account = credential.account;
      // Copilot: the CLI's own login is the user's; a token stays valid at
      // GitHub until the user revokes it there.
      let revoked = account.backend === "siwc";
      if (account.backend === "siwc")
        try {
          const bundle = decodeBundle(
            await secrets.resolve(credential.ref, this.options.environment),
          );
          if (bundle.refreshToken)
            revoked = await this.options.client.revoke({
              clientId: account.clientId,
              refreshToken: bundle.refreshToken,
            });
        } catch {
          revoked = false;
        }
      // The tokens go; the registration (client ID, account) stays for a later sign-in.
      await secrets.rotate(
        credential.ref,
        account.backend === "siwc"
          ? encodeBundle({ v: 1 })
          : encodeCopilotSecret({ v: 1 }),
      );
      await this.#forget(credential);
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
