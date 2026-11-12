import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dataRoot } from "./session-application.js";
import { SessionError, resolveTurnBudgets } from "../contracts/session.js";
import { prepareConfiguration } from "../infrastructure/session/binding-factory.js";
import { resolveInstallationPolicy } from "../contexts/catalog/domain/catalog.js";
import { MANIFEST_IGNORED } from "../infrastructure/catalog/inventory-composition.js";
import { startWebServer, type WebServer } from "../web/server.js";
import { defaultRelayKeyPath } from "../infrastructure/session/relay-keys.js";

/**
 * Whether this Gateway offers reading the login shell's PATH on the user's request (ADR-040), decided once at the entry:
 * never with `--no-login-shell`, when CI is set (even empty) or on Windows; otherwise with the user's `$SHELL`, which may be
 * unset, in which case the page shows nothing to read.
 */
export function loginShellSetting(input: { readonly off: boolean; readonly env: Readonly<Record<string, string | undefined>>; readonly platform: string }): false | { readonly shell: string | null; readonly shells: string } {
  return input.off || input.env.CI !== undefined || input.platform === "win32" ? false : { shell: input.env.SHELL ?? null, shells: "/etc/shells" };
}
/** Owns one local web application until SIGINT/SIGTERM; startup URL carries a one-use fragment token. */
export async function main(args: readonly string[]): Promise<number> {
  let gateway: WebServer | undefined;
  try {
    const { values } = parseArgs({ args: [...args], options: { "data-dir": { type: "string" }, cwd: { type: "string" }, port: { type: "string" },
      manifest: { type: "string" }, "config-home": { type: "string" }, "package-root": { type: "string", multiple: true }, "search-dir": { type: "string", multiple: true },
      "path-only": { type: "boolean" }, "assets-dir": { type: "string" }, "execution-budget": { type: "string" }, "wait-budget": { type: "string" }, "max-parallel": { type: "string" }, "no-login-shell": { type: "boolean" }, "workspace-lock-root": { type: "string" }, "allow-unofficial": { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false });
    if (values.help) { process.stdout.write("HarnessGateway web --cwd <workspace> --data-dir <path> [--port <0..65535>] [--execution-budget <≥30 秒>] [--wait-budget <≥1 分钟>] [--max-parallel <≥1>] [--no-login-shell] [--workspace-lock-root <绝对目录>] [--allow-unofficial]\n本机页面使用一次性启动链接。Ctrl+C等待在途执行清理并保留公共历史。\n回合默认没有时间上限，对话也不限同时运行的个数；下面三项是可选的自动限制，不给就不限：--execution-budget 回合干活满这么久（不含等你决定的时间）就自动停止；--wait-budget 审批或提问等了这么久没人答就算过期；--max-parallel 同时运行的对话个数上限，超出的排队。\n--workspace-lock-root 另用一个工作区租约目录：这个 Gateway 不再与本机其他 Gateway 互斥同一工作区，只用于隔离的测试或刻意独立的实例。\n--allow-unofficial 把官网渠道以外的入口（开发目录、npm link、测试用程序）也算作已安装，只用于开发和测试；默认只认官网安装方式。\n"); return 0; }
    // A Turn has no time limit and conversations run at once without a fixed number; only what is set here limits them (2026-11-12, ADR-036 superseded).
    const budgets = resolveTurnBudgets({ executionSeconds: values["execution-budget"], waitMinutes: values["wait-budget"], maxParallel: values["max-parallel"] });
    if (values.port !== undefined && !/^(0|[1-9][0-9]{0,4})$/u.test(values.port)) throw new SessionError("INVALID_INPUT", "port must be 0..65535");
    for (const value of [values.cwd, values.manifest, values["config-home"], values["assets-dir"], ...(values["package-root"] ?? []), ...(values["search-dir"] ?? [])])
      if (value !== undefined && (!value.trim() || value.length > 4096 || /[\0\r\n]/u.test(value))) throw new SessionError("INVALID_INPUT", "explicit paths must be bounded and nonempty");
    const configuration = await prepareConfiguration({ workspace: resolve(values.cwd ?? process.cwd()), ...(values.manifest === undefined ? {} : { manifestPath: resolve(values.manifest) }),
      ...(values["config-home"] === undefined ? {} : { configHome: resolve(values["config-home"]) }), packageRoots: (values["package-root"] ?? []).map(path => resolve(path)),
      searchDirs: (values["search-dir"] ?? []).map(path => resolve(path)), pathOnly: values["path-only"] ?? false });
    const installations = resolveInstallationPolicy(values["allow-unofficial"]);
    if (values.manifest !== undefined && installations === "official") process.stderr.write("HarnessGateway: " + MANIFEST_IGNORED + "\n");
    const loginShell = loginShellSetting({ off: values["no-login-shell"] ?? false, env: process.env, platform: process.platform });
    const root = dataRoot(values["data-dir"]);
    gateway = await startWebServer({ providerManagement: false, root, configuration, port: values.port === undefined ? 4317 : Number(values.port), budgets, loginShell,
      installations,
      // The relay's installation key, outside the data directory (ADR-055 D5; an unusable one is said on stderr, never fatal).
      relayKeyFile: defaultRelayKeyPath(process.env.HOME || undefined),
      ...(values["workspace-lock-root"] === undefined ? {} : { workspaceLockRoot: values["workspace-lock-root"] }),
      ...(values["assets-dir"] === undefined ? {} : { assetsDirectory: resolve(values["assets-dir"]) }) });
    process.stdout.write("HarnessGateway\n" + gateway.url + "\n");
    // What this service runs with, so its log says it without reading the code.
    process.stdout.write("HarnessGateway: " + (budgets.maxParallel === undefined ? "conversations run at once without a fixed number" : `up to ${budgets.maxParallel} conversations run at once, the rest wait`)
      + "; " + (budgets.executionBudgetMs === undefined ? "a Turn has no time limit" : `a Turn is stopped after ${budgets.executionBudgetMs / 1000} s of work`)
      + "; " + (budgets.waitBudgetMs === undefined ? "an approval or question waits for you" : `an approval or question expires after ${budgets.waitBudgetMs / 60_000} min`) + "\n");
    await new Promise<void>(done => {
      const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); done(); };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
    });
    await gateway.close(); return 0;
  } catch (error) {
    if (gateway) try { await gateway.close(); } catch { process.stderr.write("HarnessGateway: shutdown cleanup failed\n"); }
    process.stderr.write("HarnessGateway: " + (error instanceof SessionError ? error.code : "WEB_FAILED") + " — local web application could not run\n"); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
