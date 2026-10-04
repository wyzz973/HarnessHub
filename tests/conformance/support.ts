// SPDX-License-Identifier: MIT
/**
 * The sandbox of the real-agent conformance suite (10-engineering section
 * 3.3, the Adapter suite's online part): a temporary HOME with its XDG and
 * temporary directories, an environment built from nothing (no variable of
 * the developer's reaches an agent but PATH entries and the locale), proxy
 * variables pointing at a refused loopback port, and, on macOS, a Seatbelt
 * profile (`sandbox-exec`) that denies every outbound connection except the
 * gateway's port, every file write outside the sandbox, and the keychain.
 * Agents therefore cannot reach the internet, cannot read the account's
 * stored credentials and cannot write to the real home, whatever they do.
 * Other platforms have no such sandbox here yet, and the suite skips.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { temporaryDirectory } from "../support/temporary.js";

/** Why real agents cannot run here, or undefined when they can. */
export async function sandboxUnavailable(): Promise<string | undefined> {
  if (process.platform !== "darwin")
    return `no network sandbox for real agents on ${process.platform} yet (the suite uses macOS sandbox-exec)`;
  try {
    await access("/usr/bin/sandbox-exec", constants.X_OK);
    return undefined;
  } catch {
    return "/usr/bin/sandbox-exec is missing";
  }
}

/** PATH entries of wrappers that would run something else than the agent itself. */
function wrapperDirectory(directory: string): boolean {
  return (
    directory.includes("cmux-cli-shims") || directory.includes("/cmux.app/")
  );
}

/**
 * The agent's own executable: the first `name` in PATH outside wrapper
 * directories (cmux's shims re-launch through the developer's session), or
 * in `extra` directories where its installer puts it (`searchPath`, the
 * test process's PATH by default). Resolves to the
 * directory to put on the sandbox's PATH and the file, or undefined.
 */
export async function findAgent(
  name: string,
  extra: readonly string[] = [],
  searchPath = process.env.PATH ?? "",
): Promise<{ directory: string; file: string } | undefined> {
  const directories = [
    ...searchPath.split(path.delimiter).filter(Boolean),
    ...extra,
  ];
  for (const directory of directories) {
    if (wrapperDirectory(directory)) continue;
    const file = path.join(directory, name);
    try {
      const info = await stat(file);
      await access(file, constants.X_OK);
      if (info.isFile()) return { directory, file };
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

export interface Sandbox {
  /** The real path of the sandbox directory; nothing is written outside it. */
  root: string;
  home: string;
  /** The working directory agents run in. */
  work: string;
  /** The environment agents and the daemon's wiring see (`proxies`: with the refused proxy). */
  env(proxies: boolean): Record<string, string>;
}

/** A refused port: the discard service, which nothing listens on. */
const REFUSED_PROXY = "http://127.0.0.1:9";

/**
 * A sandbox for one agent: HOME, XDG and temporary directories inside a
 * temporary directory, and PATH made of the agent's directory, this Node's
 * directory and the system directories.
 */
export async function agentSandbox(
  t: TestContext,
  agentDirectory: string,
): Promise<Sandbox & { defer: (cleanup: () => unknown) => void }> {
  const { directory, defer } = await temporaryDirectory(t, "hh-conformance-");
  const root = await realpath(directory);
  return {
    ...(await sandboxIn(root, agentDirectory, {
      home: path.join(root, "home"),
      work: path.join(root, "work"),
    })),
    defer,
  };
}

/**
 * The sandbox of `agentSandbox` in a directory the caller owns and removes:
 * `root` is its real path, `home` and `work` are inside it (created when
 * missing), and its temporary directory is `root/tmp`.
 */
export async function sandboxIn(
  root: string,
  agentDirectory: string,
  { home, work }: { home: string; work: string },
): Promise<Sandbox> {
  const tmp = path.join(root, "tmp");
  for (const made of [home, work, tmp]) await mkdir(made, { recursive: true });
  const user = os.userInfo().username;
  const base: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    TMPDIR: tmp,
    PATH: [
      agentDirectory,
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(path.delimiter),
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  };
  const proxies = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].flatMap((name) => [
      [name, REFUSED_PROXY],
      [name.toLowerCase(), REFUSED_PROXY],
    ]),
  );
  return {
    root,
    home,
    work,
    env: (withProxies) => ({
      ...base,
      ...(withProxies
        ? {
            ...proxies,
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          }
        : {}),
    }),
  };
}

/**
 * The Seatbelt profile agents run under: outbound connections only to the
 * gateway's port on loopback (and Unix sockets, which name resolution
 * uses), writes only inside `root` and to the terminal devices, and no
 * keychain (the security server is unreachable).
 */
export function seatbelt(root: string, gatewayPort?: number): string {
  const quoted = JSON.stringify(root);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    "(allow network-outbound (remote unix-socket))",
    ...(gatewayPort === undefined
      ? []
      : [`(allow network-outbound (remote ip "localhost:${gatewayPort}"))`]),
    "(deny file-write*)",
    `(allow file-write* (subpath ${quoted}) (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))`,
    '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    "",
  ].join("\n");
}

