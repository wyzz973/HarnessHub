import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHub } from "./main.js";
import { SqliteBenchmarkStore } from "./storage/benchmark-store.js";
import {
  BenchmarkRunner,
  parseDataset,
  prepareAttempts,
} from "./benchmark/runner.js";
import type { AttemptId } from "./domain/benchmark.js";
import { buildBenchmarkReport } from "./benchmark/report.js";

/** Plain-Node benchmark composition. SIGINT/SIGTERM cancel through the same Runtime and stop further attempts. */
export async function benchmarkMain(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: "string" },
      config: { type: "string" },
      engines: { type: "string" },
      repeat: { type: "string", default: "1" },
      "data-dir": { type: "string", default: "./data/benchmark" },
      demo: { type: "boolean", default: false },
      regrade: { type: "string" },
      report: { type: "boolean", default: false },
      batch: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "HarnessHub Benchmark: node dist/src/benchmark-main.js --dataset examples/benchmark-text.json --engines dsh --config engines/local.yaml [--repeat 1] [--data-dir ./data/benchmark]\nRegrade captured evidence: --regrade ATTEMPT_ID --data-dir DATA_DIR [--config engines/local.yaml | --demo]\nReport saved attempts: --report --data-dir DATA_DIR [--batch BATCH_ID] [--config engines/local.yaml | --demo]",
    );
    return 0;
  }
  if (values.report && (values.dataset || values.engines || values.regrade))
    throw new Error(
      "Use --report independently from --dataset/--engines/--regrade",
    );
  if (values.batch !== undefined && (!values.report || !values.batch.trim()))
    throw new Error("A non-empty --batch is only valid with --report");
  if (values.regrade && (values.dataset || values.engines))
    throw new Error("Use --regrade independently from --dataset/--engines");
  if (!values.regrade && !values.report && (!values.dataset || !values.engines))
    throw new Error("--dataset and --engines are required");
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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await benchmarkMain(process.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : "BenchmarkError",
        message:
          "Benchmark did not complete; inspect saved attempts and Gateway configuration",
      }),
    );
    process.exitCode = 1;
  }
}
