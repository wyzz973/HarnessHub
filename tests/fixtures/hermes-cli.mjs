// A Hermes launcher for protocol tests. `acp` runs the ACP fixture as Hermes; `sessions export - --session-id <id>` answers
// as hermes_cli/main.py does: one JSON line for a known session, a sentence (and exit code 0) for an unknown one.
// FIXTURE_EXPORT picks "missing", "huge" (over 8 MiB) or "slow" (over 5 s); FIXTURE_CLI_TRACE records every command line.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FIXTURE_CLI_TRACE) appendFileSync(process.env.FIXTURE_CLI_TRACE, JSON.stringify(args) + "\n");
if (args[0] === "acp") {
  process.argv.splice(2, Infinity, "acp-v1", "hermes");
  await import("./control-peer.mjs");
} else if (args[0] === "sessions" && args[1] === "export" && args[2] === "-") {
  const id = args[args.indexOf("--session-id") + 1], mode = process.env.FIXTURE_EXPORT ?? "found";
  if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 7000));
  if (mode === "missing") process.stdout.write(`Session '${id}' not found.\n`);
  else process.stdout.write(JSON.stringify({ id, source: "acp", messages: [{ role: "user", content: mode === "huge" ? "x".repeat(9 * 1024 * 1024) : "hello" }] }) + "\n");
} else {
  process.stderr.write("unexpected hermes command\n"); process.exit(2);
}
