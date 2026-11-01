import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The read-only preflight of ADR-051 A2, run before `hermes acp` is started. From v0.22.3 that command is a viewer of the
 * user's Hermes gateway: `connect_gateway` (hermes_cli/gateway_client.py:262-299 at v0.22.4+70.g4e58c72) calls
 * `ensure_gateway_runtime(home, idle_exit=True)` (hermes_cli/gateway_runtime.py:390-495), which attaches to a `ready` owner
 * and otherwise acts on the user's machine: it stops and replaces an owner of an older runtime protocol
 * (gateway_runtime.py:366-387, 394-398), waits up to 60 s for one that is starting or draining (gateway_runtime.py:20,
 * 435-440, 488-489), starts a registered launchd service with `launchctl kickstart`/`bootstrap`
 * (hermes_cli/gateway_runtime_service.py:186-218, 276-296) or spawns an unsupervised idle-exit daemon
 * (gateway_runtime.py:461-483). HarnessHub never does any of that for the user: it reads the same facts from files and
 * judges them (A–E); only A opens a session. The judgement is an approximation of what the viewer's live `identify` over
 * `gateway.sock` would decide: between this check and `session/new` the gateway can change, which every refusal says.
 *
 * Reads only the files named in `GATEWAY_FILES` and `CHECKOUT_FILES` under the Hermes home and the installed checkout,
 * never `.env`, `auth.json`, `config.yaml` or `state.db`; the host is asked two read-only questions (`launchctl print`,
 * `ps`), both injectable so tests never touch it.
 */

/** Hermes's launchd label for its account default home; a profile or another root gets a suffix (gateway_runtime_service.py:37-58, 186-189). */
export const HERMES_LAUNCHD_LABEL = "ai.hermes.gateway";
/** The viewer waits this long for a gateway that is starting before it reports `Gateway starting: deadline` (gateway_runtime.py:20). */
export const HERMES_ENSURE_TIMEOUT_S = 60;
/** The files of a Hermes home the preflight reads, and nothing else there. */
export const GATEWAY_FILES = ["gateway.sock", "gateway.sock.path", "gateway_state.json", "gateway.pid", "gateway.lock", ".hermes-update-in-progress", "active_profile"] as const;
/** The files of the installed checkout the preflight reads: its identity, whether it holds the gateway viewer, and an update fence. */
export const CHECKOUT_FILES = ["install-stamp.json", "acp_adapter/gateway_server.py", ".hermes-update-in-progress"] as const;
/** A recorded start time (centiseconds on macOS, gateway/status.py:472-503) and the live one may differ by the clock step `ps` and psutil round differently. */
const START_TIME_TOLERANCE_MS = 5000;
const RECORD_BYTES = 64 * 1024, POINTER_BYTES = 4096;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const COMMIT = /^[0-9a-f]{7,64}$/u;
/**
 * A live command line that hosts the gateway runtime (gateway/status.py `_gateway_command_subcommand` and
 * `looks_like_gateway_runtime_command_line`, lines 592-663): a Hermes entry point with `gateway run` or `gateway restart`, or
 * the dedicated `gateway/run.py` / `-m gateway.run` entry. The launchd job's `osascript` wrapper carries the gateway argv in
 * its script and is not the gateway (status.py:620-623); `gateway status` and `tui_gateway` are not either.
 */
const GATEWAY_COMMAND = /(?:^|\s)gateway\s+(?:run|restart)(?:\s|$)|(?:^|[\s/])gateway\/run\.py(?:\s|$)|\s-m\s+gateway\.run(?:\s|$)/u;

