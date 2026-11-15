import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Agent SDK and the user's `claude` side by side (research of 2026-11-14 §1): SDK 0.3.N is paired with Claude Code 2.1.N, and a CLI is tested
 * against older SDKs, never newer ones. Checked once per executable in this Gateway process: what the paired CLI has and the user's lacks is turned
 * off with one diagnostic line, nothing is asked of the user. `capabilities` of the CLI's own init (system/init) refine it per process.
 */
export type ClaudeFeature = "steer" | "rollback" | "lifecycle";
/**
 * The oldest Claude Code each feature is taken to need: priority with a person's origin from 2.1.286 (the SDK's docs); truncating resume and command
 * lifecycles as of 2.1.300, a cautious floor not checked on older ones (the CLI's own `msg_lifecycle_v1` refines the lifecycles per process).
 */
const MINIMUM: Readonly<Record<ClaudeFeature, string>> = { steer: "2.1.286", rollback: "2.1.300", lifecycle: "2.1.300" };
const NAMES: Readonly<Record<ClaudeFeature, string>> = { steer: "插话", rollback: "按轮回退", lifecycle: "输入确认" };
export interface ClaudeCompat {
  /** The user's Claude Code, as `claude --version` says; null when it does not say. */
  readonly cli: string | null;
  /** The Claude Code the installed SDK is paired with (its package's `claudeCodeVersion`). */
  readonly paired: string | null;
  readonly sdk: string | null;
  readonly off: ReadonlySet<ClaudeFeature>;
  readonly diagnostic: string | null;
}
const checked = new Map<string, Promise<ClaudeCompat>>();
const VERSION_TIMEOUT_MS = 10_000;

function parts(version: string): readonly number[] { return version.split(".").map(part => Number.parseInt(part, 10)); }
/** -1, 0 or 1 as `left` is older than, the same as or newer than `right`, by their dotted numbers. */
export function compareVersions(left: string, right: string): number {
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) { const x = a[index] ?? 0, y = b[index] ?? 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
async function sdkPackage(): Promise<{ readonly version: string | null; readonly paired: string | null }> {
  try {
    const main = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const row = JSON.parse(await readFile(join(dirname(main), "package.json"), "utf8")) as Record<string, unknown>;
    return { version: typeof row.version === "string" ? row.version : null, paired: typeof row.claudeCodeVersion === "string" ? row.claudeCodeVersion : null };
  } catch { return { version: null, paired: null }; }
}
function cliVersion(executable: string, env: Readonly<Record<string, string>>): Promise<string | null> {
  return new Promise(resolve => execFile(executable, ["--version"], { env, timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
    resolve(error ? null : /^(\d+\.\d+\.\d+)/u.exec(String(stdout).trim())?.[1] ?? null);
  }));
}
/** What the user's CLI lacks of what the paired one has, by version; the line said once when something is off or the versions differ far. */
export function compatibility(cli: string | null, paired: string | null, sdk: string | null): ClaudeCompat {
  const off = new Set<ClaudeFeature>(), said: string[] = [];
  if (cli !== null) for (const [feature, minimum] of Object.entries(MINIMUM) as [ClaudeFeature, string][]) if (compareVersions(cli, minimum) < 0) { off.add(feature); said.push(NAMES[feature]); }
  let diagnostic: string | null = null;
  if (cli === null) diagnostic = "没能读到 Claude Code 的版本，按已知能力运行。";
  else if (paired !== null && compareVersions(cli, paired) < 0)
    diagnostic = "这个 Claude Code（" + cli + "）比 HarnessHub 配对的版本（" + paired + "）旧，新版本才有的功能可能用不了" + (said.length ? "，已关闭：" + said.join("、") : "") + "。升级 Claude Code 后自动恢复。";
  else if (paired !== null && parts(cli)[0] === parts(paired)[0] && parts(cli)[1] === parts(paired)[1] && (parts(cli)[2] ?? 0) - (parts(paired)[2] ?? 0) > 30)
    diagnostic = "这个 Claude Code（" + cli + "）比 HarnessHub 配对的版本（" + paired + "）新很多，按已知能力运行。";
  return { cli, paired, sdk, off, diagnostic };
}
/** The pairing of this executable, read once per file (its path and modification time: an upgrade in place is read again) in this process. */
export async function checkCompat(executable: string, env: Readonly<Record<string, string>>): Promise<ClaudeCompat> {
  const key = executable + "\0" + await stat(executable).then(info => String(info.mtimeMs), () => "");
  let check = checked.get(key);
  if (check === undefined) {
    check = Promise.all([cliVersion(executable, env), sdkPackage()]).then(([cli, sdk]) => compatibility(cli, sdk.paired, sdk.version));
    checked.set(key, check);
    // A version read that failed is read again by the next connection (the user may have fixed the install).
    void check.then(result => { if (result.cli === null) checked.delete(key); });
  }
  return check;
}
