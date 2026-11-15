/** The desktop app around the page (desktop/preload.cts); null in a browser. */
export interface DesktopMenuEntry { readonly id?: string; readonly label?: string; readonly type?: "separator" | "checkbox"; readonly checked?: boolean; readonly enabled?: boolean; readonly keys?: string; readonly items?: readonly DesktopMenuEntry[] }
export interface WindowState { readonly focused: boolean; readonly fullscreen: boolean; readonly material?: "liquid" | "vibrancy" }
export interface GlassPane { readonly id: string; readonly left: number; readonly top: number; readonly width: number; readonly bottom: number; readonly radius: number }
interface Bridge {
  readonly platform: string;
  state(): Promise<WindowState>;
  onState(listener: (state: WindowState) => void): () => void;
  onCommand(listener: (command: string) => void): () => void;
  menu(entries: readonly DesktopMenuEntry[], at?: { readonly x: number; readonly y: number }): Promise<string | null>;
  setKeys(keys: Readonly<Record<string, string>>): void;
  setChecks(checks: Readonly<Record<string, boolean>>): void;
  setActivity(activity: { readonly running: number; readonly waiting: number }): void;
  setTheme(theme: "system" | "light" | "dark"): void;
  pickFolder(start?: string): Promise<string | null>;
  setGlass?(panes: readonly GlassPane[]): void;
}
export const desktop: Bridge | null = (window as unknown as { readonly hubDesktop?: Bridge }).hubDesktop ?? null;

/** A menu command the page has no key for (the others arrive as their own key press). */
export const COMMAND_EVENT = "hub:command";
export function onCommand(listener: (command: string) => void): () => void {
  const heard = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(COMMAND_EVENT, heard);
  return () => window.removeEventListener(COMMAND_EVENT, heard);
}

/** The window's state on the root element, where the stylesheet reads it: its shell, whether it is the key window, whether it fills the screen. */
export function followWindow(html: HTMLElement): void {
  if (desktop === null) return;
  html.dataset.shell = "desktop";
  const apply = (state: WindowState) => {
    html.dataset.window = state.focused ? "key" : "inactive"; html.toggleAttribute("data-fullscreen", state.fullscreen);
    if (state.material !== undefined && html.dataset.material !== state.material) { html.dataset.material = state.material; window.dispatchEvent(new Event("hub:material")); }
  };
  desktop.onState(apply);
  void desktop.state().then(apply, () => undefined);
}

/**
 * The sidebar's pane is an opening onto the window: with the system's Liquid Glass the window is told where the opening is, and lays a pane of glass
 * under it. The pane stands still (the sidebar leaves by being covered), so this is said when it is laid out and when the window's size or zoom changes.
 */
export function followPane(element: HTMLElement | null): () => void {
  if (desktop === null || desktop.setGlass === undefined || element === null) return () => undefined;
  const tell = () => {
    if (document.documentElement.dataset.material !== "liquid") return;
    const box = element.getBoundingClientRect();
    if (box.width === 0) return;
    desktop!.setGlass!([{ id: "sidebar", left: box.left, top: box.top, width: box.width, bottom: window.innerHeight - box.bottom, radius: parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0 }]);
  };
  const sizes = new ResizeObserver(tell); sizes.observe(element);
  window.addEventListener("resize", tell); window.addEventListener("hub:material", tell);
  tell();
  return () => { sizes.disconnect(); window.removeEventListener("resize", tell); window.removeEventListener("hub:material", tell); };
}
