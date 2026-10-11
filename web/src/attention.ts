import type { AttentionItem } from "../../src/contracts/session.js";

/** One SSE block: its event name, identity and data lines joined. */
export interface SseBlock { readonly event: string; readonly id: string | null; readonly data: string }
/** A block larger than this ends the stream; an attention frame lists at most 32 small items. */
const MAX_BLOCK_BYTES = 256 * 1024;

/**
 * Reads SSE blocks from a body until it ends or the signal aborts; comments (heartbeats) are skipped. Owns its reader and
 * always releases it. A block over its budget, or a body that ends inside a block, fails the read.
 */
export async function readSseBlocks(body: ReadableStream<Uint8Array>, signal: AbortSignal, onBlock: (block: SseBlock) => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let buffer = "";
  const flush = (raw: string) => {
    let event = "", id: string | null = null; const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1); if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value; else if (field === "id") id = value; else if (field === "data") data.push(value);
    }
    if (data.length) onBlock({ event, id, data: data.join("\n") });
  };
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Attention stream was aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/gu, "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) { flush(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      if (buffer.length > MAX_BLOCK_BYTES) throw new Error("attention stream block exceeds its budget");
    }
    if (buffer.trim() !== "") throw new Error("attention stream ended inside a block");
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** The items still waiting at `now`: one whose deadline passed is gone from the moment it expires. */
export function liveItems(items: readonly AttentionItem[], now: number): readonly AttentionItem[] {
  return items.filter(item => item.expiresAt === undefined || item.expiresAt > now);
}
/** Whole seconds left before `at`, never negative. */
export function secondsLeft(at: number, now: number): number { return Math.max(0, Math.ceil((at - now) / 1000)); }
/**
 * What is left of a request's wait, in words (ADR-035): the program's own deadline counts down in seconds ("原程序期限");
 * a Turn's deadline in minutes, in seconds for its last minute ("回合期限"). Without a deadline: waiting for the user.
 */
export function remaining(item: { readonly expiresAt?: number; readonly expiresBy?: "native" | "turn" }, now: number): { readonly text: string; readonly source: string | null; readonly hint: string } {
  if (item.expiresAt === undefined) return { text: "等待你的决定", source: null, hint: "原程序会一直等待你的决定。" };
  const seconds = secondsLeft(item.expiresAt, now);
  if (item.expiresBy === "native") return { text: seconds < 60 ? `${seconds} 秒后自动拒绝` : `${Math.ceil(seconds / 60)} 分后自动拒绝`, source: "原程序期限",
    hint: "原程序的等待期限，到时它会按自己的规则拒绝。" };
  return { text: seconds <= 60 ? `回合剩余 ${seconds} 秒` : `回合剩余 ${Math.ceil(seconds / 60)} 分`, source: "回合期限", hint: "HarnessHub 的回合期限，到时本回合超时结束。" };
}
/** What a waiting item asks for. */
export function attentionKind(item: AttentionItem): string { return item.kind === "question" ? "等待回答提问" : "等待审批"; }
/** The item of a conversation that expires first (one without a deadline comes last). */
export function mostUrgent(items: readonly AttentionItem[]): AttentionItem | null {
  return [...items].sort((a, b) => (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || a.requestedAt - b.requestedAt)[0] ?? null;
}

const NOTIFY_KEY = "harnessgateway:notify-attention";
/** Whether this browser can show notifications at all. */
export function notificationsSupported(): boolean { return typeof window !== "undefined" && "Notification" in window; }
/** The user's choice in this browser; off unless they turned it on here. */
export function notificationsChosen(): boolean { try { return localStorage.getItem(NOTIFY_KEY) === "on"; } catch { return false; } }
export function chooseNotifications(on: boolean): void { try { if (on) localStorage.setItem(NOTIFY_KEY, "on"); else localStorage.removeItem(NOTIFY_KEY); } catch { /* the choice lasts for this page only */ } }
/**
 * A notification for a newly waiting item, only while the page is hidden, the user chose notifications here and the
 * browser allows them (ADR-035). It names the Harness and the wait only: nothing of the conversation. Clicking it brings
 * the page forward and opens the conversation. Anything unsupported or refused stays silent.
 */
export function notifyWaiting(item: AttentionItem, harnessName: string, now: number, open: (sessionId: string) => void): void {
  if (!notificationsSupported() || !notificationsChosen() || Notification.permission !== "granted" || document.visibilityState !== "hidden") return;
  const left = remaining(item, now);
  try {
    const notice = new Notification(`${harnessName} 等待你处理`, { body: attentionKind(item) + (left.source === null ? "" : `（${left.source}，${left.text}）`), tag: item.permissionId });
    notice.onclick = () => { window.focus(); open(item.sessionId); notice.close(); };
  } catch { /* a browser that refuses to construct one stays silent */ }
}
