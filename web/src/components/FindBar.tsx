import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Spinner } from "../ui/primitives.js";

/*
 * Find in the conversation (2026-11-14, after T3 Code's find in thread): every place a word stands in what was said, from its first Turn to its newest, found by the
 * Gateway (the page holds only the newest Turns of a long conversation). Going to a place reads the Turns down to it when they are not held, brings its message into
 * sight and marks the words there; every match in sight is marked too. Enter goes to the next place, ⇧Enter to the one before, Esc closes.
 */

/** One place the words were found: the Turn, its item (by id and by seq) and where in the item's text. */
export interface FindHit { readonly runId: string; readonly ordinal: number; readonly itemId: string; readonly itemSeq: number; readonly offset: number }
export interface FindPage { readonly hits: readonly FindHit[]; readonly next: string | null }
export interface FindAccess {
  readonly search: (query: string, cursor: string | undefined, signal: AbortSignal) => Promise<FindPage>;
  /** Reads the conversation's Turns down to this one, when the page does not hold it; false when it cannot. */
  readonly readTo: (ordinal: number) => Promise<boolean>;
}
/** Where find opens from elsewhere (a message found by the palette's search): the words, and the item to go to first. */
export interface FindTarget { readonly query: string; readonly runId: string | null; readonly itemId: string | null }

const MATCH = "hh-find-match", CURRENT = "hh-find-current";
type Highlights = Map<string, unknown>;
const registry = (): Highlights | null => (globalThis as { CSS?: { highlights?: Highlights } }).CSS?.highlights ?? null;
const HighlightType = (): (new (...ranges: Range[]) => unknown) | null => (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;

/** The ranges of every place `query` stands in the text under `root`, case aside, in document order. */
function rangesIn(root: Element, query: string): Range[] {
  const needle = query.toLocaleLowerCase(), found: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLocaleLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length); found.push(range);
    }
  }
  return found;
}
/** How many times `query` stands in `text` before `offset`, case aside: which of a message's matches a hit is. */
function countBefore(text: string, query: string, offset: number): number {
  const haystack = text.toLocaleLowerCase(), needle = query.toLocaleLowerCase();
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0 && at < offset; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}
const same = (hit: FindHit, target: { readonly runId: string; readonly itemId: string }): boolean => hit.runId === target.runId && hit.itemId === target.itemId;