/** One of Hermes's gateway identity records: `gateway.pid`, `gateway.lock` and the process fields of `gateway_state.json` (gateway/status.py:786-794). */
export interface GatewayRecord {
  readonly pid: number | null;
  /** The process start time Hermes recorded at spawn, in its own units (centiseconds since the epoch on macOS). */
  readonly startTime: number | null;
  readonly hermesHome: string | null;
  readonly kind: string | null;
  readonly argv: readonly string[] | null;
}
/** `gateway_state.json` (gateway/status.py:1097-1156): the owner's process record plus its state and the code it booted from. */
export interface GatewayStateFacts extends GatewayRecord {
  readonly gatewayState: string | null;
  /** The commit the running gateway booted from (`_get_code_identity_fields`, status.py:799-813). */
  readonly codeSha: string | null;
  readonly updatedAt: string | null;
  /** The messaging platforms the gateway serves (its `platforms` keys), evidence of who shares it. */
  readonly platforms: readonly string[];
}
/** What `ps` says about the recorded pid: alive, when it started (epoch milliseconds) and its command line. */
export interface ProcessFact { readonly startedAt: number | null; readonly command: string }
/** `launchctl print gui/<uid>/<label>`: loaded (exit 0) with its top-level state and pid, absent (exit 113) or not answerable. */
export interface LaunchdFact {
  readonly label: string;
  readonly status: "loaded" | "absent" | "unknown";
  readonly state: string | null;
  readonly pid: number | null;
  /** `~/Library/LaunchAgents/<label>.plist` exists: an unloaded service the viewer would `launchctl bootstrap` (gateway_runtime_service.py:213-217). */
  readonly installed: boolean;
}
export interface GatewayFacts {
  /** The Hermes home the viewer would serve, resolved as `hermes` does without a profile flag. */
  readonly home: string;
  /** Whether the installed checkout holds the gateway viewer (`acp_adapter/gateway_server.py`); null when no checkout could be read. */
  readonly viewer: boolean | null;
  /** `install-stamp.json`'s commit: the code `hermes acp` itself runs (hermes_cli/source_stamp.py:15-47). */
  readonly stampCommit: string | null;
  /** `gateway.sock` (or the socket `gateway.sock.path` points to) exists and is a socket. */
  readonly socket: boolean;
  /** A `.hermes-update-in-progress` marker in the home or the checkout: `hermes update` owns the install (gateway_runtime.py:325-363). */
  readonly updating: boolean;
  readonly state: GatewayStateFacts | null;
  readonly pidRecord: GatewayRecord | null;
  readonly lockRecord: GatewayRecord | null;
  /** The live process behind the pid the state names (else the pid file, else the lock); null when none is recorded or it is gone. */
  readonly process: ProcessFact | null;
  readonly launchd: LaunchdFact;
}

export type GatewayVerdictCode = "A" | "B" | "C" | "D" | "E";
/**
 * The judgement: `attach` (A) opens a session; `in-process` means this checkout has no gateway viewer, so `hermes acp` runs
 * its sessions in its own process and the gateway is not involved (any such version opens sessions as before, ADR-053
 * decision 1); `refuse` (B–E) says what the viewer would do to the user's gateway and which of Hermes's own commands puts
 * it right. `explanation` is for the user; `evidence` is the bounded fact list the judgement rests on (no paths).
 */
export type GatewayPreflight =
  | { readonly kind: "attach"; readonly verdict: "A"; readonly explanation: string; readonly evidence: readonly string[] }
  | { readonly kind: "in-process"; readonly explanation: string; readonly evidence: readonly string[] }
  | { readonly kind: "refuse"; readonly verdict: Exclude<GatewayVerdictCode, "A">; readonly explanation: string; readonly commands: readonly string[]; readonly evidence: readonly string[] };

/** The two host questions the reader asks; replaced in tests. */
export interface GatewayHostQueries {
  /** `launchctl print <target>`: `loaded` with its stdout (exit 0), `absent` (exit 113, launchd's own code for no such service) or `unknown`. */
  launchd(target: string): Promise<{ readonly status: "loaded" | "absent" | "unknown"; readonly output: string }>;
  /** `ps -o lstart=,command= -p <pid>`: the row, or null when no such process. */
  process(pid: number): Promise<ProcessFact | null>;
}
/** How a Hermes driver asks for the preflight: the process environment it would start `hermes acp` with, and the executable. */
export type HermesGatewayPreflight = (env: Readonly<Record<string, string>>, executable: string) => Promise<GatewayPreflight>;

function shortSha(value: string | null): string { return value === null ? "未知" : value.slice(0, 10); }
function samePath(left: string, right: string): boolean { return resolve(left) === resolve(right); }
function liveGateway(record: GatewayRecord, process: ProcessFact | null, home: string): boolean {
  if (record.pid === null || process === null) return false;
  // Hermes's own identity chain (gateway_runtime.py:243-271, status.py:756-770, 883-896): alive, start time equal when both are
  // known (a recycled pid differs), the record not another profile's, and the live command line a gateway's.
  if (record.startTime !== null && process.startedAt !== null && Math.abs(record.startTime * 10 - process.startedAt) > START_TIME_TOLERANCE_MS) return false;
  if (record.hermesHome !== null && !samePath(record.hermesHome, home)) return false;
  if (process.command) return GATEWAY_COMMAND.test(process.command) && !/^\S*osascript(?:\s|$)/u.test(process.command);
  return record.kind === "gateway" && record.argv !== null && GATEWAY_COMMAND.test(record.argv.join(" "));
}

