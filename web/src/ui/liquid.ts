/*
 * Liquid Glass's refraction, for the surfaces that float over content (the message box, toolbar capsules, menus, pickers, dialogs, the palette,
 * toasts): at its rim a glass surface bends what is behind it, as a lens does. Each such element gets an SVG filter of its own size — a displacement
 * map that is neutral in the middle and pulls the backdrop inward along a bezel at the edge — named to the stylesheet as --lens, which puts it first
 * in the element's backdrop-filter. Only Chromium takes an SVG filter there (the desktop app is one); elsewhere, and with "reduce transparency",
 * nothing is added and the glass is the plain blur.
 */
const SURFACES = ".composer-box, .tool-group, .surface-pop, .dialog-pop, .palette-pop, .toast, .floating-bar, .follow-stream";
const SVG = "http://www.w3.org/2000/svg";

/** The map: red carries the shift across, blue the shift down; mid grey shifts nothing. The bezel is where the grey core fades into the two ramps. */
function lensMap(width: number, height: number, radius: number, bezel: number): string {
  const core = `<rect x="${bezel}" y="${bezel}" width="${Math.max(width - bezel * 2, 0)}" height="${Math.max(height - bezel * 2, 0)}" rx="${Math.max(radius - bezel, 0)}" fill="rgb(128,128,128)" filter="url(#soft)"/>`;
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="${SVG}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>`
    + `<linearGradient id="across" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#f00"/></linearGradient>`
    + `<linearGradient id="down" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#00f"/></linearGradient>`
    + `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(bezel * .5).toFixed(2)}"/></filter></defs>`
    + `<rect width="${width}" height="${height}" fill="#000"/><rect width="${width}" height="${height}" rx="${radius}" fill="url(#across)"/>`
    + `<rect width="${width}" height="${height}" rx="${radius}" fill="url(#down)" style="mix-blend-mode:screen"/>${core}</svg>`);
}

interface Lens { readonly filter: SVGFilterElement; readonly image: SVGFEImageElement; readonly shift: SVGFEDisplacementMapElement; size: string }

export function startLiquidGlass(): void {
  if (typeof CSS === "undefined" || !CSS.supports("backdrop-filter", "url(#lens)") || matchMedia("(prefers-reduced-transparency: reduce)").matches) return;
  const holder = document.createElementNS(SVG, "svg");
  holder.setAttribute("aria-hidden", "true"); holder.setAttribute("width", "0"); holder.setAttribute("height", "0");
  holder.style.cssText = "position:fixed;left:0;top:0;pointer-events:none";
  document.body.append(holder);
  const lenses = new Map<HTMLElement, Lens>();
  let count = 0;
  const fit = (element: HTMLElement) => {
    const lens = lenses.get(element), width = element.offsetWidth, height = element.offsetHeight;
    if (lens === undefined || width === 0 || height === 0) return;
    const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0, width / 2, height / 2), size = width + "x" + height + "r" + radius;
    if (size === lens.size) return;
    lens.size = size;
    // A thicker rim on a larger surface, never more than a third of its shorter side.
    const bezel = Math.round(Math.max(6, Math.min(18, Math.min(width, height) / 3)));
    lens.image.setAttribute("href", lensMap(width, height, radius, bezel));
    lens.shift.setAttribute("scale", String(Math.round(bezel * 2.2)));
  };
  const sizes = new ResizeObserver(entries => { for (const entry of entries) fit(entry.target as HTMLElement); });
  const scan = () => {
    for (const [element, lens] of lenses) if (!element.isConnected) { sizes.unobserve(element); lens.filter.remove(); lenses.delete(element); }
    for (const element of document.querySelectorAll<HTMLElement>(SURFACES)) {
      if (lenses.has(element)) continue;
      const id = "hh-lens-" + ++count, filter = document.createElementNS(SVG, "filter"), image = document.createElementNS(SVG, "feImage"), shift = document.createElementNS(SVG, "feDisplacementMap");
      // The filter covers the element's own box, and the map is stretched over it: it is drawn at the element's size, so nothing is scaled.
      for (const [name, value] of [["id", id], ["x", "0%"], ["y", "0%"], ["width", "100%"], ["height", "100%"], ["color-interpolation-filters", "sRGB"]] as const) filter.setAttribute(name, value);
      for (const [name, value] of [["x", "0%"], ["y", "0%"], ["width", "100%"], ["height", "100%"], ["preserveAspectRatio", "none"], ["result", "map"]] as const) image.setAttribute(name, value);
      for (const [name, value] of [["in", "SourceGraphic"], ["in2", "map"], ["xChannelSelector", "R"], ["yChannelSelector", "B"]] as const) shift.setAttribute(name, value);
      filter.append(image, shift); holder.append(filter);
      lenses.set(element, { filter, image, shift, size: "" });
      element.style.setProperty("--lens", `url(#${id})`);
      sizes.observe(element); fit(element);
    }
  };
  let queued = false;
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; scan(); }); } }).observe(document.body, { childList: true, subtree: true });
  scan();
}
