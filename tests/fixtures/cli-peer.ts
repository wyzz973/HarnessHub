// SPDX-License-Identifier: MIT
import { WORKER_ENTRY } from "../support/entries.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

/** Waiting fixtures exit on their own after this, so a failed test cannot leak them. */
const MAX_LIFETIME_MS = 60_000;
function linger(): void {
  setTimeout(() => process.exit(0), MAX_LIFETIME_MS);
}

const mode = process.argv[2];
switch (mode?.startsWith("--harnesshub-owner=") ? "fake-worker" : mode) {
  case "stdin": {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected input bytes");
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks);
    // Deliberately separate UTF-8 continuation bytes across pipe writes.
    for (const byte of input) {
      process.stdout.write(Buffer.from([byte]));
      await delay(2);
    }
    break;
  }
  case "argv":
    process.stdin.resume();
    process.stdout.write(process.argv[3] ?? "missing prompt");
    break;
  case "failure":
    process.stderr.write("DO_NOT_PUBLISH_SECRET=fixture-private-value\n");
    process.exitCode = 23;
    break;
  case "overflow":
    process.stdin.resume();
    process.stdout.write("中文");
    break;
  case "background-success":
  case "background-failure": {
    process.stdin.resume();
    const child = spawn(process.execPath, [process.argv[1]!, "descendant"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    child.unref();
    process.stdout.write(
      JSON.stringify({ parent: process.pid, child: child.pid }) + "\n",
    );
    process.exitCode = mode === "background-success" ? 0 : 23;
    break;
  }
  case "wait": {
    process.stdin.resume();
    const child = spawn(process.execPath, [process.argv[1]!, "descendant"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    process.on("SIGTERM", () => {});
    process.stdout.write(
      JSON.stringify({ parent: process.pid, child: child.pid }) + "\n",
    );
    linger();
    break;
  }
  case "descendant":
    process.on("SIGTERM", () => {});
    linger();
    break;
  case "escape-intermediate": {
    // Start a descendant in its own session (setsid), report it and exit, so
    // the descendant is reparented before any cleanup begins.
    const child = spawn(process.execPath, [process.argv[1]!, "descendant"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    process.stdout.write(`${child.pid}\n`);
    break;
  }
  case "escape-orphan":
  case "escape-both": {
    process.stdin.resume();
    const intermediate = spawn(
      process.execPath,
      [process.argv[1]!, "escape-intermediate"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const closed = once(intermediate, "close");
    let reported = "";
    intermediate.stdout.setEncoding("utf8");
    for await (const chunk of intermediate.stdout) reported += String(chunk);
    await closed;
    const report: Record<string, unknown> = {
      parent: process.pid,
      orphan: Number(reported.trim()),
      marker: process.env.HARNESSHUB_WORKER_TREE ?? null,
    };
    if (mode === "escape-both") {
      // A setsid descendant with a fresh environment: only its parent chain
      // links it to the Worker while this engine is alive.
      const cleared = spawn(
        process.execPath,
        [process.argv[1]!, "descendant"],
        {
          stdio: "ignore",
          detached: true,
          env: { PATH: process.env.PATH ?? "" },
        },
      );
      report.cleared = cleared.pid;
    }
    process.stdout.write(JSON.stringify(report) + "\n");
    if (mode === "escape-both" || process.argv[3] === "wait") linger();
    break;
  }
  case "orphan-sentinel": {
    // Started by a test, not by a Worker: an unrelated process in its own
    // session whose environment carries argv[3] as its tree marker value.
    // argv[4] is the sentinel's signal file, the rest its extra arguments.
    const child = spawn(
      process.execPath,
      [process.argv[1]!, "sentinel", ...process.argv.slice(4)],
      {
        stdio: "ignore",
        detached: true,
        env: {
          PATH: process.env.PATH ?? "",
          HARNESSHUB_WORKER_TREE: process.argv[3] ?? "",
        },
      },
    );
    child.unref();
    process.stdout.write(`${child.pid}\n`);
    break;
  }
  case "sentinel": {
    // Records any catchable termination signal in argv[3], then exits.
    const file = process.argv[3]!;
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
      process.on(signal, () => {
        writeFileSync(file, signal);
        process.exit(0);
      });
    linger();
    break;
  }
  case "fake-worker": {
    // Command line of a leased Worker (`node <script> --harnesshub-owner=...`)
    // in its own group. After a line on stdin it runs lease recovery in a
    // child that stays in this group, printing the child's result.
    const file = process.env.FIXTURE_SIGNAL_FILE!;
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
      process.on(signal, () => {
        writeFileSync(file, signal);
        process.exit(0);
      });
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      if (line !== "recover") continue;
      lines.close();
      const child = spawn(
        process.execPath,
        [process.argv[1]!, "recover-leases", process.env.FIXTURE_LEASE_DIR!],
        { stdio: ["ignore", "inherit", "ignore"] },
      );
      const [code, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      process.stdout.write(
        JSON.stringify({ recovery: { code, signal } }) + "\n",
      );
      break;
    }
    linger();
    break;
  }
  case "recover-leases": {
    const { ProcessWorkerHost } =
      await import("@harnesshub/runtime/process/worker-host");
    const host = new ProcessWorkerHost({
      workerEntry: WORKER_ENTRY,
      leaseDir: process.argv[3]!,
      shutdownGraceMs: 300,
    });
    const statuses = await host.recover();
    process.stdout.write(
      JSON.stringify({ statuses: Object.fromEntries(statuses) }) + "\n",
    );
    break;
  }
  default:
    throw new Error("Unknown CLI fixture scenario");
}
