/*
 * The system's glass under the page (desktop app, macOS 26). The sidebar's pane is an opening of the stylesheet's own making; with a copy of the
 * page kept under the glass (ui/mirror.ts) every surface that floats over content is one too: the message box, toolbar capsules, pickers,
 * menus, the palette, dialogs, tips, toasts. This module says where each sheet of glass lies, every time one moves, and cuts the surface's shape
 * out of whatever the page paints under it, so that the glass — and through it the copy of what the surface floats over — shows there. The
 * surface's own content stays in the page, above the glass.
 *
 * What lies under a surface: for one inside the app's shell, every element marked data-under-glass that does not hold it; for one outside (a
 * popup, portaled to the body), the whole shell and everything portaled that is painted before it.
 */
import { desktop, type GlassPane } from "../lib/desktop.js";
import { startMirror, type Mirror } from "./mirror.js";

export const SURFACES = ".composer-box, .tool-group, .follow-stream, .find-bar, .floating-bar, .surface-pop, .dialog-pop, .palette-pop, .drawer-left-pop, .sheet-pop, .tooltip-pop, .toast, "
  // The inspector beside the conversation is glass from edge to edge (macOS 26: sidebars float inset, inspectors run edge to edge); and the bar that asks before unsaved words are left.
  + ".details-pane, .drawer-pop, .leave-bar, "
  // What stands with the message box over the conversation: a queued message, a notice, a handover card. Its own tint lies on the glass.
  + ".chat-foot .relay-card, .chat-foot .queued-message, .chat-foot .composer-notice, .chat-foot .composer-change, .chat-foot [role='status'].rounded-block, .chat-foot [role='alert'].rounded-block";
const OPENINGS = ".sidebar-pane";
const UNDER = "[data-under-glass]";

interface Sheet { readonly element: Element; readonly id: string; readonly box: DOMRect; readonly radius: number; readonly alpha: number; readonly layer: Element | null; readonly depth: number }

const names = new WeakMap<Element, string>();
let named = 0;
const nameOf = (element: Element, prefix: string): string => { let name = names.get(element); if (name === undefined) { name = prefix + ++named; names.set(element, name); } return name; };

