// SPDX-License-Identifier: MIT
import { Worker } from "node:worker_threads";
import { NO_LOG, type LogSink } from "@harnesshub/core/logging";

/**
 * The worker: its own connection to the database, which checkpoints the WAL
 * when asked (`PASSIVE`: as far as readers and the writer allow, never
 * waiting for them) and closes when told. CommonJS run with `eval`, so that
 * no file of its own has to ship beside the store (the single executable).
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file);
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
parentPort.on("message", (message) => {
  if (message === "close") {
    db.close();
    parentPort.close();
    return;
  }
  try {
    const row = checkpoint.get();
    parentPort.postMessage({ log: row.log, checkpointed: row.checkpointed });
  } catch (error) {
    parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
  }
});
`;

/** Frames in the WAL and how many of them are in the database now, or why the checkpoint failed. */
type Outcome = { log: number; checkpointed: number } | { message: string };

/** How often the writer's changes are looked at; a checkpoint follows at most this long after a write. */
export const CHECKPOINT_INTERVAL_MS = 100;

/**
 * WAL checkpoints of one writing connection, off its commits: the writer
 * turns automatic checkpoints off (`wal_autocheckpoint = 0`), and every
 * {@link CHECKPOINT_INTERVAL_MS} this looks at its `total_changes()`; when
 * they moved, a worker thread with a connection of its own checkpoints the
 * WAL. A commit then never copies pages back into the database and fsyncs
 * it, and the event loop never waits for that either. One checkpoint is in
 * flight at a time, so the WAL holds at most one interval's writes and one
 * checkpoint's beyond what was checkpointed. A checkpoint that left frames
 * behind (written meanwhile, or a reader in the way) is asked for again at
 * the next interval; a failed one is logged as `store.checkpoint_failed`
 * and asked for again too; a worker that dies is started again. The worker
 * starts with the first change.
 *
 * Crash safety is SQLite's: a checkpoint copies only committed frames and
 * the WAL stays the record until it is complete, so a process killed with
 * one in flight recovers on the next open.
 */
export class WalCheckpoints {
  readonly #file: string;
  readonly #changes: () => number;
  readonly #log: LogSink;
  #worker: Worker | undefined;
  #exited: Promise<void> = Promise.resolve();
  /** `total_changes()` at the last checkpoint asked for. */
  #seen = 0;
  #inFlight = false;
  #closed = false;
  readonly #timer: NodeJS.Timeout;

  /**
   * @param file The database's path, opened again by the worker.
   * @param changes The writer's `total_changes()`.
   */
  constructor(
    file: string,
    changes: () => number,
    log: LogSink = NO_LOG,
    intervalMs = CHECKPOINT_INTERVAL_MS,
  ) {
    this.#file = file;
    this.#changes = changes;
    this.#log = log;
    this.#seen = changes();
    this.#timer = setInterval(() => this.#tick(), intervalMs);
    this.#timer.unref();
  }

  #tick(): void {
    if (this.#closed || this.#inFlight) return;
    const changes = this.#changes();
    if (changes === this.#seen) return;
    this.#seen = changes;
    this.#inFlight = true;
    this.#spawn().postMessage("checkpoint");
  }

  #spawn(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { file: this.#file },
    });
    worker.unref();
    worker.on("message", (outcome: Outcome) => {
      this.#inFlight = false;
      if ("message" in outcome)
        this.#log.info("store.checkpoint_failed", {
          message: outcome.message.slice(0, 200),
        });
      // Frames left behind are asked for again at the next interval.
      if ("message" in outcome || outcome.checkpointed < outcome.log)
        this.#seen = Number.NaN;
    });
    worker.on("error", (error) => {
      this.#log.info("store.checkpoint_failed", {
        message: error.message.slice(0, 200),
      });
    });
    this.#exited = new Promise((resolve) =>
      worker.once("exit", () => {
        if (this.#worker === worker) this.#worker = undefined;
        // A worker that died with a checkpoint in flight: started again.
        if (this.#inFlight) {
          this.#inFlight = false;
          this.#seen = Number.NaN;
        }
        resolve();
      }),
    );
    this.#worker = worker;
    return worker;
  }

  /**
   * Stops looking and closes the worker's connection; resolves once the
   * worker exited, after a checkpoint in flight. Idempotent.
   */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      clearInterval(this.#timer);
      // Held open until it exited, so that awaiting this keeps the process.
      this.#worker?.ref();
      this.#worker?.postMessage("close");
    }
    return this.#exited;
  }
}
