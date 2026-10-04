// SPDX-License-Identifier: MIT
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHub } from "./main.js";
import { SqliteBenchmarkStore } from "@harnesshub/store/storage/benchmark-store";
import {
  BenchmarkRunner,
  parseDataset,
  prepareAttempts,
} from "@harnesshub/runtime/benchmark/runner";
import type { AttemptId } from "@harnesshub/core/benchmark";
import { buildBenchmarkReport } from "@harnesshub/runtime/benchmark/report";

const USAGE = `Usage:
  hh benchmark --dataset FILE --engines ID[,ID]... [--config FILE | --demo]
               [--repeat 1] [--permissions deny|allow-once]
               [--data-dir ./data/benchmark]
                          run every task on each engine and grade it
  hh benchmark --regrade ATTEMPT_ID --data-dir DIR [--config FILE | --demo]
                          grade an attempt's captured evidence again
  hh benchmark --report --data-dir DIR [--batch BATCH_ID] [--config FILE | --demo]
                          report the saved attempts`;

/** A wrong command line: printed with the usage (exit 2), not as a failed benchmark. */
class BenchmarkUsageError extends Error {}

/** The options of `benchmark`; a wrong command line is a BenchmarkUsageError. */
function parseBenchmark(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        dataset: { type: "string" },
        config: { type: "string" },
        engines: { type: "string" },
        repeat: { type: "string", default: "1" },
        permissions: { type: "string", default: "deny" },
        "data-dir": { type: "string", default: "./data/benchmark" },
        demo: { type: "boolean", default: false },
        regrade: { type: "string" },
        report: { type: "boolean", default: false },
        batch: { type: "string" },
      },
    });
  } catch (error) {
    throw new BenchmarkUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Plain-Node benchmark composition. SIGINT/SIGTERM cancel through the same
 * Runtime and stop further attempts. `--help` (or `-h`) anywhere prints the
 * usage; a wrong command line throws BenchmarkUsageError before anything
 * starts.
 */
export async function benchmarkMain(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const { values } = parseBenchmark(args);
  if (values.permissions !== "deny" && values.permissions !== "allow-once")
    throw new BenchmarkUsageError("--permissions must be deny or allow-once");
  if (values.report && (values.dataset || values.engines || values.regrade))
    throw new BenchmarkUsageError(
      "Use --report independently from --dataset/--engines/--regrade",
    );
  if (values.batch !== undefined && (!values.report || !values.batch.trim()))
    throw new BenchmarkUsageError(
      "A non-empty --batch is only valid with --report",
    );
  if (values.regrade && (values.dataset || values.engines))
    throw new BenchmarkUsageError(
      "Use --regrade independently from --dataset/--engines",
    );
  if (!values.regrade && !values.report && (!values.dataset || !values.engines))
    throw new BenchmarkUsageError("--dataset and --engines are required");
  const packageValue: unknown = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (
    !packageValue ||
    typeof packageValue !== "object" ||
    !("version" in packageValue) ||
    typeof packageValue.version !== "string"
  )
    throw new Error("Hub package version is missing");
  const dataDir = path.resolve(values["data-dir"]);
  const attempts =
    values.regrade || values.report
      ? []
      : await prepareAttempts({
          dataDir,
          dataset: parseDataset(
            JSON.parse(await readFile(values.dataset!, "utf8")) as unknown,
          ),
          engines: values.engines!.split(",").map((engine) => engine.trim()),
          repeat: Number(values.repeat),
          hubVersion: packageValue.version,
          permissionPolicy: values.permissions,
        });
  const hub = await startHub({
    dataDir,
    demo: values.demo,
    cwd: process.cwd(),
    port: 0,
    ...(values.config ? { configFile: values.config } : {}),
    ...(attempts.length
      ? { workspaces: attempts.map((attempt) => attempt.workspace) }
      : {}),
  });
  let store: SqliteBenchmarkStore | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    store = new SqliteBenchmarkStore(path.join(dataDir, "harnesshub.sqlite"));
    if (values.report) {
      console.log(JSON.stringify(buildBenchmarkReport(store, values.batch)));
      return 0;
    }
    const runner = new BenchmarkRunner(hub.app, store);
    await runner.reconcile();
    if (values.regrade) {
      const evaluation = runner.regrade(values.regrade as AttemptId);
      console.log(JSON.stringify({ evaluation }));
      return evaluation.status === "passed" ? 0 : 1;
    }
    let passed = 0;
    let executed = 0;
    for (const attempt of attempts) {
      if (controller.signal.aborted) break;
      const evaluation = await runner.execute(attempt, controller.signal);
      executed += 1;
      if (evaluation.status === "passed") passed += 1;
      const saved = store.get(attempt.id);
      console.log(
        JSON.stringify({
          attemptId: saved.id,
          taskId: saved.task.id,
          engineId: saved.engineId,
          profileRevision: saved.profileRevision,
          runId: saved.runId,
          runStatus: saved.runStatus,
          evaluation,
        }),
      );
    }
    console.log(
      JSON.stringify({
        summary: {
          planned: attempts.length,
          executed,
          passed,
          interrupted: controller.signal.aborted,
        },
        dataDir,
      }),
    );
    return executed === attempts.length &&
      passed === executed &&
      !controller.signal.aborted
      ? 0
      : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    store?.close();
    await hub.server.close();
  }
}

/**
 * Command-line entry of `benchmark` (`node dist/src/benchmark-main.js` and
 * `hh benchmark`): runs benchmarkMain and reports a failure as one JSON line on
 * stderr without its details. A wrong command line is printed as `Error:`
 * with the usage instead, with exit code 2.
 *
 * @param argv The command-line arguments after the command itself.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    return await benchmarkMain(argv);
  } catch (error) {
    if (error instanceof BenchmarkUsageError) {
      console.error(`Error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "BenchmarkError",
        message:
          "Benchmark did not complete; inspect saved attempts and Gateway configuration",
      }),
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Not a top-level await: the single executable (tools/sea) bundles this
  // module as CommonJS, which cannot contain one. `main` reports its own errors.
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
