// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
switch (mode) {
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
    setInterval(() => {}, 10_000);
    break;
  }
  case "descendant":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 10_000);
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
    if (mode === "escape-both" || process.argv[3] === "wait")
      setInterval(() => {}, 10_000);
    break;
  }
  case "orphan-sentinel": {
    // Started by a test, not by a Worker: an unrelated process in its own
    // session whose environment carries argv[3] as its tree marker value.
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
  case "sentinel":
    // An unrelated look-alike with default SIGTERM handling: any signal ends it.
    setInterval(() => {}, 10_000);
    break;
  default:
    throw new Error("Unknown CLI fixture scenario");
}
