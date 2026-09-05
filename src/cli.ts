import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { RunId } from "./domain/types.js";
import { exportRollout } from "./rollout/export.js";

const usage =
  "Usage: node dist/src/cli.js rollout --url http://127.0.0.1:3180 --run RUN_ID --output FILE";

/** Run one export command; SIGINT/SIGTERM cancel I/O and remove partial output. */
export async function runCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      run: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "rollout") {
    throw new Error(usage);
  }
  if (!values.url || !values.run || !values.output) {
    throw new Error(`Missing --url, --run or --output. ${usage}`);
  }
  if (values.run.length > 100 || values.run.trim().length === 0) {
    throw new Error("--run must contain between 1 and 100 characters");
  }
  const url = new URL(values.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "--url must be an HTTP(S) Gateway URL without embedded credentials",
    );
  }
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("Rollout export cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const exported = await exportRollout({
      url,
      runId: values.run as RunId,
      output: values.output,
      signal: abort.signal,
    });
    console.log(JSON.stringify(exported));
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Rollout export failed",
    );
    process.exitCode = 1;
  });
}
