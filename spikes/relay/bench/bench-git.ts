// 原型，仅用于测量，不是实现。测量 7（可选）：在本工作区只读执行工作区观测命令，测 p50/p95；
// 另在临时目录的合成 git 仓库里核对这组参数能否挡住仓库配置触发的外部程序（clean 过滤器、fsmonitor、post-index-change 钩子）。
// 只读：GIT_OPTIONAL_LOCKS=0 让 status 不写索引；不传 -uall，不跑 hook；子进程只带白名单环境。
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { now, summary } from "./common.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE = join(HERE, "..", "..", "..");
/** 白名单环境：PATH（找到 git）、HOME（git 读用户级配置；v1 §1 不许建空 HOME）、LC_ALL=C、GIT_OPTIONAL_LOCKS=0、GIT_TERMINAL_PROMPT=0。 */
function whitelistEnv(): NodeJS.ProcessEnv { return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }; }
const STATUS = ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z"];
const DIFF = ["diff", "--numstat", "--no-ext-diff", "--no-textconv"];
const DIFF_FS = ["-c", "core.fsmonitor=false", "diff", "--numstat", "--no-ext-diff", "--no-textconv"];

function runGit(args: readonly string[], cwd: string, timeoutMs = 250): Promise<{ ms: number; bytes: number; code: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    const t = now(); let bytes = 0, timedOut = false;
    const child = spawn("git", args, { cwd, env: whitelistEnv(), stdio: ["ignore", "pipe", "ignore"], detached: true });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { bytes += d.length; });
    child.on("close", code => { clearTimeout(timer); resolve({ ms: now() - t, bytes, code, timedOut }); });
  });
}
async function series(label: string, fn: () => Promise<{ ms: number; timedOut: boolean; code: number | null }>, n: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 3; i++) await fn();
  const xs: number[] = []; let timeouts = 0, failures = 0;
  for (let i = 0; i < n; i++) { const r = await fn(); xs.push(r.ms); if (r.timedOut) timeouts++; if (r.code !== 0) failures++; }
  return { label, ...summary(xs, 2), timeoutsAt250ms: timeouts, nonZeroExit: failures };
}

export async function run(): Promise<Record<string, unknown>> {
  const env = whitelistEnv();
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: WORKTREE, env }).toString().split("\0").filter(Boolean).length;
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: WORKTREE, env }).toString().trim();
  const statusOut = execFileSync("git", STATUS, { cwd: WORKTREE, env }).toString();
  const n = 40;
  const timings = {
    status: await series("status --porcelain=v2 -z（-c core.fsmonitor=false）", () => runGit(STATUS, WORKTREE), n),
    diff: await series("diff --numstat --no-ext-diff --no-textconv（按任务原样）", () => runGit(DIFF, WORKTREE), n),
    diffWithFsmonitorOff: await series("diff …（加 -c core.fsmonitor=false）", () => runGit(DIFF_FS, WORKTREE), n),
    observation: await series("观测 = status 与 diff 并行，等两者结束", async () => { const t = now(); const [a, b] = await Promise.all([runGit(STATUS, WORKTREE), runGit(DIFF_FS, WORKTREE)]); return { ms: now() - t, timedOut: a.timedOut || b.timedOut, code: a.code !== 0 ? a.code : b.code }; }, n),
  };
  return { worktree: { trackedFiles: tracked, head, statusEntries: statusOut.split("\0").filter(Boolean).length, env: Object.keys(env) }, timings, safetyProbe: safetyProbe() };
}

