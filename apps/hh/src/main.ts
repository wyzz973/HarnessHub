// SPDX-License-Identifier: MIT
const USAGE = `Usage: hh <command> [arguments]

Commands:
  serve      Start the Gateway (hh serve --help)
  benchmark  Run, regrade or report a benchmark (hh benchmark --help)
  tools      Manage Tool Packs (hh tools --root <directory> <command>)
  rollout    Export a run's rollout (hh rollout --help)`;

/**
 * A command's entry function, loaded only when the command is chosen, so that
 * `hh rollout` does not load the daemon. Resolves to the exit code, or to
 * undefined when the command owns the exit code because it keeps the process
 * running (`serve`).
 */
type Command = (argv: string[]) => Promise<number | undefined>;

const COMMANDS: Readonly<Record<string, Command>> = {
  serve: async (argv) => {
    const { main } = await import("@harnesshub/daemon/main");
    await main(argv.slice(1));
    return undefined;
  },
  benchmark: async (argv) => {
    const { main } = await import("@harnesshub/daemon/benchmark-main");
    return main(argv.slice(1));
  },
  tools: async (argv) => {
    const { main } = await import("@harnesshub/daemon/tool-packages-main");
    return main(argv.slice(1));
  },
  // The rollout command line parses its subcommand itself.
  rollout: async (argv) => {
    const { main } = await import("@harnesshub/cli/cli");
    return main(argv);
  },
};

/**
 * Run one `hh` command: `serve`, `benchmark` and `tools` go to the daemon's
 * entries, `rollout` to the CLI's. `--help` prints the commands on stdout; a
 * missing or unknown command prints them on stderr and fails with exit code 2.
 * A command's own failures keep that command's output and exit code; a
 * `serve` startup failure rejects.
 *
 * @param argv The command-line arguments after `hh`.
 * @returns The exit code, or undefined when the command sets it itself.
 */
export async function main(argv: string[]): Promise<number | undefined> {
  const [name] = argv;
  if (name === "--help" || name === "-h") {
    console.log(USAGE);
    return 0;
  }
  const command =
    name !== undefined && Object.hasOwn(COMMANDS, name)
      ? COMMANDS[name]
      : undefined;
  if (command === undefined) {
    console.error(
      name === undefined ? USAGE : `Unknown command: ${name}\n${USAGE}`,
    );
    return 2;
  }
  return command(argv);
}
