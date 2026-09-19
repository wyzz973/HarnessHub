"use client";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const clientIsWindows = () =>
  /Windows|Win32|Win64/i.test(navigator.userAgent) ||
  /^Win/i.test(navigator.platform);
/**
 * The console accepts loopback requests only, so the browser runs on the Gateway host and
 * its OS decides path examples. Server rendering and hydration use the neutral POSIX text.
 */
export function useWindowsPaths(): boolean {
  return useSyncExternalStore(subscribe, clientIsWindows, () => false);
}
const clientIsMac = () =>
  /Mac|iPhone|iPad/i.test(navigator.platform) ||
  /Mac OS X/i.test(navigator.userAgent);
/** Whether shortcuts are shown with ⌘ instead of Ctrl; false during server rendering. */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribe, clientIsMac, () => false);
}
/** Placeholder paths only; nothing here is read or validated as a real location. */
export function pathExamples(windows: boolean) {
  return windows
    ? {
        skill: "C:\\HarnessHub\\skills\\my-skill\\SKILL.md",
        keyFile: "C:\\HarnessHub\\secrets\\model.key",
        mcpCommand: "C:\\HarnessHub\\tools\\mcp-server.exe",
        toolPack: "C:\\HarnessHub\\tool-packs\\workspace-tools",
      }
    : {
        skill: "/absolute/path/to/skill/SKILL.md",
        keyFile: "/absolute/path/to/key",
        mcpCommand: "/absolute/path/to/mcp-server",
        toolPack: "/absolute/path/to/tool-pack",
      };
}
