import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { App } from "./App.js";
import { applyTheme, readPreferences } from "./lib/prefs.js";
import { trackInputModality } from "./ui/motion.js";
import { ToastProvider } from "./ui/overlay.js";

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
followThemeColor(document.documentElement);
// Actions started from the keyboard finish without animation (ADR-054 §3); this lives as long as the document.
trackInputModality();
// Interface icons are Lucide at a 1.75 stroke (ADR-054 §4); an icon may still pass its own strokeWidth.
createRoot(root).render(<StrictMode><LucideProvider strokeWidth={1.75}><ToastProvider><App /></ToastProvider></LucideProvider></StrictMode>);