export interface AgentRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** A run in progress: its output so far, a kill switch and its end. */
export interface SandboxedRun {
  stdout(): string;
  /** Kills the whole process group now. */
  kill(): void;
  done: Promise<AgentRun>;
}

/**
 * Starts `file` with `args` in the Seatbelt sandbox, its own process group,
 * no stdin and a hard timeout; the whole group is killed when it ends, so
 * no helper the agent started outlives the run.
 */
export async function startSandboxed(
  sandbox: Sandbox,
  file: string,
  args: readonly string[],
  options: {
    env: Record<string, string>;
    gatewayPort?: number;
    timeoutMs: number;
  },
): Promise<SandboxedRun> {
  const profile = path.join(sandbox.root, "seatbelt.sb");
  await writeFile(profile, seatbelt(sandbox.root, options.gatewayPort));
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, file, ...args], {
    cwd: sandbox.work,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const killGroup = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, options.timeoutMs);
  const done = new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exit, by) => resolve([exit, by]));
    },
  ).then(([code, signal]): AgentRun => {
    clearTimeout(timer);
    killGroup();
    return { code, signal, timedOut, stdout, stderr };
  });
  return { stdout: () => stdout, kill: killGroup, done };
}

/** Runs `file` with `args` to its end in the sandbox (see `startSandboxed`). */
export async function runSandboxed(
  sandbox: Sandbox,
  file: string,
  args: readonly string[],
  options: {
    env: Record<string, string>;
    gatewayPort?: number;
    timeoutMs: number;
  },
): Promise<AgentRun> {
  return (await startSandboxed(sandbox, file, args, options)).done;
}

/** The first line an agent prints for `--version`, run in the sandbox. */
export async function agentVersion(
  sandbox: Sandbox,
  file: string,
  env: Record<string, string>,
): Promise<string> {
  const run = await runSandboxed(sandbox, file, ["--version"], {
    env,
    timeoutMs: 30_000,
  });
  return (
    (run.stdout + run.stderr)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 80) ?? "unknown"
  );
}

/** A file's bytes, or undefined when it does not exist. */
export async function bytesOf(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

/** The outcome of one item of an agent's run. */
export interface ConformanceItem {
  /** `partial`: what the item checks ran, but a known limitation of the run stopped it short. */
  result: "pass" | "partial" | "fail" | "not run";
  detail?: string;
}

/** One agent's row of the compatibility table. */
export interface ConformanceResult {
  agent: string;
  name: string;
  version: string;
  /** The chat item: whether the wiring works at all. */
  status:
    "wiring verified" | "partially verified" | "blocked" | "not installed";
  reason?: string;
  items?: {
    tools: ConformanceItem;
    stream: ConformanceItem;
    cancel: ConformanceItem;
    usage: ConformanceItem;
  };
  notes: string[];
  date: string;
  platform: string;
}

/**
 * Appends a row to the results file the run names
 * (`HARNESSHUB_TEST_CONFORMANCE_RESULTS`, a JSON line per agent), which
 * `tools/conformance.mjs` turns into docs/compatibility.md.
 */
export async function record(result: ConformanceResult): Promise<void> {
  const file = process.env.HARNESSHUB_TEST_CONFORMANCE_RESULTS;
  if (!file) return;
  await appendFile(file, `${JSON.stringify(result)}\n`);
}

/** The text of `text` with the sandbox's paths written as `<sandbox>`. */
export function scrub(text: string, sandbox: Sandbox): string {
  return text.split(sandbox.root).join("<sandbox>");
}
