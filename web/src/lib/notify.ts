import { useCallback, useState } from "react";
import type { PublicRun } from "../../../src/contracts/session.js";
import { chooseNotifications, notificationsChosen, notificationsSupported } from "../attention.js";
import { elapsed } from "./format.js";
import { toolSummary } from "./turn.js";

/*
 * System notifications beyond the waiting requests that attention.ts announces (ADR-035, ADR-054 X04). Needing the user
 * rings (attention.ts leaves the system sound on); a Turn that finished or failed only shows, silently. Nothing here
 * carries conversation content: the Agent's name, the outcome, step counts and time. The page asks for permission only
 * when the user turns it on, or after the first reply that finished in the background (see `notificationAsked`).
 */

/** The user's choice of system notifications in this browser and what the browser allows; turning it on asks the browser once. */
export function useNotificationChoice(): { readonly supported: boolean; readonly on: boolean; readonly blocked: boolean; readonly toggle: () => Promise<void> } {
  const supported = notificationsSupported();
  const [on, setOn] = useState(() => supported && notificationsChosen() && Notification.permission === "granted");
  const [blocked, setBlocked] = useState(() => supported && Notification.permission === "denied");
  const toggle = useCallback(async () => {
    if (!supported) return;
    if (on) { chooseNotifications(false); setOn(false); return; }
    const granted = await enableNotifications();
    setOn(granted); setBlocked(!granted && Notification.permission === "denied");
  }, [on, supported]);
  return { supported, on, blocked, toggle };
}

/** Asks the browser (it prompts only while undecided) and records the choice; true when notifications are now on. */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  let permission = Notification.permission;
  if (permission === "default") { try { permission = await Notification.requestPermission(); } catch { permission = "denied"; } }
  chooseNotifications(permission === "granted");
  return permission === "granted";
}

const ASKED_KEY = "harnesshub:notify-asked";
/** Whether this browser was already offered notifications after a reply finished in the background; asked once only. */
export function notificationAsked(): boolean { try { return localStorage.getItem(ASKED_KEY) === "1"; } catch { return true; } }
export function markNotificationAsked(): void { try { localStorage.setItem(ASKED_KEY, "1"); } catch { /* lasts for this page only */ } }
/** Whether offering notifications could still help: the browser has them, the user has not chosen them, and has not refused them. */
export function notificationsOfferable(): boolean {
  return notificationsSupported() && !notificationsChosen() && Notification.permission !== "denied" && !notificationAsked();
}

/** How a Turn ended, as the notification's title says it after the Agent's name. */
function outcome(status: PublicRun["status"]): string | null {
  return status === "completed" ? "做完了" : status === "failed" ? "这一轮失败了" : status === "unknown" ? "这一轮结果未知" : null;
}
/**
 * Notifies that the open conversation's Turn ended while the page was hidden, when the user chose notifications here and
 * the browser allows them: completed and failed are silent, an unknown result needs the user and keeps the sound. A Turn
 * the user stopped is not announced. Clicking it brings the page forward and runs `open`. Unsupported or refused: silent.
 */
export function notifyTurnEnded(run: PublicRun, agent: string, open: () => void): void {
  const said = outcome(run.status);
  if (said === null || !notificationsSupported() || !notificationsChosen() || Notification.permission !== "granted" || document.visibilityState !== "hidden") return;
  const steps = toolSummary(run.tools ?? [], false).text, ended = run.timing?.endedAt;
  const body = [steps, ended === undefined ? "" : "用时 " + elapsed(ended - run.timing!.acceptedAt)].filter(Boolean).join(" · ");
  try {
    const notice = new Notification(`${agent} ${said}`, { body, tag: "turn:" + run.id, silent: run.status !== "unknown" });
    notice.onclick = () => { window.focus(); open(); notice.close(); };
  } catch { /* a browser that refuses to construct one stays silent */ }
}
