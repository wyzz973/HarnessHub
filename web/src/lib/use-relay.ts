import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "../../../src/contracts/web.js";
import type { RelayApi, RelayPrefs, RelayView } from "../relay.js";
import { relaySignature } from "./relay-state.js";

/** A look at the relay again soon after the last, while a hand-over is still on its way, in case no event announces it. */
const WHILE_IN_FLIGHT_MS = 1500;
/** Reads are not made faster than this after a change, so a burst of changes is read once. */
const SETTLE_MS = 120;

const PRESENCE_KEY = "harnesshub:relay-api";
/**
 * Whether this Gateway is known to have the relay API, learned without asking it: it says so in its state, a Turn carries a
 * delivery, it pushes a relay event, or a refused send offers ways forward; this browser remembers that for the Gateway
 * (its address) from one visit to the next. Until one of those, the page makes no relay request and draws nothing of the relay,
 * so a Gateway without the API sees no new traffic and the page is as it was. `forget` is for a Gateway that turns out not to
 * have it after all (said it did, or was remembered as one, and was changed back): nothing is learned again until the page is
 * opened anew.
 */
export function useRelayPresence(): { readonly known: boolean; readonly learn: () => void; readonly forget: () => void } {
  const [known, setKnown] = useState(() => { try { return localStorage.getItem(PRESENCE_KEY) === "1"; } catch { return false; } });
  const refused = useRef(false);
  const learn = useCallback(() => {
    if (refused.current) return;
    setKnown(true);
    try { localStorage.setItem(PRESENCE_KEY, "1"); } catch { /* Without storage it is learned again at the next sign. */ }
  }, []);
  const forget = useCallback(() => { refused.current = true; setKnown(false); try { localStorage.removeItem(PRESENCE_KEY); } catch { /* Nothing was kept. */ } }, []);
  return { known, learn, forget };
}

/**
 * The conversation's relay state: read when the Gateway is known to have the relay and a conversation with Turns is shown,
 * again whenever what it depends on changes (a Turn starts or ends, a packet's delivery is decided) or the Gateway announces
 * a change (`pushed`), and shortly again while a packet is still in flight. `view` is null while nothing is known: not read yet, no
 * Turns, or no relay information to give, which the page treats alike. A read that fails changes nothing and is made again at
 * the next change. A Gateway that answers that it has no such endpoint is `gone`. `fresh` says the view was read for the state the
 * conversation is in now: between a Turn ending and its read coming back the view is the one of before the Turn, good for the lines
 * where earlier Turns were handed over and wrong about what is owed and asked now, so what the line above the box says waits for it.
 */
export function useRelayView(api: RelayApi, session: SessionView | null, pushed: number, known: boolean, gone: () => void): { readonly view: RelayView | null; readonly fresh: boolean } {
  const [read, setRead] = useState<{ readonly sessionId: string; readonly view: RelayView | null; readonly signature: string } | null>(null);
  const id = session?.id ?? null, turns = session?.runs.length ?? 0;
  // What the view depends on is worked out when the conversation's Turns, selection or state change, not on every frame of a reply.
  const signature = useMemo(() => relaySignature(session), [session?.id, session?.runs, session?.selection, session?.status, session?.pendingSwitchId]);
  useEffect(() => {
    if (!known || id === null || turns === 0) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      const { view, absent } = await api.view(id, controller.signal);
      if (controller.signal.aborted) return;
      if (absent) { gone(); return; }
      // A read that failed or could not be understood changes nothing: what was read before stays until a read succeeds.
      if (view === null) return;
      setRead({ sessionId: id, view, signature });
      if (view.packets.some(packet => packet.delivery === "in_flight") && document.visibilityState === "visible") timer = setTimeout(() => void load(), WHILE_IN_FLIGHT_MS);
    };
    timer = setTimeout(() => void load(), SETTLE_MS);
    return () => { controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [api, known, id, turns > 0, signature, pushed]);
  const shown = known && read !== null && read.sessionId === id && turns > 0;
  return { view: shown ? read.view : null, fresh: shown && read.signature === signature };
}

/**
 * A set of words this browser remembers from one visit to the next (which banners the user closed), under one storage key: a JSON list of at most `limit` words, the oldest dropped first. A browser that cannot remember asks again
 * each visit, and nothing here ever blocks anything: it is a convenience, so every read and write is allowed to fail.
 */
export function useRememberedKeys(storageKey: string, limit: number): { readonly has: (key: string) => boolean; readonly add: (key: string) => void } {
  const [keys, setKeys] = useState<readonly string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string" && item.length <= 512).slice(-limit) : [];
    } catch { return []; }
  });
  const has = useCallback((key: string) => keys.includes(key), [keys]);
  const add = useCallback((key: string) => {
    setKeys(current => {
      if (current.includes(key)) return current;
      const next = [...current, key].slice(-limit);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* A convenience only: without storage it is shown again next time. */ }
      return next;
    });
  }, [storageKey, limit]);
  return { has, add };
}
/** The banners the user closed: the key of an `attention`, with the conversation and the Harness it was about. */
export const CLOSED_KEY = "harnesshub:relay-closed";
export function useClosedNotices() { return useRememberedKeys(CLOSED_KEY, 400); }

/**
 * The installation's relay preference for the page, read only when the Gateway is known to have the relay. `prefs` is null while
 * they are read and when the Gateway has none to give (the page then offers no setting); `change` saves optimistically, returns the
 * old value on failure and says why.
 */
export interface RelayPrefsState { readonly prefs: RelayPrefs | null; readonly problem: string | null; readonly saving: boolean; readonly change: <K extends keyof RelayPrefs>(name: K, value: RelayPrefs[K]) => void }
export function useRelayPrefs(api: RelayApi, known: boolean): RelayPrefsState {
  const [prefs, setPrefs] = useState<RelayPrefs | null>(null);
  const [problem, setProblem] = useState<string | null>(null), [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!known) { setPrefs(null); return; }
    const controller = new AbortController();
    void api.prefs(controller.signal).then(read => { if (!controller.signal.aborted) setPrefs(read); });
    return () => controller.abort();
  }, [api, known]);
  const change = useCallback(<K extends keyof RelayPrefs>(name: K, value: RelayPrefs[K]) => {
    const before = prefs;
    if (before === null || saving || before[name] === value) return;
    setSaving(true); setProblem(null); setPrefs({ ...before, [name]: value });
    api.setPref(name, value).catch((failure: unknown) => {
      setPrefs(before);
      setProblem(failure instanceof Error ? failure.message : "这项设置没有保存。");
    }).finally(() => setSaving(false));
  }, [api, prefs, saving]);
  return { prefs: known ? prefs : null, problem, saving, change };
}
