// SPDX-License-Identifier: MIT
/**
 * The console session (07-data-security section 5.2, ADR 0024). `hh
 * console` opens `/#login=<code>`; the page removes the code from the
 * address bar at once and exchanges it for a session: the browser keeps an
 * HttpOnly cookie, and this tab keeps the session's token in
 * `sessionStorage` (this origin and port only, this tab only, kept across
 * reloads) and sends it as `X-HH-CSRF` with every `/api/v1` request. The
 * daemon needs both, so a cookie that reaches another port of this host
 * opens nothing. Each tab signs in with its own link; tabs do not end each
 * other's sessions. The admin token never reaches the browser.
 */
import { useSyncExternalStore } from "react";
import {
  HarnessHubClient,
  HarnessHubError,
  type ConsoleSessionStatus,
} from "@harnesshub/sdk/client";
import { t } from "./i18n";

/** The signed-in tab's session: its token and the session's times. */
export interface TabSession extends ConsoleSessionStatus {
  token: string;
}

export type SessionState =
  | { status: "checking" }
  | { status: "signed-in"; session: TabSession }
  | {
      status: "signed-out";
      /** Why: no session in this tab, an unusable link, an ended session, or sign-out. */
      reason: "none" | "invalid-link" | "ended" | "signed-out";
    }
  | { status: "failed"; message: string };

const TOKEN_KEY = "harnesshub.console.session";

let state: SessionState = { status: "checking" };
let client: HarnessHubClient | undefined;
/** The token when this browser keeps no session storage: this page only. */
let unstored: string | undefined;
const listeners = new Set<() => void>();

function set(next: SessionState) {
  state = next;
  client = undefined;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storedToken(): string | undefined {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? unstored;
  } catch {
    return unstored;
  }
}
function storeToken(token: string | undefined) {
  unstored = token;
  try {
    if (token === undefined) window.sessionStorage.removeItem(TOKEN_KEY);
    else window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Without session storage the token lasts for this page only.
  }
}

/** A client of `token`'s session, or without one for signing in. */
function sessionClient(token?: string) {
  return new HarnessHubClient({
    url: window.location.origin,
    ...(token !== undefined ? { csrfToken: token } : {}),
    fetch: transport,
  });
}

/**
 * The SDK's transport. A 401 means this tab's session is gone (ended,
 * signed out elsewhere, or the daemon restarted): the token is dropped and
 * the page shows how to sign in again.
 */
const transport: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401 && state.status === "signed-in") {
    storeToken(undefined);
    set({ status: "signed-out", reason: "ended" });
  }
  return response;
};

/**
 * The SDK client of the signed-in session, for `/api/v1`.
 *
 * @throws Error when no session is signed in; the console renders its pages
 *   only after sign-in.
 */
export function apiClient(): HarnessHubClient {
  if (state.status !== "signed-in")
    throw new Error(t("common.signIn.notSignedIn"));
  client ??= sessionClient(state.session.token);
  return client;
}

/**
 * Sign in once when the page loads: with the `#login=` code when the URL
 * has one (removed from the address bar before anything else), otherwise
 * with the token this tab kept. Never rejects; the outcome is the session
 * state.
 */
export async function startSession(): Promise<void> {
  const hash = window.location.hash;
  const code = /^#login=([A-Za-z0-9_-]{1,64})$/.exec(hash)?.[1];
  if (hash.startsWith("#login="))
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  set({ status: "checking" });
  try {
    if (code !== undefined)
      try {
        const { csrfToken, ...times } =
          await sessionClient().auth.createConsoleSession(code);
        storeToken(csrfToken);
        set({ status: "signed-in", session: { token: csrfToken, ...times } });
        return;
      } catch (error) {
        // A used, expired or garbled link still leaves this tab's session usable.
        if (!(
          error instanceof HarnessHubError &&
          (error.status === 401 || error.status === 400)
        ))
          throw error;
      }
    const token = storedToken();
    if (token === undefined) {
      set({
        status: "signed-out",
        reason: code !== undefined ? "invalid-link" : "none",
      });
      return;
    }
    const times = await sessionClient(token).auth.currentConsoleSession();
    set({ status: "signed-in", session: { token, ...times } });
  } catch (error) {
    if (error instanceof HarnessHubError && error.status === 401) {
      storeToken(undefined);
      set({
        status: "signed-out",
        reason: code !== undefined ? "invalid-link" : "ended",
      });
    } else
      set({
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : t("common.signIn.unreachableDetail"),
      });
  }
}

/** End this tab's session on the daemon; the page then shows how to sign in again. */
export async function signOut(): Promise<void> {
  try {
    await apiClient().auth.deleteConsoleSession();
  } finally {
    storeToken(undefined);
    set({ status: "signed-out", reason: "signed-out" });
  }
}

/** The current session state; re-renders when it changes. */
export function useSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