/** 合成仓库里的执行面核对：每项返回外部程序被调用的次数（0 = 挡住了）。 */
export function safetyProbe(): Record<string, number> {
  const base = process.env.RELAY_SPIKE_TMP ?? os.tmpdir();
  const dir = mkdtempSync(join(base, "relay-spike-git-"));
  const repo = join(dir, "repo"), marker = join(dir, "MARKER");
  const g = (args: string[], extraEnv: NodeJS.ProcessEnv = {}): void => { try { execFileSync("git", args, { cwd: repo, env: { ...whitelistEnv(), ...extraEnv }, stdio: "ignore" }); } catch { /* 观测命令失败也算一次运行 */ } };
  const setup = (args: string[]): void => { execFileSync("git", ["-c", "user.email=spike@example.invalid", "-c", "user.name=spike", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "ignore" }); };
  const count = (): number => { if (!existsSync(marker)) return 0; const n = readFileSync(marker, "utf8").split("\n").filter(Boolean).length; rmSync(marker); return n; };
  const touch = (p: string, offsetS: number): void => { const t = new Date(Date.now() + offsetS * 1000); utimesSync(join(repo, p), t, t); };
  const out: Record<string, number> = {};
  try {
    execFileSync("mkdir", ["-p", repo]);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "hello\n"); writeFileSync(join(repo, ".gitattributes"), "*.txt filter=probe\n");
    setup(["add", "-A"]); setup(["commit", "-q", "-m", "base"]);
    execFileSync("git", ["config", "filter.probe.clean", "sh -c 'echo clean >> \"" + marker + "\"; cat'"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "hello world 2\n"); touch("a.txt", 2);
    g(STATUS); out["status：内容与大小都变了 → clean 过滤器运行次数"] = count();
    g(DIFF); out["diff --numstat（按任务原样）→ clean 过滤器运行次数"] = count();
    g(["--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-c", "core.attributesFile=/dev/null", ...DIFF_FS]); out["diff 加 --attr-source=<空树> → clean 过滤器运行次数"] = count();
    g(["-c", "filter.probe.clean=", ...DIFF_FS]); out["diff 加 -c filter.probe.clean= → clean 过滤器运行次数"] = count();
    execFileSync("mkdir", ["-p", join(repo, ".git", "info")]); writeFileSync(join(repo, ".git", "info", "attributes"), "*.txt filter=probe\n");
    g(["--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-c", "core.attributesFile=/dev/null", ...DIFF_FS]); out["diff 加 --attr-source=<空树>，但 .git/info/attributes 里有过滤属性 → clean 过滤器运行次数"] = count();
    rmSync(join(repo, ".git", "info", "attributes"));
    execFileSync("git", ["checkout", "-q", "--", "a.txt"], { cwd: repo }); touch("a.txt", 4);
    g(STATUS); out["status：只改 mtime（内容相同）→ clean 过滤器运行次数"] = count();
    execFileSync("git", ["config", "--unset", "filter.probe.clean"], { cwd: repo });
    const hook = join(dir, "fsmon.sh"); writeFileSync(hook, "#!/bin/sh\necho fsmon >> \"" + marker + "\"\nexit 1\n"); chmodSync(hook, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "hello again\n"); touch("a.txt", 6);
    g(DIFF); out["diff（按任务原样，无 -c core.fsmonitor=false）→ fsmonitor 钩子运行次数"] = count();
    g(DIFF_FS); out["diff 加 -c core.fsmonitor=false → fsmonitor 钩子运行次数"] = count();
    g(STATUS); out["status 加 -c core.fsmonitor=false → fsmonitor 钩子运行次数"] = count();
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: repo });
    const pic = join(repo, ".git", "hooks", "post-index-change"); writeFileSync(pic, "#!/bin/sh\necho pic >> \"" + marker + "\"\n"); chmodSync(pic, 0o755);
    touch("a.txt", 8);
    g(STATUS); out["status（GIT_OPTIONAL_LOCKS=0）→ post-index-change 钩子运行次数"] = count();
    touch("a.txt", 10);
    g(STATUS, { GIT_OPTIONAL_LOCKS: "1" }); out["status（GIT_OPTIONAL_LOCKS=1，对照）→ post-index-change 钩子运行次数"] = count();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

if (import.meta.main) console.log(JSON.stringify(await run(), null, 2));
