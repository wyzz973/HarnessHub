/** The desktop app around the page (desktop/preload.cts); null in a browser. */
export interface DesktopMenuEntry { readonly id?: string; readonly label?: string; readonly type?: "separator" | "checkbox"; readonly checked?: boolean; readonly enabled?: boolean; readonly keys?: string; readonly items?: readonly DesktopMenuEntry[] }
export interface WindowState { readonly focused: boolean; readonly fullscreen: boolean; readonly material?: "liquid" | "vibrancy"; readonly layered?: boolean }
/** A sheet of the system's glass under the page, in the page's pixels. `anchor` is the edges it holds to while the window is resized. */
export interface GlassPane { readonly id: string; readonly left: number; readonly top: number; readonly width: number; readonly height: number; readonly radius: number; readonly clear?: boolean; readonly alpha?: number; readonly anchor?: number }
interface Bridge {
  readonly platform: string;
  readonly initial?: WindowState;
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
  if (desktop.initial !== undefined) apply(desktop.initial);
  void desktop.state().then(apply, () => undefined);
}
