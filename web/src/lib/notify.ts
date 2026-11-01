import { useCallback, useEffect, useState } from "react";
import type { PublicRun, RunStatus } from "../../../src/contracts/session.js";
import { chooseNotifications, notificationsChosen, notificationsSupported } from "../attention.js";
import { elapsed } from "./format.js";
import { toolSummary } from "./turn.js";

/*
 * System notifications beyond the waiting requests that attention.ts announces (ADR-035, ADR-054 X04). Needing the user
 * rings (attention.ts leaves the system sound on); a Turn that finished or failed only shows, silently. Nothing here
 * carries conversation content: the Agent's name, the outcome, step counts and time. The page asks for permission only
 * when the user turns it on, or after the first reply that finished in the background (see `notificationAsked`).
 */

/** Every switch that shows the choice (the inbox's, the settings'), told when this page changes it. */
const listeners = new Set<() => void>();
function choiceChanged(): void { for (const listener of [...listeners]) listener(); }
function readChoice(): { readonly on: boolean; readonly blocked: boolean } {
  const supported = notificationsSupported();
  return { on: supported && notificationsChosen() && Notification.permission === "granted", blocked: supported && Notification.permission === "denied" };
}

/**
 * The user's choice of system notifications in this browser and what the browser allows; turning it on asks the browser
 * once. Every switch on the page shows the same choice: one made in another switch, in the offer after a reply or in
 * another tab shows in all of them, and one made in the browser's own settings shows once the page is back in view.
 */
export function useNotificationChoice(): { readonly supported: boolean; readonly on: boolean; readonly blocked: boolean; readonly toggle: () => Promise<void> } {
  const supported = notificationsSupported();
  const [choice, setChoice] = useState(readChoice);
  useEffect(() => {
    const update = () => setChoice(current => { const next = readChoice(); return next.on === current.on && next.blocked === current.blocked ? current : next; });
    const visible = () => { if (document.visibilityState === "visible") update(); };
    listeners.add(update); window.addEventListener("storage", update); document.addEventListener("visibilitychange", visible);
    update();
    return () => { listeners.delete(update); window.removeEventListener("storage", update); document.removeEventListener("visibilitychange", visible); };
  }, []);
  const toggle = useCallback(async () => {
    if (!supported) return;
    if (choice.on) { chooseNotifications(false); choiceChanged(); return; }
    await enableNotifications();
  }, [choice.on, supported]);
  return { supported, on: choice.on, blocked: choice.blocked, toggle };
}

/**
 * Asks the browser (it prompts only while undecided) and records the choice; true when notifications are now on. Every
 * switch showing the choice follows.
 */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  let permission = Notification.permission;
  if (permission === "default") { try { permission = await Notification.requestPermission(); } catch { permission = "denied"; } }
  chooseNotifications(permission === "granted");
  choiceChanged();
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
/** How a Turn that ended out of sight ended, as the offer of notifications says it when the page is back: a failure is never "done". */
export function backgroundOutcome(status: RunStatus): string {
  return status === "failed" ? "这一轮在后台失败了" : status === "unknown" ? "这一轮在后台结束，结果未知" : "回复在后台做完了";
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
