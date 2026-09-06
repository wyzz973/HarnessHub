/** Windows command transport shared by repository launchers; process-tree ownership stays with their caller. */
import spawn from "cross-spawn";
import { statSync } from "node:fs";
import path from "node:path";

function value(environment, name) {
  return Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
}

function windowsExecutable(command, environment) {
  if (path.isAbsolute(command) || /[/\\]/.test(command)) return command;
  const supported = [".exe", ".com", ".cmd", ".bat", ".ps1"];
  const extensions = [
    ...new Set([
      ...(value(environment, "pathext") ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((entry) => entry.toLowerCase())
        .filter((entry) => supported.includes(entry)),
      ...supported,
    ]),
  ];
  const names = path.extname(command)
    ? [command]
    : [...extensions.map((extension) => command + extension), command];
  for (const raw of (value(environment, "path") ?? "").split(";")) {
    const directory = raw.replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(directory)) continue;
    for (const name of names) {
      const location = path.join(directory, name);
      try {
        if (statSync(location).isFile()) return location;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code))
          throw error;
      }
    }
  }
  return command;
}

/** Spawn separate argv, supporting Windows PowerShell scripts and rejecting lossy multiline batch arguments. */
export function spawnEngine(command, suppliedArgs, options = {}) {
  const args = [...suppliedArgs];
  const environment = options.env ?? process.env;
  let executable = command;
  if (process.platform === "win32") {
    executable = windowsExecutable(command, environment);
    const extension = path.extname(executable).toLowerCase();
    if (
      ![".exe", ".com", ".ps1"].includes(extension) &&
      args.some((arg) => /[\r\n]/.test(arg))
    ) {
      throw new Error(
        "Windows batch launch requires single-line arguments; use stdin or a native executable for multiline input",
      );
    }
    if (extension === ".ps1") {
      const systemRoot = value(environment, "systemroot");
      if (!systemRoot || !path.isAbsolute(systemRoot))
        throw new Error("Missing Windows system directory");
      // Process-scoped policy leaves machine/user settings and Group Policy intact.
      args.unshift(
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        executable,
      );
      executable = path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
    }
  }
  return spawn(executable, args, {
    ...options,
    windowsHide: true,
    detached: false,
  });
}
