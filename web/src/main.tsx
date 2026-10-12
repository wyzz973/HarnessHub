import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles.css";
import { App } from "./App.js";
import { applyTheme, readPreferences } from "./lib/prefs.js";

const root = document.getElementById("root");
if (!root) throw new Error("HarnessHub root element missing");
// The chosen theme applies before the first paint; without a choice the stylesheet follows the system.
applyTheme(readPreferences().theme);
createRoot(root).render(<StrictMode><App /></StrictMode>);
