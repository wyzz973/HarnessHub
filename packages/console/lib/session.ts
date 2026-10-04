// SPDX-License-Identifier: MIT
/**
 * The console session (07-data-security section 5.2). `hh console` opens
 * `/#login=<code>`; the page removes the code from the address bar at once
 * and exchanges it for an HttpOnly session cookie. A reloaded page asks the
 * daemon for the session of its cookie. The CSRF value of the session goes
 * with every `/api/v1` request; the admin token never reaches the browser.
 */
import { useSyncExternalStore } from "react";
import {
  HarnessHubClient,
  HarnessHubError,
  type ConsoleSession,
} from "@harnesshub/sdk/client";

export type SessionState =
  | { status: "checking" }
  | { status: "signed-in"; session: ConsoleSession }
  | {
      status: "signed-out";
      /** Why: no session yet, an unusable link, an ended session, or sign-out. */
      reason: "none" | "invalid-link" | "ended" | "signed-out";
    }
  | { status: "failed"; message: string };

let state: SessionState = { status: "checking" };
let client: HarnessHubClient | undefined;
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

/** A client without a session, for signing in. */
function anonymous() {
  return new HarnessHubClient({ url: window.location.origin });
}

/** Whether a failed response is the daemon refusing this request's CSRF value. */
async function csrfRefused(response: Response) {
  if (response.status !== 403) return false;
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      body.code === "CSRF_TOKEN_INVALID"
    );
  } catch {
    return false;
  }
}

/**
 * The SDK's transport. A 401 means the cookie no longer names a session
 * (ended, signed out, or the daemon restarted): the page shows how to sign
 * in again. A 403 `CSRF_TOKEN_INVALID` means another tab signed in and
 * replaced the cookie: the CSRF value of the new session is read once and
 * the request, which the daemon refused before running it, is sent again.
 */
const transport: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status === 401 && state.status === "signed-in")
    set({ status: "signed-out", reason: "ended" });
  if (!(await csrfRefused(response))) return response;
  let session: ConsoleSession;
  try {
    session = await anonymous().auth.currentConsoleSession();
  } catch {
    return response;
  }
  set({ status: "signed-in", session });
  const headers = new Headers(init?.headers);
  headers.set("x-hh-csrf", session.csrfToken);
  return fetch(input, { ...init, headers });
};

/**
 * The SDK client of the signed-in session, for `/api/v1`.
 *
 * @throws Error when no session is signed in; the console renders its pages
 *   only after sign-in.
 */
export function apiClient(): HarnessHubClient {
  if (state.status !== "signed-in")
    throw new Error("控制台尚未登录，请运行 hh console 打开登录链接");
  client ??= new HarnessHubClient({
    url: window.location.origin,
    csrfToken: state.session.csrfToken,
    fetch: transport,
  });
  return client;
}

/**
 * Sign in once when the page loads: with the `#login=` code when the URL
 * has one (removed from the address bar before anything else), otherwise
 * with the session of the page's cookie. Never rejects; the outcome is the
 * session state.
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
  const signIn = anonymous();
  try {
    if (code !== undefined)
      try {
        set({
          status: "signed-in",
          session: await signIn.auth.createConsoleSession(code),
        });
        return;
      } catch (error) {
        // A used, expired or garbled link still leaves an earlier session usable.
        if (!(
          error instanceof HarnessHubError &&
          (error.status === 401 || error.status === 400)
        ))
          throw error;
      }
    set({
      status: "signed-in",
      session: await signIn.auth.currentConsoleSession(),
    });
  } catch (error) {
    if (error instanceof HarnessHubError && error.status === 401)
      set({
        status: "signed-out",
        reason: code !== undefined ? "invalid-link" : "none",
      });
    else
      set({
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "无法连接 HarnessHub 守护进程",
      });
  }
}

/** End the session on the daemon; the page then shows how to sign in again. */
export async function signOut(): Promise<void> {
  try {
    await apiClient().auth.deleteConsoleSession();
  } finally {
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
