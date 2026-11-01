import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { App } from "./App.js";
import { applyTheme, readPreferences } from "./lib/prefs.js";
import { trackInputModality } from "./ui/motion.js";
import { ToastProvider } from "./ui/overlay.js";

const root = document.getElementById("root");
if (!root) throw new Error("HarnessHub root element missing");
// The chosen theme applies before the first paint; without a choice the stylesheet follows the system.
applyTheme(readPreferences().theme);
// Actions started from the keyboard finish without animation (ADR-054 §3); this lives as long as the document.
trackInputModality();
// Interface icons are Lucide at a 1.75 stroke (ADR-054 §4); an icon may still pass its own strokeWidth.
createRoot(root).render(<StrictMode><LucideProvider strokeWidth={1.75}><ToastProvider><App /></ToastProvider></LucideProvider></StrictMode>);
