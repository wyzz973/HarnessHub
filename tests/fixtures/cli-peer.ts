import { spawn } from "node:child_process";
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
  default:
    throw new Error("Unknown CLI fixture scenario");
}
