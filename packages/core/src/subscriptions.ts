// SPDX-License-Identifier: MIT
/**
 * Subscription providers (ADR-P09): a provider whose credentials are the
 * user's accounts of a subscription, used only through a mechanism the
 * vendor supports for third-party apps. Each account is off until the user
 * accepts the backend's current risk notice, and it serves only agents on
 * this computer. Account records here hold no secret: tokens live in the
 * secret store under the credential's reference.
 */

/**
 * How a subscription is used. `siwc`: OpenAI's Sign in with ChatGPT for
 * open-source and locally hosted apps (a dynamically registered public
 * client, PKCE, ChatGPT plan usage on the public Responses API).
 */
export const subscriptionBackends = ["siwc"] as const;
export type SubscriptionBackend = (typeof subscriptionBackends)[number];

/** A versioned risk notice the user accepts before an account is used. */
export interface SubscriptionNotice {
  /** Changes whenever the text changes; accounts accepted an earlier version are off again. */
  version: string;
  title: string;
  text: string;
  /** Where the user reviews and limits the usage, from the vendor's own guidance. */
  manageUsageUrl: string;
}

/** The current notice per backend; the single place its text is kept. */
export const SUBSCRIPTION_NOTICES: Readonly<
  Record<SubscriptionBackend, SubscriptionNotice>
> = Object.freeze({
  siwc: Object.freeze({
    version: "siwc-2026-10-04",
    title: "Use your ChatGPT plan in HarnessHub",
    text: [
      "HarnessHub sends the model requests of your agents to OpenAI with this ChatGPT account, through OpenAI's Sign in with ChatGPT for open-source apps (a preview that OpenAI may change or end).",
      "These requests use your ChatGPT plan: they count against its usage limits, which are shared with your other apps, and OpenAI's Terms of Use and usage policies apply to them.",
      "HarnessHub uses this account only for agents on this computer, never for other machines on your network or for other people: sharing an account or its usage can break OpenAI's terms.",
      "You can review usage, set a limit for HarnessHub, or disconnect it in ChatGPT settings at any time.",
    ].join("\n"),
    manageUsageUrl: "https://chatgpt.com/settings/usage",
  }),
});

/** The user's acceptance of a notice version. */
export interface SubscriptionConsent {
  notice: string;
  acceptedAt: string;
}

/** A subscription account, as the credential it is records it (no secret). */
export interface SubscriptionAccount {
  backend: SubscriptionBackend;
  /** The vendor's stable account subject (the validated ID token's `sub`). */
  subject: string;
  /** For people to recognize the account; not an identifier. */
  email?: string;
  /** The OAuth client the vendor issued for this account on this host. */
  clientId: string;
  consent: SubscriptionConsent;
  /** Set when the user signed out: the tokens are gone, the registration stays for a later sign-in. */
  signedOutAt?: string;
}

/** Whether the account accepted the backend's current notice and is signed in. */
export function accountUsable(
  account: SubscriptionAccount | undefined,
): boolean {
  return (
    account !== undefined &&
    account.signedOutAt === undefined &&
    account.consent.notice === SUBSCRIPTION_NOTICES[account.backend].version
  );
}
