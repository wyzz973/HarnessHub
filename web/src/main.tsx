import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { App } from "./App.js";
import { applyTheme, readPreferences } from "./lib/prefs.js";
import { desktop, followWindow } from "./lib/desktop.js";
import { followMenu } from "./lib/keys.js";
import { trackDepartures, trackInputModality } from "./ui/motion.js";
import { ToastProvider } from "./ui/overlay.js";
import { startSystemGlass } from "./ui/glass.js";
import { startLiquidGlass } from "./ui/liquid.js";
import { startTitleTips } from "./ui/tips.js";
import { followLight } from "./ui/light.js";

/**
 * Keeps the browser's theme color (the window or tab bar around the page) on the theme the page shows. index.html gives
 * each system scheme its main-area color; a manual choice, which applyTheme records as data-theme on the root element,
 * puts that theme's color in both, and "system" puts them back, so the media queries follow the system's own changes.
 * Lives as long as the document, like the theme it follows.
 */
function followThemeColor(html: HTMLElement): void {
  const metas = [...document.querySelectorAll<HTMLMetaElement>("meta[name='theme-color'][data-theme-color]")];
  const colors = new Map(metas.map(meta => [meta.dataset.themeColor, meta.content]));
  const apply = () => {
    const chosen = html.dataset.theme === undefined ? undefined : colors.get(html.dataset.theme);
    for (const meta of metas) meta.content = chosen ?? colors.get(meta.dataset.themeColor) ?? meta.content;
  };
  apply();
  new MutationObserver(apply).observe(html, { attributes: true, attributeFilter: ["data-theme"] });
}

const root = document.getElementById("root");
if (!root) throw new Error("HarnessHub root element missing");
// The chosen theme applies before the first paint, and the browser's theme color with it; without a choice both follow
// the system.
applyTheme(readPreferences().theme);
// In the desktop app the root element says so, with the window's state, and the menu bar's commands reach the page.
followWindow(document.documentElement);
followMenu();
followThemeColor(document.documentElement);
// Actions started from the keyboard finish without animation (ADR-054 §3); this lives as long as the document.
trackInputModality();
followLight();
// What is taken off the page by itself (a row, a notice, a bar) leaves with a motion of its own.
trackDepartures();
// Glass surfaces bend what is behind them at their rim (Chromium only: the desktop app).
startLiquidGlass();
// Interface icons are Lucide, drawn with one line weight at every size: 1.2 px on the screen (a stroke given in the icon's own 24 units came out thinner the
// smaller the icon, and each small icon then carried a heavier stroke of its own to make up for it).
createRoot(root).render(<StrictMode><LucideProvider strokeWidth={1.2} absoluteStrokeWidth><ToastProvider><App /></ToastProvider></LucideProvider></StrictMode>);
// In the desktop app on macOS 26 the glass is the system's own, laid under the page.
startSystemGlass();
// And a title is shown as one of the page's own tips.
if (desktop !== null) startTitleTips();