export function FindBar({ access, onClose, scroller, messageAt, textOf, initial }: {
  readonly access: FindAccess; readonly onClose: () => void;
  /** The conversation's scrolling column: the matches are looked for in it. */
  readonly scroller: () => HTMLElement | null;
  /** The page's message a place stands in, once its Turn is held. */
  readonly messageAt: (hit: FindHit) => string | undefined;
  /** A message's whole text by its identity, where the page holds it: which of its matches a hit is. */
  readonly textOf: (messageId: string) => string | undefined;
  readonly initial?: FindTarget | undefined;
}) {
  const field = useRef<HTMLInputElement>(null), [query, setQuery] = useState(initial?.query ?? ""), [hits, setHits] = useState<readonly FindHit[]>([]), [next, setNext] = useState<string | null>(null);
  const [at, setAt] = useState(-1), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null);
  // What the page says changes as Turns are read in; the latest is what a place is looked up in.
  const latest = useRef({ scroller, messageAt, textOf }); latest.current = { scroller, messageAt, textOf };
  const target = useRef(initial?.runId && initial.itemId ? { runId: initial.runId, itemId: initial.itemId } : null), straight = useRef(initial !== undefined);
  useLayoutEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  // The words are looked for a moment after typing stops (at once when find opens with them); the place asked for is gone to first, read up to across the pages,
  // and otherwise the newest.
  useEffect(() => {
    const words = query.trim();
    setProblem(null);
    if (words === "") { setHits([]); setNext(null); setAt(-1); return; }
    const controller = new AbortController(), wanted = target.current, delay = straight.current ? 0 : 220;
    straight.current = false;
    const timer = setTimeout(() => {
      setBusy(true);
      void (async () => {
        let page = await access.search(words, undefined, controller.signal);
        const all = [...page.hits];
        let index = wanted === null ? -1 : all.findIndex(hit => same(hit, wanted));
        while (wanted !== null && index < 0 && page.next !== null && !controller.signal.aborted) {
          page = await access.search(words, page.next, controller.signal);
          const found = page.hits.findIndex(hit => same(hit, wanted));
          if (found >= 0) index = all.length + found;
          all.push(...page.hits);
        }
        if (controller.signal.aborted) return;
        target.current = null;
        setHits(all); setNext(page.next); setAt(index >= 0 ? index : all.length > 0 && page.next === null ? all.length - 1 : 0);
      })().catch((failure: unknown) => { if (!controller.signal.aborted) setProblem(failure instanceof Error ? failure.message : "没有找成"); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  // Marks every match in sight, and the place gone to apart from them, once the page holds it.
  const mark = (hit: FindHit | undefined, words: string) => {
    const highlights = registry(), Highlight = HighlightType(), { scroller: rootOf, messageAt: placeOf, textOf: wordsOf } = latest.current, root = rootOf();
    highlights?.delete(MATCH); highlights?.delete(CURRENT);
    if (root === null || words === "") return;
    if (highlights !== null && Highlight !== null) highlights.set(MATCH, new Highlight(...rangesIn(root, words)));
    if (hit === undefined) return;
    const id = placeOf(hit), message = id === undefined ? null : root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (id === undefined || message === null) { root.querySelector(`[data-run-id="${CSS.escape(hit.runId)}"]`)?.scrollIntoView({ block: "start" }); return; }
    const ranges = rangesIn(message, words), text = wordsOf(id), which = text === undefined ? 0 : Math.min(countBefore(text, words, hit.offset), Math.max(0, ranges.length - 1));
    const range = ranges[which];
    if (range !== undefined) {
      if (highlights !== null && Highlight !== null) highlights.set(CURRENT, new Highlight(range));
      const box = range.getBoundingClientRect(), frame = root.getBoundingClientRect();
      // The bar floats over the column's top: a place under it, or near the foot, is brought to the middle.
      if (box.top < frame.top + 64 || box.bottom > frame.bottom - 40) root.scrollBy({ top: box.top - frame.top - frame.height / 2, behavior: "auto" });
    } else message.scrollIntoView({ block: "center" });
  };
  useEffect(() => {
    const hit = hits[at], words = query.trim();
    if (hit === undefined) { mark(undefined, words); return; }
    let live = true;
    void access.readTo(hit.ordinal).then(() => { if (live) requestAnimationFrame(() => requestAnimationFrame(() => { if (live) mark(hit, words); })); });
    return () => { live = false; };
  }, [hits, at]);
  useEffect(() => () => { registry()?.delete(MATCH); registry()?.delete(CURRENT); }, []);
  const go = (by: 1 | -1) => {
    if (hits.length === 0) return;
    const to = at + by;
    if (to >= hits.length && next !== null) {
      setBusy(true);
      // A page that ends exactly at the last place still says there is a next one, which is empty: then the first place is next.
      access.search(query.trim(), next, new AbortController().signal).then(page => { setHits(current => [...current, ...page.hits]); setNext(page.next); setAt(page.hits.length > 0 ? to : 0); }, () => undefined).finally(() => setBusy(false));
      return;
    }
    setAt((to + hits.length) % hits.length);
  };
  const count = hits.length === 0 ? (query.trim() === "" || busy ? "" : "没有找到") : (at + 1) + " / " + hits.length + (next !== null ? "+" : "");
  return <div className="find-bar absolute top-3 right-4 z-20 flex h-9 items-center gap-1 rounded-block bg-surface py-1 pr-1 pl-2.5 shadow-pop" role="search" aria-label="在对话里查找">
    <input ref={field} className="h-7 w-48 min-w-0 border-none bg-transparent text-ui-sm text-fg outline-none placeholder:text-placeholder" value={query} placeholder="在对话里查找" aria-label="在对话里查找"
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); go(event.shiftKey ? -1 : 1); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}/>
    <span className="min-w-12 flex-none text-right text-caption text-fg-3 tabular-nums" role="status">{busy ? <Spinner size={12} label="正在查找"/> : problem ?? count}</span>
    <button type="button" className="icon-btn size-7 text-fg-3" aria-label="上一处" title="上一处（⇧Enter）" disabled={hits.length === 0} onClick={() => go(-1)}><ChevronUp size={14} strokeWidth={2}/></button>
    <button type="button" className="icon-btn size-7 text-fg-3" aria-label="下一处" title="下一处（Enter）" disabled={hits.length === 0} onClick={() => go(1)}><ChevronDown size={14} strokeWidth={2}/></button>
    <button type="button" className="icon-btn size-7 text-fg-3" aria-label="关闭查找" title="关闭（Esc）" onClick={onClose}><X size={14} strokeWidth={2}/></button>
  </div>;
}
