import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The Gateway inside the desktop app runs on the app's own runtime (Electron as Node). Whatever the Gateway hands to another program as "its Node"
 * (the Hub's tools given to a Harness, an installer's runner) must start as Node there too, so `process.execPath` becomes a script that says so; the
 * Gateway's own environment loses the mark, or every program it starts would inherit it and an Electron app among them would start as Node.
 */
const runtime = process.env.HARNESSHUB_RUNTIME_DIR;
if (process.env.ELECTRON_RUN_AS_NODE !== undefined && runtime) {
  const node = join(runtime, "node");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(node, "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec " + "'" + process.execPath.replaceAll("'", "'\\''") + "'" + " \"$@\"\n", { mode: 0o755 });
  chmodSync(node, 0o755);
  process.execPath = node;
}
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.HARNESSHUB_RUNTIME_DIR;

const { main } = await import("../src/cli/web.js");
process.exitCode = await main(process.argv.slice(2));
