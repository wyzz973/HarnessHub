/**
 * Where the pointer stands on the glass it is over (Liquid Glass): the control or row under it carries the point as --px and --py, and the light on its
 * glass follows it (styles.css). Read once a frame; the point is taken off when the pointer leaves the element. Returns the function that stops it.
 */
const LIT = ".btn, .icon-btn, .quiet, .row, .nav-row, .plus-key, .send-key, .toast-action, .card-interactive, .menu-item";

export function followLight(root: Document = document): () => void {
  let lit: HTMLElement | null = null, over: Element | null = null, x = 0, y = 0, frame = 0;
  const apply = () => {
    frame = 0;
    const target = over?.closest<HTMLElement>(LIT) ?? null;
    if (lit !== null && lit !== target) { lit.style.removeProperty("--px"); lit.style.removeProperty("--py"); }
    lit = target;
    if (target === null) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty("--px", Math.round(x - box.left) + "px");
    target.style.setProperty("--py", Math.round(y - box.top) + "px");
  };
  const at = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    x = event.clientX; y = event.clientY; over = event.target instanceof Element ? event.target : null;
    if (frame === 0) frame = requestAnimationFrame(apply);
  };
  const gone = () => { over = null; if (frame === 0) frame = requestAnimationFrame(apply); };
  root.addEventListener("pointermove", at, { capture: true, passive: true });
  root.addEventListener("pointerdown", at, { capture: true, passive: true });
  root.documentElement.addEventListener("pointerleave", gone);
  return () => {
    root.removeEventListener("pointermove", at, { capture: true });
    root.removeEventListener("pointerdown", at, { capture: true });
    root.documentElement.removeEventListener("pointerleave", gone);
    if (frame !== 0) cancelAnimationFrame(frame);
    if (lit !== null) { lit.style.removeProperty("--px"); lit.style.removeProperty("--py"); }
  };
}