/** Judges the facts as `ensure_gateway_runtime` would, from files instead of the live `identify`: pure, so every verdict has samples. */
export function judgeGateway(facts: GatewayFacts): GatewayPreflight {
  const evidence: string[] = [];
  if (facts.viewer === false) {
    return { kind: "in-process", explanation: "这份 Hermes 安装的 acp_adapter 没有网关查看器（gateway_server.py）：hermes acp 在自己的进程里运行会话，不会触碰 Hermes 网关。", evidence: ["acp_adapter/gateway_server.py: 不存在"] };
  }
  const retry = "预检与建会话之间仍有竞态：命令执行、网关就绪后请重试。";
  const refuse = (verdict: Exclude<GatewayVerdictCode, "A">, explanation: string, commands: readonly string[]): GatewayPreflight =>
    ({ kind: "refuse", verdict, explanation: explanation + " HarnessHub 不会启动、停止或替换你的 Hermes 网关，这次没有运行 hermes acp。" + retry, commands, evidence });
  if (facts.updating) {
    evidence.push(".hermes-update-in-progress: 存在");
    return refuse("C", "Hermes 正在更新（.hermes-update-in-progress 标记存在）：hermes acp 会报告 Gateway draining: update_paused，等更新结束。", ["hermes gateway status"]);
  }
  const state = facts.state;
  if (state !== null) evidence.push("gateway_state.json: gateway_state=" + (state.gatewayState ?? "未知") + "，pid=" + (state.pid === null ? "未知" : String(state.pid)) + "，code_sha=" + shortSha(state.codeSha) + (state.platforms.length ? "，platforms=" + state.platforms.join("/") : ""));
  evidence.push("install-stamp.json: commit=" + shortSha(facts.stampCommit));
  evidence.push("gateway.sock: " + (facts.socket ? "存在" : "不存在"));
  evidence.push("launchd " + facts.launchd.label + ": " + (facts.launchd.status === "loaded" ? "已加载，state=" + (facts.launchd.state ?? "未知") : facts.launchd.status === "absent" ? "未加载" : "无法查询") + (facts.launchd.installed ? "，plist 已登记" : ""));
  const running = state !== null && state.gatewayState === "running" && liveGateway(state, facts.process, facts.home);
  evidence.push("进程: " + (facts.process === null ? "记录的 pid 不存在" : running ? "pid 存活且命令行是网关" : "存活但未按网关身份核实或状态不是 running"));
  if (running) {
    if (!facts.socket) return refuse("C", "Hermes 网关进程在运行，但它的控制套接字 gateway.sock 还不存在：hermes acp 会把它当作正在启动，最多等 " + HERMES_ENSURE_TIMEOUT_S + " 秒，等不到就自己启动一个。", ["hermes gateway status"]);
    if (state.codeSha === null || facts.stampCommit === null) {
      return refuse("B", "无法核对正在运行的网关与已安装 Hermes 的代码是否一致（网关的 code_sha " + shortSha(state.codeSha) + "，安装的 commit " + shortSha(facts.stampCommit) + "）：若网关的运行协议比 hermes acp 旧，它会先停掉网关再启动新的（替换）。", ["hermes gateway status", "hermes gateway restart"]);
    }
    if (state.codeSha !== facts.stampCommit) {
      return refuse("B", "正在运行的 Hermes 网关的代码（code_sha " + shortSha(state.codeSha) + "）与已安装的 Hermes（install-stamp.json 的 commit " + shortSha(facts.stampCommit) + "）不同：hermes acp 对运行协议更旧的网关会先停掉它再启动新网关（替换），对同协议的旧代码网关会附着到陈旧代码上。", ["hermes gateway status", "hermes gateway restart"]);
    }
    return { kind: "attach", verdict: "A", explanation: "兼容的 Hermes 网关已在运行（pid " + String(state.pid) + "，代码与已安装的 Hermes 一致），hermes acp 只会附着到它。", evidence };
  }
  // Not a running, verified owner: what is there instead decides what the viewer would do.
  const transitional = state !== null && state.gatewayState !== null && state.gatewayState !== "running" && !["stopped", "startup_failed"].includes(state.gatewayState) && facts.process !== null;
  if (transitional) return refuse("C", "Hermes 网关不在就绪状态（gateway_state=" + state.gatewayState + "，进程仍在）：hermes acp 会等它就绪，最多 " + HERMES_ENSURE_TIMEOUT_S + " 秒，超时报告 Gateway starting: deadline，网关自行退出后还会启动一个新的。", ["hermes gateway status"]);
  const reserved = (facts.state === null || facts.state.gatewayState !== "running") && [facts.pidRecord, facts.lockRecord].some(record => record !== null && liveGateway(record, facts.process, facts.home));
  if (reserved) return refuse("C", "Hermes 网关已占有 gateway.lock/gateway.pid 但还没有发布就绪状态：hermes acp 会把它当作正在启动，最多等 " + HERMES_ENSURE_TIMEOUT_S + " 秒。", ["hermes gateway status"]);
  if (facts.launchd.status === "loaded" && facts.launchd.state === "running") return refuse("C", "launchd 服务 " + facts.launchd.label + " 正在运行，但网关还没有发布就绪状态：hermes acp 会等它，最多 " + HERMES_ENSURE_TIMEOUT_S + " 秒。", ["hermes gateway status"]);
  if (facts.launchd.status === "loaded" || facts.launchd.installed) return refuse("D", "没有正在运行的 Hermes 网关，但 launchd 服务 " + facts.launchd.label + " 已登记：hermes acp 会用 launchctl " + (facts.launchd.status === "loaded" ? "kickstart" : "bootstrap") + " 拉起它。", ["hermes gateway status", "hermes gateway start"]);
  if (facts.launchd.status === "unknown") return refuse("D", "没有正在运行的 Hermes 网关，而 launchd 服务 " + facts.launchd.label + " 的状态无法查询：hermes acp 会向 launchd 询问并可能拉起服务。", ["hermes gateway status", "hermes gateway start"]);
  return refuse("E", "没有正在运行的 Hermes 网关，也没有登记的 launchd 服务：hermes acp 会自己启动一个无人监督、空闲即退出的网关守护进程。", ["hermes gateway status", "hermes gateway start"]);
}

