// SPDX-License-Identifier: MIT
export const THEME_STORAGE_KEY = "harnesshub.theme";
/**
 * Runs before first paint so a stored dark choice never flashes light. The
 * page's CSP admits no inline script, so vite.config.ts serves this text as
 * `/theme-boot.js`, which index.html loads synchronously in `<head>`.
 * Light is the default; the system preference is not consulted.
 */
export const themeBootScript = `try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="dark")document.documentElement.classList.add("dark")}catch(e){}`;
