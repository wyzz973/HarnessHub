import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

interface WindowState { readonly focused: boolean; readonly fullscreen: boolean }
interface MenuEntry { readonly id?: string; readonly label?: string; readonly type?: "separator" | "checkbox"; readonly checked?: boolean; readonly enabled?: boolean; readonly danger?: boolean; readonly keys?: string; readonly items?: readonly MenuEntry[] }

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const heard = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, heard);
  return () => { ipcRenderer.off(channel, heard); };
}

contextBridge.exposeInMainWorld("hubDesktop", {
  platform: process.platform,
  state: (): Promise<WindowState> => ipcRenderer.invoke("hub:state"),
  onState: (listener: (state: WindowState) => void) => listen("hub:state", listener),
  onCommand: (listener: (command: string) => void) => listen("hub:command", listener),
  /** A native menu at the pointer; resolves with the chosen entry's id, or null. */
  menu: (entries: readonly MenuEntry[], at?: { readonly x: number; readonly y: number }): Promise<string | null> => ipcRenderer.invoke("hub:menu", entries, at),
  setKeys: (keys: Readonly<Record<string, string>>): void => ipcRenderer.send("hub:keys", keys),
  setChecks: (checks: Readonly<Record<string, boolean>>): void => ipcRenderer.send("hub:checks", checks),
  setActivity: (activity: { readonly running: number; readonly waiting: number }): void => ipcRenderer.send("hub:activity", activity),
  setTheme: (theme: "system" | "light" | "dark"): void => ipcRenderer.send("hub:theme", theme),
  pickFolder: (start?: string): Promise<string | null> => ipcRenderer.invoke("hub:pick-folder", start),
});