/** The message of the NATIVE_GATEWAY_UNAVAILABLE refusal: the verdict, its explanation and Hermes's own commands. */
export function gatewayRefusalMessage(judged: Extract<GatewayPreflight, { kind: "refuse" }>): string {
  return "Hermes 的网关当前不可用（预检 " + judged.verdict + "）：" + judged.explanation + " 请在终端运行：" + judged.commands.join("，再 ") + "。";
}

/**
 * Hermes's home as `hermes` resolves it without a profile flag (hermes_constants.get_hermes_home and hermes_cli/main.py
 * `_apply_profile_override`): HERMES_HOME when set, else the sticky profile named in `~/.hermes/active_profile`, else
 * `~/.hermes`. The same rule as the capability reader's (src/infrastructure/capabilities/service.ts `resolveHermesHome`),
 * applied to the environment `hermes acp` would be started with.
 */
export async function resolveHermesHome(env: Readonly<Record<string, string | undefined>>, trace?: (path: string) => void): Promise<string> {
  const home = env.HOME ?? homedir();
  const explicit = env.HERMES_HOME?.trim();
  if (explicit) return resolve(explicit.replace(/^~(?=$|\/)/u, home));
  const root = join(home, ".hermes");
  let name: string;
  try { trace?.(join(root, "active_profile")); name = (await readFile(join(root, "active_profile"), "utf8")).trim(); } catch { return root; }
  if (!name || name === "default" || !PROFILE_NAME.test(name)) return root;
  const profile = join(root, "profiles", name);
  trace?.(profile);
  return (await stat(profile).catch(() => null))?.isDirectory() ? profile : root;
}
/**
 * The checkout `hermes acp` runs from: the one the executable sits in (`<checkout>/.hermes/bin/hermes`), else the official
 * installer's `~/.hermes/hermes-agent` (src/adapters/catalog-channels.ts).
 */
