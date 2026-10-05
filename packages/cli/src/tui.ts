// SPDX-License-Identifier: MIT
/**
 * `hh tui`: the agents of this machine in the terminal, after Magpie's
 * screen. One row per installed or wired agent with its model, Claude
 * tiers, effort and options; ↵ opens a searchable picker, and a choice is
 * written only after its plan is shown and confirmed. Profiles are saved
 * and applied the same way. Everything goes through the running daemon
 * with the SDK, as `hh agents`, `hh wire` and `hh profile` do.
 */
import type { HarnessHubClient } from "@harnesshub/sdk/client";
import { HarnessHubUnavailableError } from "@harnesshub/sdk/client";
import { AdminTokenUnavailableError } from "@harnesshub/sdk/local";
import { context, EXIT, parse, report, UsageError, write } from "./admin.js";
import { AgentsScreen } from "./tui/app.js";
import {
  decodeKeys,
  Screen,
  styles,
  type Key,
  type TerminalInput,
  type TerminalOutput,
} from "./tui/terminal.js";

const USAGE = `Usage: hh tui [--url URL] [--data-dir DIR]

The agents of this machine in the terminal: ↑↓ chooses an agent, ←→ a field
(model, tiers, effort, options), ↵ opens a picker (type to filter); a
choice shows the file changes, with keys masked, and asks y/n before
writing. s saves a profile, p previews and applies one, r refreshes,
u unwires, R gives the agent a new key, f shows the agents not installed
here, q quits.

It needs a terminal and the running daemon (hh serve); for scripts use
hh agents, hh wire and hh profile. NO_COLOR turns colors off.`;

/** Exit code after SIGTERM, as a shell reports a process it terminated. */
const TERMINATED = 128 + 15;

/** The process events `hh tui` handles while the screen is open. */
export interface TuiHost {
  on(event: "SIGINT" | "SIGTERM" | "exit", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM" | "exit", listener: () => void): unknown;
}

export interface TuiOptions {
  /** The daemon's client; rejects or fails its first call when the daemon is not running. */
  connect: () => Promise<HarnessHubClient>;
  input: TerminalInput;
  output: TerminalOutput;
  /** Messages outside the screen: the refusals before it opens. */
  errors: { write(text: string): unknown };
  host: TuiHost;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Run the agents screen until it is quit.
 *
 * Without a terminal on both input and output it writes why to `errors`
 * and resolves 2; when the daemon is not running, the `hh serve` hint and
 * 3. Otherwise it owns the terminal (raw mode, alternate screen) until `q`
 * (0), Ctrl+C or SIGINT (130), SIGTERM (143) or the host's `exit`, and
 * always restores it before resolving. Keys are handled one at a time;
 * keys other than Ctrl+C that arrive while a daemon call runs are dropped.
 * Daemon refusals are shown on the screen; any other error restores the
 * terminal and rejects with it.
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const { input, output, errors, host } = options;
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    errors.write(
      "hh tui needs a terminal on stdin and stdout. For scripts use hh agents, hh wire <agent> <model> and hh profile.\n",
    );
    return EXIT.usage;
  }
  let screen: Screen | undefined;
  let app: AgentsScreen;
  try {
    const client = await options.connect();
    app = new AgentsScreen(client, styles(options.env), () => draw());
    await app.load();
  } catch (error) {
    if (
      error instanceof HarnessHubUnavailableError ||
      error instanceof AdminTokenUnavailableError
    ) {
      errors.write(
        `HarnessHub is not running (${error.message}).\nStart it in another terminal with: hh serve\nthen run hh tui again (with the same --data-dir, if you gave one).\n`,
      );
      return EXIT.unavailable;
    }
    throw error;
  }
  function draw(): void {
    screen?.draw(app.view(screen.columns, screen.rows));
  }

  return new Promise<number>((resolve, reject) => {
    const open = new Screen(input, output);
    let done = false;
    let queue = Promise.resolve();
    const finish = (outcome: { code: number } | { error: unknown }) => {
      if (done) return;
      done = true;
      input.off("data", onData);
      output.off("resize", onResize);
      host.off("SIGINT", onInterrupt);
      host.off("SIGTERM", onTerminate);
      host.off("exit", onExit);
      open.restore();
      if ("code" in outcome) resolve(outcome.code);
      else
        reject(
          outcome.error instanceof Error
            ? outcome.error
            : new Error(String(outcome.error)),
        );
    };
    const handle = async (key: Key) => {
      if (done) return;
      if ((await app.key(key)) === "quit") finish({ code: EXIT.ok });
      else draw();
    };
    const onData = (chunk: string | Buffer) => {
      for (const key of decodeKeys(chunk.toString())) {
        // Ctrl+C quits at once, even while a daemon call is running.
        if (key.name === "interrupt") return finish({ code: EXIT.interrupted });
        // Other keys pressed during a call are dropped: a y typed ahead must
        // never confirm a plan that was not on the screen yet.
        if (app.busy) continue;
        queue = queue
          .then(() => handle(key))
          .catch((error: unknown) => finish({ error }));
      }
    };
    const onResize = () => {
      try {
        open.invalidate();
        draw();
      } catch (error) {
        finish({ error });
      }
    };
    const onInterrupt = () => finish({ code: EXIT.interrupted });
    const onTerminate = () => finish({ code: TERMINATED });
    // A crash ends the process through `exit`; the terminal is restored first.
    const onExit = () => finish({ code: EXIT.internal });
    input.on("data", onData);
    output.on("resize", onResize);
    host.on("SIGINT", onInterrupt);
    host.on("SIGTERM", onTerminate);
    host.on("exit", onExit);
    try {
      open.open();
      screen = open;
      draw();
    } catch (error) {
      finish({ error });
    }
  });
}

/**
 * Run `hh tui` (`argv` starts with `tui`). Exit codes: 0 after `q`, 2 for
 * usage or without a terminal, 3 when the daemon is not running, 130 after
 * Ctrl+C or SIGINT, 143 after SIGTERM, 1 for anything else; daemon errors
 * at start keep the codes of the other commands.
 */
export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(1);
  if (args.includes("--help")) {
    write(USAGE);
    return EXIT.ok;
  }
  try {
    const { values, positionals } = parse(args, {});
    if (positionals.length) throw new UsageError("hh tui takes no arguments");
    if (values.json || values.yes || values["non-interactive"])
      throw new UsageError(
        "hh tui is interactive; for --json, --yes or scripts use hh agents, hh wire and hh profile",
      );
    return await runTui({
      connect: context(values).client,
      input: process.stdin,
      output: process.stdout,
      errors: process.stderr,
      host: process,
      env: process.env,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return EXIT.usage;
    }
    return report(error, false);
  }
}
