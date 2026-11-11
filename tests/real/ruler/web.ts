import { application } from "../../../src/cli/session-application.js";
import type { InstallationPolicy } from "../../../src/contexts/catalog/domain/catalog.js";
import { prepareConfiguration } from "../../../src/infrastructure/session/binding-factory.js";
import type { NativeEnvironment } from "../../../src/infrastructure/session/native-environment.js";
import { startWebServer } from "../../../src/web/server.js";
import type { WatchedMount } from "./mount.js";
import type { CellHub } from "./run.js";

/*
 * A Hub for one cell with the context table mounted (HH_REAL_TABLE=1; docs/verification/relay-ruler.md): the Hub's own web server on a
 * random loopback port, which gives the table its address and answers the tool program's reads, over an application the ruler
 * composes itself, so that it drives that application's Runtime directly — the Turns are the ones the server's application runs,
 * and the native processes it starts get the table's environment. The server is the one the user's Hub runs; nobody logs in to it.
 * Installing the Hub's tools into a Harness's configuration is not done here: that is the manager's, before the run. What the
 * server's probe finds in the configuration of the user's own Harnesses is only read.
 */
export async function openWebHub(where: { readonly workspace: string; readonly data: string },
  options: { readonly mount: WatchedMount; readonly installations: InstallationPolicy; readonly locks: string; readonly budgets: { readonly executionBudgetMs: number; readonly waitBudgetMs: number }; readonly manifest?: string;
    /** The environment the Hub discovers and starts Harnesses in; this computer's own when absent (a test of the ruler gives it a private home and a PATH without the user's Harnesses). */
    readonly environment?: NativeEnvironment }): Promise<CellHub> {
  let composed: ReturnType<typeof application> | undefined;
  const configuration = await prepareConfiguration({ workspace: where.workspace, ...(options.manifest === undefined ? {} : { manifestPath: options.manifest }) });
  const server = await startWebServer({ root: where.data, configuration, port: 0, table: options.mount, installations: options.installations, workspaceLockRoot: options.locks, budgets: options.budgets,
    application: (root, publish) => composed = application(root, publish, { installations: options.installations, workspaceLockRoot: options.locks, budgets: options.budgets, table: options.mount,
      ...(options.environment === undefined ? {} : { nativeEnvironment: options.environment }) }) });
  const app = composed;
  if (app === undefined) { await server.close(); throw new Error("the server composed no application"); }
  return { runtime: app.runtime, store: app.store, content: app.content, configuration, table: options.mount, close: () => server.close() };
}
