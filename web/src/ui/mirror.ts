/*
 * A copy of the page for the system's glass to show. The desktop app lays sheets of Liquid Glass under the page, and glass shows what is behind
 * the window (desktop/main.ts); so behind the window is kept this copy — a second document that the page opens and keeps the same as its own
 * content: every element, attribute, word and scroll position, without what floats outside the page's root and with the glass surfaces left
 * blank. It is only ever seen through glass, and nothing in it can be pressed.
 */
const LEFT_OUT = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE"]);
/** Elements that would load or play on their own: the copy keeps a box of their size. */
const BOXED = new Set(["IFRAME", "VIDEO", "AUDIO", "OBJECT", "EMBED"]);

export interface Mirror {
  /** Settles once the copy is styled and scrolled as the page is: until then nothing should be looked at through it. */
  readonly ready: Promise<void>;
  /** Puts every scroll position of the copy where the page's is. */
  settle(): void;
  stop(): void;
}

/** `blank` selects what the copy leaves empty: the glass surfaces (their content is the page's, above the glass) and the sidebar's content. */
export function startMirror(root: HTMLElement, blank: string): Mirror | null {
  let other: Document;
  try {
    const opened = window.open("", "hub-mirror");
    if (opened === null) return null;
    other = opened.document;
  } catch { return null; }
  const twins = new WeakMap<Node, Node>(), scrolled = new Set<Element>();

  const sameAttributes = (from: Element, to: Element) => {
    for (const name of to.getAttributeNames()) if (!from.hasAttribute(name)) to.removeAttribute(name);
    for (const name of from.getAttributeNames()) { const value = from.getAttribute(name)!; if (to.getAttribute(name) !== value) to.setAttribute(name, value); }
  };
  const copyOf = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) { const text = other.createTextNode((node as Text).data); twins.set(node, text); return text; }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as Element;
    if (LEFT_OUT.has(element.tagName)) return null;
    let made: Element;
    if (BOXED.has(element.tagName)) {
      made = other.createElement("div");
      for (const name of ["class", "style", "width", "height", "hidden"]) { const value = element.getAttribute(name); if (value !== null) made.setAttribute(name, value); }
    } else {
      made = other.importNode(element, false);
      made.removeAttribute("autofocus");
      if (element instanceof HTMLInputElement) { (made as HTMLInputElement).value = element.value; (made as HTMLInputElement).checked = element.checked; }
      else if (element instanceof HTMLTextAreaElement) (made as HTMLTextAreaElement).value = element.value;
      else if (element instanceof HTMLCanvasElement) try { (made as HTMLCanvasElement).getContext("2d")?.drawImage(element, 0, 0); } catch { /* an empty canvas */ }
      for (let child = element.firstChild; child !== null; child = child.nextSibling) { const copied = copyOf(child); if (copied !== null) made.appendChild(copied); }
    }
    twins.set(node, made);
    return made;
  };
  /** The copy's children of one element, put in the page's order: what is new is copied, what moved is moved, what left is removed. */
  const sameChildren = (parent: Node) => {
    const twin = twins.get(parent);
    if (twin === undefined || !twin.isConnected || BOXED.has((parent as Element).tagName)) return;
    let at = twin.firstChild;
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      let copied = twins.get(child) ?? null;
      // A copy that is no longer in the document was removed with its parent and may have missed changes since: it is made again.
      if (copied === null || (copied !== at && !copied.isConnected)) copied = copyOf(child);
      if (copied === null) continue;
      if (copied === at) at = at.nextSibling; else twin.insertBefore(copied, at);
    }
    while (at !== null) { const next = at.nextSibling; at.remove(); at = next; }
  };

  // The head: where relative addresses start, the page's stylesheets, and the copy's own few rules.
  const html = document.documentElement;
  sameAttributes(html, other.documentElement); sameAttributes(document.body, other.body);
  other.head.replaceChildren(); other.body.replaceChildren();
  const base = other.createElement("base"); base.href = document.baseURI; other.head.append(base);
  // Its own few rules: clear where the window's glass must show the desktop, blank where glass lies over it, and still where the page loops
  // (a spinner under glass is not worth a second animation).
  const own = other.createElement("style");
  // The copy lies in a bare window behind the app's: its corners are cut a little rounder than the window's, so that none shows past them.
  own.textContent = `html, body { background: transparent !important; overflow: hidden !important; } html { clip-path: inset(0 round 20px); }
* { scroll-behavior: auto !important; overflow-anchor: none !important; caret-color: transparent !important; }
:is(${blank}), :is(${blank}) *, .sidebar-pane * { visibility: hidden !important; }
.sidebar-pane { background: var(--pane-wash) !important; }
:is(.spinner, .spin, .spinner-arc, .shimmer-text, .shimmer, .status-dot, .motion-breathe, .pulse, .end-dot, .caret-host, .motion-token) { animation: none !important; }`;
  other.head.append(own);
  const sheets = new Map<Element, Element>(), loading: Promise<void>[] = [];
  const sameSheets = () => {
    const now = new Set<Element>(document.head.querySelectorAll("link[rel~='stylesheet'], style"));
    for (const [sheet, twin] of sheets) if (!now.has(sheet)) { twin.remove(); sheets.delete(sheet); }
    for (const sheet of now) if (!sheets.has(sheet)) {
      const twin = other.importNode(sheet, true);
      if (twin instanceof HTMLLinkElement) loading.push(new Promise(done => { twin.addEventListener("load", () => done(), { once: true }); twin.addEventListener("error", () => done(), { once: true }); }));
      sheets.set(sheet, twin); other.head.insertBefore(twin, own);
    }
  };
  sameSheets();
  const head = new MutationObserver(sameSheets); head.observe(document.head, { childList: true });
  const frame = new MutationObserver(() => { sameAttributes(html, other.documentElement); sameAttributes(document.body, other.body); });
  frame.observe(html, { attributes: true }); frame.observe(document.body, { attributes: true });

  const first = copyOf(root);
  if (first !== null) other.body.append(first);
  const settle = () => {
    for (const element of scrolled) {
      const twin = twins.get(element) as Element | undefined;
      if (!element.isConnected || twin === undefined) { scrolled.delete(element); continue; }
      if (twin.scrollTop !== element.scrollTop) twin.scrollTop = element.scrollTop;
      if (twin.scrollLeft !== element.scrollLeft) twin.scrollLeft = element.scrollLeft;
    }
  };
  let settling = false;
  const settleSoon = () => { if (!settling) { settling = true; requestAnimationFrame(() => { settling = false; settle(); }); } };
  let changed = performance.now();
  const body = new MutationObserver(records => {
    changed = performance.now();
    const parents = new Set<Node>();
    for (const record of records) if (record.type === "childList") parents.add(record.target);
    for (const parent of parents) sameChildren(parent);
    for (const record of records) {
      if (record.type === "childList") continue;
      const twin = twins.get(record.target);
      if (twin === undefined) continue;
      if (record.type === "characterData") { const data = (record.target as CharacterData).data; if ((twin as CharacterData).data !== data) (twin as CharacterData).data = data; continue; }
      const name = record.attributeName!, element = record.target as Element, value = element.getAttribute(name);
      if (name === "autofocus" || BOXED.has(element.tagName) && !["class", "style", "width", "height", "hidden"].includes(name)) continue;
      if (value === null) (twin as Element).removeAttribute(name); else if ((twin as Element).getAttribute(name) !== value) (twin as Element).setAttribute(name, value);
    }
    // What changed may have moved what is scrolled (a longer reply, a shorter list): the copy follows where the page ended up.
    settleSoon();
  });
  body.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  const follow = (event: Event) => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    scrolled.add(element);
    const twin = twins.get(element) as Element | undefined;
    if (twin !== undefined) { twin.scrollTop = element.scrollTop; twin.scrollLeft = element.scrollLeft; }
  };
  document.addEventListener("scroll", follow, { capture: true, passive: true });
  window.addEventListener("resize", settleSoon);

  // Now and then, while the page is still, the copy is counted against the page; one that has come apart is made again whole.
  const held = () => root.querySelectorAll("*").length - root.querySelectorAll("script, noscript, template, iframe *, video *, audio *, object *, embed *").length;
  const audit = window.setInterval(() => {
    const twin = twins.get(root) as Element | undefined;
    if (twin === undefined || performance.now() - changed < 1500 || document.visibilityState === "hidden") return;
    if (twin.querySelectorAll("*").length === held()) return;
    const again = copyOf(root);
    if (again !== null) { twin.replaceWith(again); settle(); }
  }, 4000);

  const ready = Promise.race([Promise.all(loading), new Promise(done => setTimeout(done, 2000))]).then(() => {
    // Whatever was already scrolled when the copy was made (a conversation opened at its latest reply).
    for (const element of root.querySelectorAll("*")) if (element.scrollTop !== 0 || element.scrollLeft !== 0) scrolled.add(element);
    settle();
  });
  return {
    ready, settle,
    stop: () => { window.clearInterval(audit); head.disconnect(); frame.disconnect(); body.disconnect(); document.removeEventListener("scroll", follow, { capture: true }); window.removeEventListener("resize", settleSoon); },
  };
}
