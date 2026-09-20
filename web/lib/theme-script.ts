export const THEME_STORAGE_KEY = "harnesshub.theme";
/**
 * Runs before first paint (see app/layout.tsx) so a stored dark choice never flashes light.
 * Light is the default; the system preference is not consulted.
 */
export const themeBootScript = `try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="dark")document.documentElement.classList.add("dark")}catch(e){}`;
