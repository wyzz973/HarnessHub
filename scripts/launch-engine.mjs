/** Portable env/argv launcher. ProcessHost owns its complete process tree. Never logs argv, configuration, or stderr. */
import { spawnEngine } from "./spawn-engine.mjs";

function fail() {
  process.stderr.write(
    "Engine launcher could not start the configured command\n",
  );
  process.exitCode = 1;
}

try {
  const args = process.argv.slice(2);
  const environment = { ...process.env };
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? "")) {
    const item = args.shift();
    const at = item.indexOf("=");
    const key = item.slice(0, at);
    if (process.platform === "win32") {
      for (const previous of Object.keys(environment))
        if (previous.toLowerCase() === key.toLowerCase())
          delete environment[previous];
    }
    environment[key] = item.slice(at + 1);
  }
  if (
    args.shift() !== "--" ||
    !args[0] ||
    args.some((arg) => arg.includes("\0"))
  ) {
    throw new Error("Invalid launcher argument boundary");
  }
  const executable = args.shift();
  // cross-spawn handles Windows executable lookup and batch quoting. No shell:true,
  // string-built command, or PowerShell -Command evaluates caller arguments.
  const child = spawnEngine(executable, args, {
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    detached: false,
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.once("error", fail);
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  if (
    error.message ===
    "Windows batch launch requires single-line arguments; use stdin or a native executable for multiline input"
  ) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 2;
  } else fail();
}