export function hermesCheckout(env: Readonly<Record<string, string | undefined>>, executable: string): string {
  const program = /^(.*)\/\.hermes\/bin\/hermes(?:-acp|-agent)?$/u.exec(executable);
  return program?.[1] ? program[1] : join(env.HOME ?? homedir(), ".hermes", "hermes-agent");
}
/** The launchd label of the home's gateway service (gateway_runtime_service.py:37-58, 189): bare for the account default home, `-<profile>` for `<default>/profiles/<name>`, a path hash otherwise. */
export function launchdLabel(home: string, accountHome: string, suffixVariable = ""): string {
  const base = join(accountHome, ".hermes" + suffixVariable), resolved = resolve(home);
  if (resolved === resolve(base)) return HERMES_LAUNCHD_LABEL;
  if (dirname(dirname(resolved)) === resolve(base) && dirname(resolved).endsWith("/profiles") && PROFILE_NAME.test(resolved.slice(dirname(resolved).length + 1)))
    return HERMES_LAUNCHD_LABEL + "-" + resolved.slice(dirname(resolved).length + 1);
  return HERMES_LAUNCHD_LABEL + "-" + createHash("sha256").update(resolved).digest("hex").slice(0, 8);
}

function integer(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }
function record(value: unknown): GatewayRecord | null {
  if (typeof value === "number") return integer(value) === null ? null : { pid: value, startTime: null, hermesHome: null, kind: null, argv: null };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return { pid: integer(row.pid), startTime: typeof row.start_time === "number" && Number.isFinite(row.start_time) ? row.start_time : null,
    hermesHome: typeof row.hermes_home === "string" && row.hermes_home.trim() ? row.hermes_home : null, kind: typeof row.kind === "string" ? row.kind : null,
    argv: Array.isArray(row.argv) && row.argv.every(part => typeof part === "string") ? row.argv as string[] : null };
}
/** A JSON record Hermes wrote (`_read_json_file`, status.py:835-856): an object, or for pid files a bare integer; anything else is no record. */
async function readRecord(path: string, trace: ((path: string) => void) | undefined, barePid: boolean): Promise<unknown> {
  trace?.(path);
  let raw: string;
  try { const info = await lstat(path); if (!info.isFile() || info.size > RECORD_BYTES) return null; raw = (await readFile(path, "utf8")).replace(/^\uFEFF/u, "").trim(); } catch { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return barePid && /^\d{1,10}$/u.test(raw) ? Number(raw) : null; }
}
async function exists(path: string, trace: ((path: string) => void) | undefined, kind: "file" | "socket" | "any" = "any"): Promise<boolean> {
  trace?.(path);
  try { const info = await lstat(path); return kind === "file" ? info.isFile() : kind === "socket" ? info.isSocket() : true; } catch { return false; }
}
/** `gateway.sock` or the socket `gateway.sock.path` names (hermes_cli/gateway_runtime_discovery.py:143-171, for an owner with another TMPDIR). */
async function socketPresent(home: string, trace: ((path: string) => void) | undefined): Promise<boolean> {
  if (await exists(join(home, "gateway.sock"), trace, "socket")) return true;
  const pointer = join(home, "gateway.sock.path"); trace?.(pointer);
  try {
    const info = await lstat(pointer); if (!info.isFile() || info.size > POINTER_BYTES) return false;
    const target = (await readFile(pointer, "utf8")).trim();
    return isAbsolute(target) && target.endsWith("/control.sock") && await exists(target, trace, "socket");
  } catch { return false; }
}

/**
 * Reads the facts of the home `env` names and the checkout `executable` runs from, touching only the files of `GATEWAY_FILES`
 * and `CHECKOUT_FILES` (plus the launchd plist's existence); `trace` sees every path looked at. Unreadable or invalid files
 * are absent facts, never an error: the judgement then refuses with what is known.
 */
