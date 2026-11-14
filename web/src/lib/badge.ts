/*
 * The tab's icon carries how many things wait for the user (2026-11-14, after T3 Code): the page's own icon with a red dot and the count on it, and the icon as it
 * was once nothing waits. Drawn on a canvas from the icon the page already has, so nothing is loaded from elsewhere.
 */
let original: string | null = null, drawn = -1, picture: HTMLImageElement | null = null;

function link(): HTMLLinkElement | null { return document.querySelector<HTMLLinkElement>('link[rel~="icon"]'); }

export function setBadge(count: number): void {
  const icon = link();
  if (icon === null || count === drawn) return;
  original ??= icon.href;
  drawn = count;
  if (count <= 0) { icon.href = original; return; }
  const draw = (image: HTMLImageElement) => {
    if (drawn !== count) return;
    const canvas = document.createElement("canvas"), size = 64;
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.drawImage(image, 0, 0, size, size);
    const radius = 19, x = size - radius, y = radius;
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fillStyle = "#e5484d"; context.fill();
    context.fillStyle = "#ffffff"; context.font = "600 26px -apple-system, BlinkMacSystemFont, sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(count > 9 ? "9+" : String(count), x, y + 1);
    icon.href = canvas.toDataURL("image/png");
  };
  if (picture !== null && picture.complete) { draw(picture); return; }
  picture = new Image();
  picture.onload = () => { if (picture !== null) draw(picture); };
  picture.src = original;
}
