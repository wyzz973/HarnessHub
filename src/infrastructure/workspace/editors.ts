import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../../contracts/session.js";
import type { EditorView } from "../../contracts/web.js";
import { placeInWorkspace, workspaceRoot } from "./place.js";

/*
 * The editors of this Mac a conversation's workspace, or a file in it, opens in (2026-11-14): the page's "在编辑器中打开". An editor is there when its application bundle
 * is in /Applications or ~/Applications (where the official installers and the JetBrains Toolbox put them); it is opened with `open -a <bundle> <path>`, the way the Finder
 * would, so the editor's own handling of a folder or a file applies. Nothing is read from an editor's settings.
 */

interface Editor { readonly id: string; readonly name: string; readonly bundles: readonly string[] }
/** The editors looked for, in the order the page lists them; an editor is found by the first of its bundle names that is there. */
const EDITORS: readonly Editor[] = [
  { id: "vscode", name: "VS Code", bundles: ["Visual Studio Code.app", "Visual Studio Code - Insiders.app"] },
  { id: "cursor", name: "Cursor", bundles: ["Cursor.app"] },
  { id: "windsurf", name: "Windsurf", bundles: ["Windsurf.app"] },
  { id: "zed", name: "Zed", bundles: ["Zed.app", "Zed Preview.app"] },
  { id: "sublime", name: "Sublime Text", bundles: ["Sublime Text.app"] },
  { id: "xcode", name: "Xcode", bundles: ["Xcode.app"] },
  { id: "nova", name: "Nova", bundles: ["Nova.app"] },
  { id: "textmate", name: "TextMate", bundles: ["TextMate.app"] },
  { id: "intellij", name: "IntelliJ IDEA", bundles: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"] },
  { id: "webstorm", name: "WebStorm", bundles: ["WebStorm.app"] },
  { id: "pycharm", name: "PyCharm", bundles: ["PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app", "PyCharm Community Edition.app"] },
  { id: "goland", name: "GoLand", bundles: ["GoLand.app"] },
  { id: "rustrover", name: "RustRover", bundles: ["RustRover.app"] },
];
/** Where application bundles are looked for: the system's and the user's Applications folders. */
export function applicationFolders(): readonly string[] { return ["/Applications", join(homedir(), "Applications")]; }

/** The bundle of an editor that is installed, the first found; null when none of its bundles is there. */
async function bundleOf(editor: Editor, folders: readonly string[]): Promise<string | null> {
  for (const folder of folders) for (const bundle of editor.bundles) {
    const path = join(folder, bundle);
    try { if ((await stat(path)).isDirectory()) return path; } catch { /* not there */ }
  }
  return null;
}

/** The editors installed on this Mac, in the page's order. */
export async function installedEditors(folders: readonly string[] = applicationFolders()): Promise<readonly EditorView[]> {
  const found = await Promise.all(EDITORS.map(async editor => (await bundleOf(editor, folders)) === null ? null : { id: editor.id, name: editor.name }));
  return found.filter((entry): entry is EditorView => entry !== null);
}

/**
 * Opens the workspace, or `path` in it (relative to the workspace, or absolute), in the editor `id`. Refuses an editor it does not know (INVALID_INPUT), a path that leads out
 * of the workspace (INVALID_INPUT) or is not there (FILE_NOT_FOUND), and an editor that is not installed (EDITOR_NOT_FOUND), in that order; nothing is opened then.
 * Resolves once `open` has handed the request to the editor.
 */
export async function openInEditor(workspace: string, id: string, path?: string, folders: readonly string[] = applicationFolders()): Promise<void> {
  if (process.platform !== "darwin") throw new SessionError("EDITOR_UNSUPPORTED", "在编辑器中打开只在 macOS 上可用");
  const editor = EDITORS.find(entry => entry.id === id);
  if (editor === undefined) throw new SessionError("INVALID_INPUT", "不认识这个编辑器：" + id.slice(0, 64));
  const target = path === undefined ? await workspaceRoot(workspace) : (await placeInWorkspace(workspace, path, "只能打开这个对话工作区里的文件")).target;
  const bundle = await bundleOf(editor, folders);
  if (bundle === null) throw new SessionError("EDITOR_NOT_FOUND", editor.name + " 没有装在这台 Mac 上");
  await new Promise<void>((done, fail) => {
    execFile("/usr/bin/open", ["-a", bundle, target], { timeout: 10_000, maxBuffer: 64 * 1024 }, error => {
      if (error === null) { done(); return; }
      fail(new SessionError("EDITOR_OPEN_FAILED", editor.name + " 没能打开它：" + (error.message.split("\n", 1)[0] ?? "").slice(0, 200)));
    });
  });
}
