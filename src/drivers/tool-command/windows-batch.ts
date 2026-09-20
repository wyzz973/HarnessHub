import path from "node:path";

/**
 * Characters that cmd.exe expands or re-parses even inside double quotes
 * (`%VAR%` expansion, quote toggling) and line breaks that end the command.
 * They cannot be passed to a batch file without changing its argv, so
 * arguments containing them are rejected instead of being rewritten.
 */
const UNSAFE = /["%\r\n\0]/;

/** True for Windows batch entries, which Node refuses to spawn without a shell. */
export function isWindowsBatch(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
}

/**
 * Quotes one argument for a batch invocation. Everything else (`&|<>()^!`,
 * spaces, non-ASCII) is literal inside double quotes for both the outer
 * `cmd /s /c` parse and the batch file's own `%*`/`%1` expansion. Trailing
 * backslashes are doubled so CommandLineToArgvW in the final program does not
 * read them as an escaped closing quote.
 * @throws Error when the value contains `"`, `%`, CR, LF or NUL.
 */
export function quoteBatchArgument(value: string): string {
  if (UNSAFE.test(value))
    throw new Error(
      'Windows batch arguments cannot contain ", %, CR, LF or NUL; use a native executable for such values',
    );
  return `"${value.replace(/(\\+)$/, "$1$1")}"`;
}

/** The complete `/c` payload: the quoted batch path followed by quoted arguments. */
export function windowsBatchCommandLine(
  command: string,
  args: readonly string[],
): string {
  if (!path.win32.isAbsolute(command) || !isWindowsBatch(command))
    throw new Error("A Windows batch entry must be an absolute .cmd/.bat path");
  return [command, ...args].map(quoteBatchArgument).join(" ");
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : environment[key];
}

/**
 * Builds the argv for `cmd.exe /d /s /v:off /c "<line>"`. The caller must
 * spawn it with `windowsVerbatimArguments: true` and `shell: false`, exactly as
 * Node does for `shell: true`. `/d` skips AutoRun commands and `/v:off` keeps
 * delayed expansion from rewriting `!` in the outer parse; the batch file can
 * still change its own expansion mode. The interpreter comes from an absolute
 * ComSpec ending in cmd.exe or from %SystemRoot%\System32, never from PATH.
 * @throws Error for unsafe arguments or when no absolute cmd.exe is known.
 */
export function windowsBatchLaunch(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): { file: string; args: string[] } {
  const line = windowsBatchCommandLine(command, args);
  const comspec = environmentValue(environment, "ComSpec");
  const systemRoot = environmentValue(environment, "SystemRoot");
  const file =
    comspec &&
    path.win32.isAbsolute(comspec) &&
    path.win32.basename(comspec).toLowerCase() === "cmd.exe"
      ? comspec
      : systemRoot && path.win32.isAbsolute(systemRoot)
        ? path.win32.join(systemRoot, "System32", "cmd.exe")
        : undefined;
  if (!file)
    throw new Error(
      "Cannot locate cmd.exe: ComSpec or SystemRoot must be an absolute path",
    );
  return { file, args: ["/d", "/s", "/v:off", "/c", `"${line}"`] };
}
