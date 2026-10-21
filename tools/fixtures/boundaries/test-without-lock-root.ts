// Invalid sample for B8 and B9: tests that compose the application, start a Gateway or run an official command must name their
// own workspace lease directory (ADR-041), and a discovery manifest needs --allow-unofficial (ADR-044). The format is described
// in README.md. This file is never compiled, and the repository check does not scan tools/.

// @@ file: tests/integration/leak.test.ts
import { spawn, spawnSync, execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { application } from "../../src/cli/session-application.js";
import { startWebServer } from "../../src/web/server.js";

const chat = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));
const web = fileURLToPath(new URL("../../src/cli/web.js", import.meta.url));
const sessions = fileURLToPath(new URL("../../src/cli/sessions.js", import.meta.url));
const discover = fileURLToPath(new URL("../../src/cli/discover.js", import.meta.url));
const locks = join(root, "locks");

// B8: the composition would use the per-user directory shared with the running service.
application(data, () => {}); // expect: B8
application(data, () => {}, { installations: "any" }); // expect: B8
application(data, () => {}, { installations: "any", workspaceLockRoot: undefined }); // expect: B8
await startWebServer({ root: data, configuration, port: 0 }); // expect: B8
await startWebServer({ root: data, configuration, port: 0, ...(extra ? { workspaceLockRoot: locks } : {}) }); // expect: B8
application(data, () => {}, { installations: "any", workspaceLockRoot: locks });
await startWebServer({ root: data, configuration, port: 0, workspaceLockRoot: locks });
await startWebServer({ root: data, configuration, port: 0, application: (root, publish) => application(root, publish, { workspaceLockRoot: locks }) });
await startWebServer({ root: data, configuration, port: 0, application: (root, publish) => application(root, publish, { installations: "any" }) }); // expect: B8

// B9: the command would lease its workspaces from the per-user directory, or its manifest would be ignored.
spawnSync(process.execPath, [chat, "--data-dir", data, "--harness", "fixture"]); // expect: B9
spawn(process.execPath, [sessions, "list", "--data-dir", data, "--json"]); // expect: B9
spawn(process.execPath, [web, "--port", "0", "--workspace-lock-root", locks, "--manifest", manifest]); // expect: B9
spawnSync(process.execPath, [chat, "--data-dir", data, "--workspace-lock-root", locks, "--allow-unofficial", "--manifest", manifest]);
spawnSync(process.execPath, [web, "--help"]);
spawnSync(process.execPath, [discover, "--json", "--path-only"]);
execSync(`node ${chat} --data-dir ${data} --prompt hi`); // expect: B9
execSync(`node ${chat} --data-dir ${data} --workspace-lock-root ${locks} --prompt hi`);

// A helper that adds the flag for its callers is followed; one that does not is reported at the process it starts.
function flags(extra: readonly string[]): string[] { return ["--data-dir", data, "--workspace-lock-root", locks, ...extra]; }
function bare(extra: readonly string[]): string[] { return ["--data-dir", data, ...extra]; }
spawnSync(process.execPath, [chat, "--allow-unofficial", ...flags(["--manifest", manifest])]);
spawnSync(process.execPath, [chat, ...bare(["--harness", "fixture"])]); // expect: B9
const run = (args: readonly string[]) => spawnSync(process.execPath, [web, ...args]); // expect: B9
run(["--port", "0"]);
run(["--port", "0", "--workspace-lock-root", locks]);

// @@ file: tests/integration/forms.test.ts
import { spawn as launch, spawnSync, execFile } from "node:child_process";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import * as sessionApplication from "../../src/cli/session-application.js";
import { application as compose } from "../../src/cli/session-application.js";
import { startWebServer as boot } from "../../src/web/server.js";
import { importedFlags } from "../fixtures/flags.js";

const chat = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));
const web = fileURLToPath(new URL("../../src/cli/web.js", import.meta.url));
const locks = join(root, "locks");
const base = { installations: "any" as const, workspaceLockRoot: locks };
const common = ["--data-dir", data, "--workspace-lock-root", locks];
const withFlags = (extra: readonly string[]) => [...common, ...extra];
const execFileAsync = promisify(execFile);
function application(root: string) { return root; }

// B8 follows aliases and namespaces, and wants the option to be visible in this file.
compose(data, () => {}, { installations: "any" }); // expect: B8
compose(data, () => {}, base);
compose(data, () => {}, { ...base, nativeEnvironment });
compose(data, () => {}, { installations: "any", ...overrides }); // expect: B8
sessionApplication.application(data, () => {}); // expect: B8
boot({ root: data, configuration, port: 0 }); // expect: B8
boot({ root: data, configuration, port: 0, workspaceLockRoot: locks });
function open(options: StartOptions) { return boot(options); } // expect: B8
application(data); // a function of the same name that is declared here is not the Gateway's

// B9 follows aliases, namespaces and promisify, takes --flag=value, and cannot see a flag that only one branch passes.
launch(process.execPath, [chat, "--data-dir", data]); // expect: B9
childProcess.spawnSync(process.execPath, [web, "--port", "0"]); // expect: B9
await execFileAsync(process.execPath, [chat, "--data-dir", data]); // expect: B9
spawnSync(process.execPath, [chat, ...["--workspace-lock-root", locks].filter(flag => flag !== "--workspace-lock-root")]); // expect: B9
spawnSync(process.execPath, [chat, ...(official ? ["--workspace-lock-root", locks] : [])]); // expect: B9
spawnSync(process.execPath, [chat, ...imported.flags]); // expect: B9
spawnSync(process.execPath, [chat, ...importedFlags]); // expect: B9
spawnSync(process.execPath, [web, ...(quick ? ["--help"] : [])]); // expect: B9
spawnSync(process.execPath, [chat, ...withFlags(["--harness", "fixture"])]);
launch(process.execPath, [chat, "--data-dir", data, "--workspace-lock-root", locks]);
childProcess.spawnSync(process.execPath, [web, "--workspace-lock-root=" + locks, "--port", "0"]);
spawnSync(process.execPath, [chat, `--workspace-lock-root=${locks}`]);
await execFileAsync(process.execPath, [web, "-h"]);
