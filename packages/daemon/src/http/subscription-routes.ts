// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import type {
  ProviderConfig,
  ProviderCredential,
} from "@harnesshub/core/model-plane";
import {
  subscriptionBackends,
  type SubscriptionBackend,
  type SubscriptionNotice,
} from "@harnesshub/core/subscriptions";
import { ApiProblem } from "./api-v1.js";
import {
  credentialParams,
  emptyBodySchema,
  listOf,
  responses,
} from "./api-v1-schemas.js";

/** A sign-in attempt as `/subscriptions/sign-in` reports it. */
export interface SignInView {
  id: string;
  backend: SubscriptionBackend;
  status: "pending" | "succeeded" | "failed";
  provider: string;
  /** Open in the system browser to continue with the vendor. */
  authorizeUrl: string;
  expiresAt: string;
  /** Set once it succeeded. */
  credential?: string;
  email?: string;
  /** The account was new to this provider (not a returning sign-in). */
  firstSignIn?: boolean;
  /** Why it failed. */
  error?: string;
}

/** One subscription account, without its tokens. */
export interface SubscriptionAccountView {
  provider: string;
  credential: string;
  backend: SubscriptionBackend;
  email?: string;
  enabled: boolean;
  signedIn: boolean;
  /** The account accepted the backend's current notice. */
  noticeAccepted: boolean;
  acceptedAt: string;
  /** Enabled, signed in and accepted: the gateway may use it. */
  usable: boolean;
}

/** Subscription accounts as the API needs them (`SubscriptionService` of ../subscriptions.ts). */
export interface SubscriptionControl {
  notices(): ({ backend: SubscriptionBackend } & SubscriptionNotice)[];
  accounts(): Promise<SubscriptionAccountView[]>;
  /**
   * Start a sign-in: a loopback callback listener and the vendor's
   * authorization URL. `acceptNotice` must be the backend's current notice
   * version. A new account registers; `credential` signs an existing
   * account in again.
   *
   * @throws HubError `SUBSCRIPTION_NOTICE_NOT_ACCEPTED` (409),
   *   `PROVIDER_NOT_SUBSCRIPTION` (409), `CREDENTIAL_NOT_FOUND` (404).
   */
  startSignIn(input: {
    backend: SubscriptionBackend;
    provider?: string;
    credential?: string;
    acceptNotice: string;
  }): Promise<SignInView>;
  /** A sign-in started in the last ten minutes, or undefined. */
  signIn(id: string): SignInView | undefined;
  /**
   * End the account's renewable session with the vendor, clear its tokens,
   * and keep its registration; `revoked` is false when the vendor did not
   * confirm the revocation.
   *
   * @throws HubError `CREDENTIAL_NOT_FOUND` (404).
   */
  signOut(provider: string, credential: string): Promise<{ revoked: boolean }>;
  /**
   * End the account's session with its vendor before its credential is
   * deleted, without writing anything; false when it was not confirmed.
   * Never rejects.
   */
  revoke(credential: ProviderCredential): Promise<boolean>;
  /** A valid access token of an account, renewed if needed (for the model list). */
  accessToken(
    provider: ProviderConfig,
    credential: ProviderCredential,
  ): Promise<string>;
}

const backend = { type: "string", enum: [...subscriptionBackends] } as const;
const noticeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["backend", "version", "title", "text", "manageUsageUrl"],
  properties: {
    backend,
    version: { type: "string" },
    title: { type: "string" },
    text: { type: "string" },
    manageUsageUrl: { type: "string" },
  },
} as const;
const accountSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider",
    "credential",
    "backend",
    "enabled",
    "signedIn",
    "noticeAccepted",
    "acceptedAt",
    "usable",
  ],
  properties: {
    provider: { type: "string" },
    credential: { type: "string" },
    backend,
    email: { type: "string" },
    enabled: { type: "boolean" },
    signedIn: { type: "boolean" },
    noticeAccepted: { type: "boolean" },
    acceptedAt: { type: "string" },
    usable: { type: "boolean" },
  },
} as const;
const signInSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "backend",
    "status",
    "provider",
    "authorizeUrl",
    "expiresAt",
  ],
  properties: {
    id: { type: "string" },
    backend,
    status: { type: "string", enum: ["pending", "succeeded", "failed"] },
    provider: { type: "string" },
    authorizeUrl: { type: "string" },
    expiresAt: { type: "string" },
    credential: { type: "string" },
    email: { type: "string" },
    firstSignIn: { type: "boolean" },
    error: { type: "string" },
  },
} as const;

/**
 * `/api/v1/subscriptions/*` and account sign-out (ADR-P09): the risk
 * notices, the accounts, sign-in attempts and sign-out. Registered inside
 * the `/api/v1` plugin, so the admin token and loopback rules apply.
 */
export function registerSubscriptionRoutes(
  api: FastifyInstance,
  subscriptions: SubscriptionControl,
): void {
  api.get(
    "/subscriptions/notices",
    { schema: { response: responses(listOf(noticeSchema)) } },
    async () => ({ items: subscriptions.notices(), nextCursor: null }),
  );
  api.get(
    "/subscriptions/accounts",
    { schema: { response: responses(listOf(accountSchema)) } },
    async () => ({ items: await subscriptions.accounts(), nextCursor: null }),
  );
  api.post<{
    Body: {
      backend: SubscriptionBackend;
      provider?: string;
      credential?: string;
      acceptNotice: string;
    };
  }>(
    "/subscriptions/sign-in",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["backend", "acceptNotice"],
          properties: {
            backend,
            provider: { type: "string", minLength: 1, maxLength: 63 },
            credential: { type: "string", minLength: 1, maxLength: 200 },
            acceptNotice: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: responses(signInSchema, 202),
      },
    },
    async (request, reply) =>
      reply.code(202).send(await subscriptions.startSignIn(request.body)),
  );
  api.get<{ Params: { id: string } }>(
    "/subscriptions/sign-in/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
        },
        response: responses(signInSchema),
      },
    },
    async (request) => {
      const view = subscriptions.signIn(request.params.id);
      if (!view)
        throw new ApiProblem(
          "SIGN_IN_NOT_FOUND",
          "No sign-in of the last ten minutes has this ID",
          404,
        );
      return view;
    },
  );
  api.post<{ Params: { id: string; credentialId: string } }>(
    "/providers/:id/credentials/:credentialId/sign-out",
    {
      schema: {
        params: credentialParams,
        body: emptyBodySchema,
        response: responses({
          type: "object",
          additionalProperties: false,
          required: ["revoked"],
          properties: { revoked: { type: "boolean" } },
        }),
      },
    },
    async (request) =>
      subscriptions.signOut(request.params.id, request.params.credentialId),
  );
}
