import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Why the system's folder dialog could not be shown; the page then lets the user type the path. */
export class FolderDialogUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "FolderDialogUnavailable"; }
}

/** The dialog now open, if any: a second request joins it rather than opening another. */
let open: Promise<string | null> | null = null;

// JXA: bring the dialog to the front, open at `start` when given, print the chosen folder's POSIX path.
const SCRIPT = `function run(argv) {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.activate();
  var options = { withPrompt: argv[0] };
  if (argv[1]) options.defaultLocation = Path(argv[1]);
  return app.chooseFolder(options).toString();
}`;

/**
 * Shows macOS's own folder dialog and returns the folder the user chose, or null when they cancelled. The Gateway runs on
 * the user's Mac beside the browser, so the dialog is theirs to answer; `signal` closes it when the request goes away.
 */
export function chooseFolder(input: { readonly prompt: string; readonly start?: string | undefined; readonly signal?: AbortSignal | undefined }): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.reject(new FolderDialogUnavailable("the folder dialog is macOS only"));
  if (open !== null) return open;
  const asked = new Promise<string | null>((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", SCRIPT, input.prompt, input.start ?? ""], { encoding: "utf8", maxBuffer: 64 * 1024, ...(input.signal === undefined ? {} : { signal: input.signal }) },
      (error, stdout, stderr) => {
        if (error === null) { const path = stdout.replace(/\r?\n$/u, ""); resolve(path.startsWith("/") ? path : null); return; }
        // -128 is the user's own cancel; a closed request is one too.
        if (error.name === "AbortError" || /-128|User canceled/iu.test(String(stderr))) { resolve(null); return; }
        reject(new FolderDialogUnavailable(String(stderr).slice(0, 200) || error.message));
      });
  });
  open = asked.finally(() => { open = null; });
  return open;
}

/**
 * The folder of a conversation started without one: a new folder of its own under `root`, named by the day and by the
 * request that made it, so the same request names the same folder. Returned as the canonical path.
 */
export async function scratchFolder(root: string, commandId: string, now: Date = new Date()): Promise<string> {
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const path = join(root, day + "-" + createHash("sha256").update(commandId).digest("hex").slice(0, 8));
  await mkdir(path, { recursive: true });
  return realpath(path);
}
