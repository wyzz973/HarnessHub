import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dataRoot, dataRootPlacement, dataRootWarning } from "./session-application.js";
import { MAX_PARALLEL_CONVERSATIONS, SessionError, resolveTurnBudgets } from "../contracts/session.js";
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
      "path-only": { type: "boolean" }, "assets-dir": { type: "string" }, "execution-budget": { type: "string" }, "wait-budget": { type: "string" }, "no-login-shell": { type: "boolean" }, "workspace-lock-root": { type: "string" }, "allow-unofficial": { type: "boolean" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false });
    if (values.help) { process.stdout.write("HarnessGateway web --cwd <workspace> --data-dir <path> [--port <0..65535>] [--execution-budget <30..3600 秒>] [--wait-budget <1..120 分钟>] [--no-login-shell] [--workspace-lock-root <绝对目录>] [--allow-unofficial]\n本机页面使用一次性启动链接。Ctrl+C等待在途执行清理并保留公共历史。\n--workspace-lock-root 另用一个工作区租约目录：这个 Gateway 不再与本机其他 Gateway 互斥同一工作区，只用于隔离的测试或刻意独立的实例。\n--allow-unofficial 把官网渠道以外的入口（开发目录、npm link、测试用程序）也算作已安装，只用于开发和测试；默认只认官网安装方式。\n"); return 0; }
    // Each Turn's budgets (ADR-036): execution 300 s and waiting 30 minutes unless set here.
    const budgets = resolveTurnBudgets({ executionSeconds: values["execution-budget"], waitMinutes: values["wait-budget"] });
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
    // A data directory the workspace's Harnesses can read is said once at start (ADR-055 §10.1); the default stays as it is (D8).
    const exposed = dataRootWarning(dataRootPlacement(root, configuration.workspace));
    if (exposed !== null) process.stderr.write("HarnessGateway: " + exposed + "\n");
    // What this service runs with (ADR-036), so its log says it without reading the code.
    process.stdout.write(`HarnessGateway: up to ${MAX_PARALLEL_CONVERSATIONS} conversations run at once; each Turn may work ${budgets.executionBudgetMs / 1000} s and wait ${budgets.waitBudgetMs / 60_000} min for the user\n`);
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