export async function readGatewayFacts(env: Readonly<Record<string, string | undefined>>, executable: string, host: GatewayHostQueries, trace?: (path: string) => void): Promise<GatewayFacts> {
  // Hermes records and compares canonical homes (`_canonical_hermes_home`, `service_suffix`): a symlinked home must match its record.
  const canonical = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
  const home = await canonical(await resolveHermesHome(env, trace)), checkout = hermesCheckout(env, executable), accountHome = await canonical(env.HOME ?? homedir());
  const canonicalRecord = async <T extends GatewayRecord | null>(value: T): Promise<T> => value === null || value.hermesHome === null ? value : { ...value, hermesHome: await canonical(value.hermesHome) };
  const stamp = await readRecord(join(checkout, "install-stamp.json"), trace, false);
  const commit = stamp !== null && typeof stamp === "object" && "commit" in stamp && typeof stamp.commit === "string" && COMMIT.test(stamp.commit) ? stamp.commit : null;
  const checkoutPresent = await exists(checkout, trace), viewer = checkoutPresent ? await exists(join(checkout, "acp_adapter", "gateway_server.py"), trace, "file") : null;
  const updating = await exists(join(home, ".hermes-update-in-progress"), trace) || await exists(join(checkout, ".hermes-update-in-progress"), trace);
  const stateRaw = await readRecord(join(home, "gateway_state.json"), trace, false), base = record(stateRaw);
  const row = stateRaw !== null && typeof stateRaw === "object" ? stateRaw as Record<string, unknown> : null;
  const state: GatewayStateFacts | null = base === null || row === null ? null : { ...await canonicalRecord(base),
    gatewayState: typeof row.gateway_state === "string" ? row.gateway_state.slice(0, 64) : null,
    codeSha: typeof row.code_sha === "string" && COMMIT.test(row.code_sha) ? row.code_sha : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at.slice(0, 64) : null,
    platforms: row.platforms !== null && typeof row.platforms === "object" && !Array.isArray(row.platforms) ? Object.keys(row.platforms).slice(0, 16).map(name => name.slice(0, 32)) : Array.isArray(row.platforms) ? row.platforms.filter((name): name is string => typeof name === "string").slice(0, 16).map(name => name.slice(0, 32)) : [] };
  const pidRecord = await canonicalRecord(record(await readRecord(join(home, "gateway.pid"), trace, true))), lockRecord = await canonicalRecord(record(await readRecord(join(home, "gateway.lock"), trace, true)));
  const pid = state?.pid ?? pidRecord?.pid ?? lockRecord?.pid ?? null;
  const label = launchdLabel(home, accountHome, env.HERMES_DATA_DIR_SUFFIX ?? "");
  const [socket, process, launchd, installed] = await Promise.all([socketPresent(home, trace), pid === null ? Promise.resolve(null) : host.process(pid),
    host.launchd("gui/" + String(typeof globalThis.process.getuid === "function" ? globalThis.process.getuid() : 0) + "/" + label), exists(join(accountHome, "Library", "LaunchAgents", label + ".plist"), trace, "file")]);
  const printed = launchd.status === "loaded" ? parseLaunchctlPrint(launchd.output) : { state: null, pid: null };
  return { home, viewer, stampCommit: commit, socket, updating, state, pidRecord, lockRecord, process, launchd: { label, status: launchd.status, state: printed.state, pid: printed.pid, installed } };
}

/** The top-level `state` and `pid` of `launchctl print`; nested blocks are ignored (as src/infrastructure/management/program-usage.ts reads them). */
export function parseLaunchctlPrint(text: string): { readonly state: string | null; readonly pid: number | null } {
  const field = (name: string): string | null => new RegExp("^\\t" + name + " = ([^\\n]*)$", "mu").exec(text)?.[1]?.trim() ?? null;
  const pid = field("pid");
  return { state: field("state"), pid: pid !== null && /^\d+$/u.test(pid) ? Number(pid) : null };
}
/** One row of `ps -o lstart=,command= -p <pid>`: the start time (local, to the second) and the command line; null for no row. */
export function parsePsRow(text: string): ProcessFact | null {
  const row = /^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/u.exec(text.split(/\r?\n/u).find(line => line.trim()) ?? "");
  if (!row) return null;
  const started = Date.parse(row[1]!);
  return { startedAt: Number.isFinite(started) ? started : null, command: row[2]!.trim().slice(0, 4096) };
}
const HOST_ENV = { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
function run(executable: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly stdout: string }> {
  return new Promise(done => {
    execFile(executable, args, { env: HOST_ENV, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
      done({ code, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}
/** The real host: `/bin/launchctl print` and `/bin/ps`, read-only, five seconds each. */
export const hostQueries: GatewayHostQueries = {
  launchd: async target => { const result = await run("/bin/launchctl", ["print", target]); return { status: result.code === 0 ? "loaded" : result.code === 113 ? "absent" : "unknown", output: result.code === 0 ? result.stdout : "" }; },
  process: async pid => { const result = await run("/bin/ps", ["-o", "lstart=,command=", "-p", String(pid)]); return result.code === 0 ? parsePsRow(result.stdout) : null; },
};
/** The preflight a Hermes driver runs before starting `hermes acp`: the facts of this environment, judged. */
export async function hermesGatewayPreflight(env: Readonly<Record<string, string>>, executable: string, host: GatewayHostQueries = hostQueries): Promise<GatewayPreflight> {
  return judgeGateway(await readGatewayFacts(env, executable, host));
}
