/*
 * In the desktop app a `title` is shown as the app's own tip, not the system's yellow one: the same glass, the same delay and place as the tips
 * the page draws itself (ui/primitives.tsx Tip). The words move from `title` to the element's accessible description as the pointer first
 * comes over it (to its name, where it has none), so nothing the system would show is left and assistive technology still reads them.
 */
const WAIT = 500, AGAIN = 300;

export function startTitleTips(): void {
  let tip: HTMLDivElement | null = null, over: Element | null = null, timer = 0, hidden = 0;
  const hide = () => {
    window.clearTimeout(timer); over = null;
    if (tip !== null) { tip.remove(); tip = null; hidden = performance.now(); }
  };
  const show = (element: Element, words: string) => {
    if (!element.isConnected || over !== element) return;
    tip = document.createElement("div");
    tip.className = "tooltip-pop title-tip"; tip.setAttribute("role", "presentation"); tip.textContent = words;
    document.body.append(tip);
    const box = element.getBoundingClientRect(), own = tip.getBoundingClientRect(), gap = 6;
    const below = box.bottom + gap + own.height <= innerHeight - 8;
    tip.style.left = Math.round(Math.min(Math.max(box.left + box.width / 2 - own.width / 2, 8), innerWidth - own.width - 8)) + "px";
    tip.style.top = Math.round(below ? box.bottom + gap : Math.max(box.top - gap - own.height, 8)) + "px";
  };
  document.addEventListener("pointerover", event => {
    if (event.pointerType === "touch") return;
    const element = (event.target as Element | null)?.closest?.("[title], [data-tip]") ?? null;
    if (element === over) return;
    hide();
    if (element === null) return;
    const title = element.getAttribute("title");
    if (title !== null) {
      element.removeAttribute("title");
      if (title.trim() === "") return;
      element.setAttribute("data-tip", title);
      if (!element.hasAttribute("aria-label") && !element.hasAttribute("aria-labelledby") && (element.textContent ?? "").trim() === "") element.setAttribute("aria-label", title);
      else if (!element.hasAttribute("aria-description") && element.getAttribute("aria-label") !== title) element.setAttribute("aria-description", title);
    }
    const words = element.getAttribute("data-tip");
    if (!words) return;
    over = element;
    // Moving from one tip to the next shows the next at once.
    timer = window.setTimeout(() => show(element, words), performance.now() - hidden < AGAIN ? 0 : WAIT);
  }, true);
  for (const name of ["pointerdown", "keydown", "wheel"]) document.addEventListener(name, hide, { capture: true, passive: true });
  document.addEventListener("pointerleave", hide);
  window.addEventListener("blur", hide);
}
