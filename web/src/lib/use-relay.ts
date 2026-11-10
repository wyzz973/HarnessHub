import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "../../../src/contracts/web.js";
import type { RelayApi, RelayCrossVendor, RelayPrefs, RelayView } from "../relay.js";
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
 * a change (`pushed`), and shortly again while a packet is still in flight. null while nothing is known: not read yet, no
 * Turns, or no relay information to give, which the page treats alike. A read that fails changes nothing and is made again at
 * the next change. A Gateway that answers that it has no such endpoint is `gone`.
 */
export function useRelayView(api: RelayApi, session: SessionView | null, pushed: number, known: boolean, gone: () => void): RelayView | null {
  const [read, setRead] = useState<{ readonly sessionId: string; readonly view: RelayView | null } | null>(null);
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
      setRead({ sessionId: id, view });
      if (view.packets.some(packet => packet.delivery === "in_flight") && document.visibilityState === "visible") timer = setTimeout(() => void load(), WHILE_IN_FLIGHT_MS);
    };
    timer = setTimeout(() => void load(), SETTLE_MS);
    return () => { controller.abort(); if (timer !== null) clearTimeout(timer); };
  }, [api, known, id, turns > 0, signature, pushed]);
  return known && read !== null && read.sessionId === id && turns > 0 ? read.view : null;
}

const INTRO_KEY = "harnesshub:relay-intro";
/**
 * Whether the page has told the user, once, what a hand-over to another Harness sends (10.4). Remembered by this browser; a
 * browser that cannot remember asks again each visit, and the note never blocks anything.
 */
export function useRelayIntro(): { readonly seen: boolean; readonly dismiss: () => void } {
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(INTRO_KEY) === "1"; } catch { return false; } });
  const dismiss = useCallback(() => { setSeen(true); try { localStorage.setItem(INTRO_KEY, "1"); } catch { /* A convenience only: without storage the note is shown again next time. */ } }, []);
  return { seen, dismiss };
}

/**
 * The installation's relay preferences for the settings page, read only when the Gateway is known to have the relay. `prefs`
 * is null while they are read and when the Gateway has none to give (the page then offers no setting); `change` saves
 * optimistically, returns the old value on failure and says why.
 */
export function useRelayPrefs(api: RelayApi, known: boolean): { readonly prefs: RelayPrefs | null; readonly problem: string | null; readonly saving: boolean; readonly change: (value: RelayCrossVendor) => void } {
  const [prefs, setPrefs] = useState<RelayPrefs | null>(null);
  const [problem, setProblem] = useState<string | null>(null), [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!known) { setPrefs(null); return; }
    const controller = new AbortController();
    void api.prefs(controller.signal).then(read => { if (!controller.signal.aborted) setPrefs(read); });
    return () => controller.abort();
  }, [api, known]);
  const change = useCallback((value: RelayCrossVendor) => {
    const before = prefs;
    if (before === null || saving || before.crossVendor === value) return;
    setSaving(true); setProblem(null); setPrefs({ crossVendor: value });
    api.setCrossVendor(value).catch((failure: unknown) => {
      setPrefs(before);
      setProblem(failure instanceof Error ? failure.message : "这项设置没有保存。");
    }).finally(() => setSaving(false));
  }, [api, prefs, saving]);
  return { prefs: known ? prefs : null, problem, saving, change };
}