/** How far an element has faded with everything it stands in. */
function opacityOf(element: Element): number {
  let alpha = 1;
  for (let at: Element | null = element; at !== null && at !== document.body; at = at.parentElement) { const own = Number(getComputedStyle(at).opacity); if (own < 1) alpha *= own; }
  return alpha;
}
function radiusOf(element: Element, box: DOMRect): number {
  const value = getComputedStyle(element).borderTopLeftRadius, short = Math.min(box.width, box.height);
  const radius = value.endsWith("%") ? parseFloat(value) / 100 * short : parseFloat(value) || 0;
  // A surface that is growing or shrinking carries its corners with it.
  const natural = (element as HTMLElement).offsetWidth, scale = natural > 0 ? box.width / natural : 1;
  return Math.min(radius * scale, short / 2);
}
/** Which of the window's edges a sheet holds to while the window is resized (the bits of an autoresizing mask, top-left origin). */
function anchorOf(box: DOMRect): number {
  const right = innerWidth - box.right, below = innerHeight - box.bottom;
  const across = Math.abs(box.left - right) < 2 ? 1 | 4 : box.left < right ? 4 : 1;
  const down = box.top < 80 && below < 80 ? 16 : box.top < below ? 32 : 8;
  return across | down;
}
const round = (value: number) => Math.round(value * 100) / 100;
/** A rounded rectangle as a path, in the coordinates of the element it is cut from. */
function cut(sheet: Sheet, from: DOMRect, scaleX: number, scaleY: number): string {
  const x = round((sheet.box.left - from.left) / scaleX), y = round((sheet.box.top - from.top) / scaleY), width = round(sheet.box.width / scaleX), height = round(sheet.box.height / scaleY);
  const r = round(Math.min(sheet.radius / scaleX, width / 2, height / 2));
  if (r <= 0) return `M${x} ${y}h${width}v${height}h${-width}z`;
  return `M${x + r} ${y}h${round(width - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${round(height - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}h${-round(width - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-round(height - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}
const meets = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function startSystemGlass(): void {
  const bridge = desktop;
  if (bridge === null || bridge.setGlass === undefined) return;
  const html = document.documentElement, holes = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, holes];
  let mirror: Mirror | null = null, system = false, said = "", cutting = "", revealed = "";

  const measure = () => {
    if (html.dataset.material !== "liquid") return;
    const shell = document.querySelector(".app-shell");
    const panes: GlassPane[] = [], sheets: Sheet[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(OPENINGS)) {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || !element.checkVisibility({ visibilityProperty: true })) continue;
      panes.push({ id: "sidebar", left: box.left, top: box.top, width: box.width, height: box.height, radius: radiusOf(element, box), alpha: 1, anchor: 4 | 16 });
    }
    if (system) {
      let depth = 0;
      for (const element of document.querySelectorAll<HTMLElement>(SURFACES)) {
        const box = element.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || !element.checkVisibility({ visibilityProperty: true })) continue;
        const alpha = opacityOf(element);
        if (alpha < .01) continue;
        // Outside the shell a surface belongs to a layer: the child of its portal that holds it, painted by its z-index and then its place.
        let layer: Element | null = null;
        if (shell === null || !shell.contains(element)) { layer = element; while (layer.parentElement !== null && layer.parentElement.parentElement !== document.body && layer.parentElement !== document.body) layer = layer.parentElement; }
        sheets.push({ element, id: nameOf(element, "s"), box, radius: radiusOf(element, box), alpha, layer, depth: layer === null ? -1 : (Number(getComputedStyle(layer).zIndex) || 0) * 10000 + depth++ });
      }
      sheets.sort((a, b) => a.depth - b.depth);
      for (const sheet of sheets) panes.push({ id: sheet.id, left: sheet.box.left, top: sheet.box.top, width: sheet.box.width, height: sheet.box.height, radius: sheet.radius, alpha: round(sheet.alpha), anchor: anchorOf(sheet.box),
        ...(sheet.element.getAttribute("data-glass") === "clear" ? { clear: true } : {}) });
    }
    const saying = JSON.stringify(panes);
    if (saying !== said) { said = saying; bridge.setGlass!(panes); }

    // The openings: each surface's shape, cut out of what lies under it.
    const rules: string[] = [];
    if (system && sheets.length > 0) {
      const through = (under: Element, over: readonly Sheet[]) => {
        if (over.length === 0) return;
        const from = under.getBoundingClientRect(), natural = under as HTMLElement;
        const scaleX = natural.offsetWidth > 0 && from.width > 0 ? from.width / natural.offsetWidth : 1, scaleY = natural.offsetHeight > 0 && from.height > 0 ? from.height / natural.offsetHeight : 1;
        const name = nameOf(under, "h");
        if (under.getAttribute("data-hole") !== name) under.setAttribute("data-hole", name);
        // The outer edge stays close to the element (with room for its shadow): a far larger one and the compositor drops a scrolling layer whole.
        const width = round(from.width / scaleX), height = round(from.height / scaleY);
        rules.push(`[data-hole="${name}"] { clip-path: path(evenodd, "M-160 -160H${width + 160}V${height + 160}H-160Z ${over.map(sheet => cut(sheet, from, scaleX, scaleY)).join(" ")}"); }`);
      };
      const inside = sheets.filter(sheet => sheet.layer === null), outside = sheets.filter(sheet => sheet.layer !== null);
      if (inside.length > 0) for (const under of document.querySelectorAll(UNDER)) { const box = under.getBoundingClientRect(); through(under, inside.filter(sheet => !under.contains(sheet.element) && meets(sheet.box, box))); }
      if (outside.length > 0) {
        if (shell !== null) through(shell, outside);
        // Everything portaled that is painted before a surface: a dialog's veil under the dialog, a dialog under the menu opened from it.
        for (const portal of document.body.children) {
          if (portal.id === "root" || !(portal instanceof HTMLElement)) continue;
          for (const layer of portal.children) {
            const box = layer.getBoundingClientRect();
            through(layer, outside.filter(sheet => sheet.layer !== layer && !layer.contains(sheet.element) && meets(sheet.box, box) && paintedAfter(sheet.layer!, layer)));
          }
        }
      }
    }
    const text = rules.join("\n");
    if (text !== cutting) { cutting = text; holes.replaceSync(text); }
    // The copy behind the window draws its content only under these surfaces; elsewhere it is the window's own ground, which the sidebar's glass shows.
    if (system && mirror !== null) {
      const whole = new DOMRect(0, 0, 0, 0), path = sheets.map(sheet => cut(sheet, whole, 1, 1)).join(" ");
      if (path !== revealed) { revealed = path; mirror.reveal(path === "" ? null : path); }
    }
  };
  /** Whether one layer is painted after another: by z-index, then by its place in the document. */
  const paintedAfter = (above: Element, below: Element): boolean => {
    const high = Number(getComputedStyle(above).zIndex) || 0, low = Number(getComputedStyle(below).zIndex) || 0;
    return high !== low ? high > low : Boolean(below.compareDocumentPosition(above) & Node.DOCUMENT_POSITION_FOLLOWING);
  };

  // Measured for a while after anything that can move a surface, and now and then besides.
  let until = 0, running = false;
  const tick = () => { measure(); if (performance.now() < until) requestAnimationFrame(tick); else running = false; };
  const watch = (span = 700) => { until = Math.max(until, performance.now() + span); if (!running) { running = true; requestAnimationFrame(tick); } };
  for (const name of ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend", "animationcancel"]) document.addEventListener(name, () => watch(), true);
  document.addEventListener("scroll", () => watch(250), { capture: true, passive: true });
  for (const name of ["resize", "hub:material"]) window.addEventListener(name, () => watch());
  for (const name of ["pointerdown", "pointerup", "keydown"]) document.addEventListener(name, () => watch(400), { capture: true, passive: true });
  new MutationObserver(() => watch(120)).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "data-open", "data-state", "data-starting-style", "data-ending-style", "hidden", "open"] });
  setInterval(() => watch(60), 1000);
  watch();

  // The copy of the page behind the window. Until it is there the page's surfaces wait unseen (the stylesheet hides them while data-glass is
  // unset); without it they are the page's own glass.
  const begin = async () => {
    if (mirror !== null || html.dataset.material !== "liquid") return;
    const root = document.getElementById("root"), made = root === null || matchMedia("(prefers-reduced-transparency: reduce)").matches ? null : startMirror(root, SURFACES);
    if (made === null) { html.dataset.glass = "page"; return; }
    mirror = made;
    await made.ready;
    const state = await bridge.state().catch(() => null);
    if (state === null || state.layered !== true) { made.stop(); mirror = null; html.dataset.glass = "page"; return; }
    system = true; html.dataset.glass = "system";
    watch();
  };
  if (html.dataset.material === "liquid") void begin(); else window.addEventListener("hub:material", () => void begin(), { once: true });
}
