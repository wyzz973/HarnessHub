// SPDX-License-Identifier: MIT
const USAGE = `Usage: hh <command> [arguments]

Commands:
  serve       Start the Gateway (hh serve --help)
  version     Print the build identity (--json for all of it)
  init        Set up: add a provider from a preset, wire the agents installed here
  config      Show or edit config.jsonc (show, get, set, unset)
  status      Show the running daemon and its model plane
  console     Print a one-time link that signs a browser in to the console
  provider    Manage model providers (list, show, presets, models, add, proxy, limits, remove, test, doctor)
  import      Add providers from an import link or from Claude Code / Codex
  credential  Manage provider credentials (list, add, rotate, remove)
  key         Manage Gateway Keys and their limits (list, create, quota, limit, revoke)
  gateway     Gateway features and LAN sharing (features, redaction, vision, search, share on|off|status)
  group       Manage route groups and their rules (list, add, remove, auto, hide, restore, rule)
  model       Show model metadata with its sources; set overrides
  catalog     Show or refresh the models.dev catalog (status, refresh)
  usage       Summarize model-call usage by model, provider or day
  subscription  Sign in a subscription account (login chatgpt|copilot, setup copilot, list, logout, notice)
  agents      List local agents: installed, wired, model and drift
  wire        Point an agent at the gateway (hh wire codex deepseek/deepseek-chat)
  use         The same as wire: hh use <agent> <model>
  unwire      Restore an agent's configuration and revoke its key
  profile     Save and apply every wired agent's model choices (save, list, apply, rm)
  tui         The agents in the terminal: pick models, tiers and effort, apply profiles
  backup      Seal providers, keys, groups and agent wirings into a file
  restore     Restore a backup (hh restore --help)
  sync        Sync with other machines through WebDAV or S3 (hh sync --help)
  library     Keep instructions, MCP servers and skills; sync them into agents (list, add, rm, sync)
  benchmark   Run, regrade or report a benchmark (hh benchmark --help)
  tools       Manage Tool Packs (hh tools --root <directory> <command>)
  rollout     Export a run's rollout (hh rollout --help)`;

/**
 * A command's entry function, loaded only when the command is chosen, so that
 * `hh rollout` does not load the daemon. Resolves to the exit code, or to
 * undefined when the command owns the exit code because it keeps the process
 * running (`serve`).
 */
type Command = (argv: string[]) => Promise<number | undefined>;

/** `hh version [--json]`, also `hh --version`: the daemon's build identity. */
const version: Command = async (argv) => {
  const { main } = await import("@harnesshub/daemon/main");
  await main(["--version", ...argv.slice(1)]);
  return undefined;
};

const COMMANDS: Readonly<Record<string, Command>> = {
  serve: async (argv) => {
    const { main } = await import("@harnesshub/daemon/main");
    await main(argv.slice(1));
    return undefined;
  },
  version,
  benchmark: async (argv) => {
    const { main } = await import("@harnesshub/daemon/benchmark-main");
    return main(argv.slice(1));
  },
  tools: async (argv) => {
    const { main } = await import("@harnesshub/daemon/tool-packages-main");
    return main(argv.slice(1));
  },
  config: async (argv) => {
    const { main } = await import("@harnesshub/daemon/config-main");
    return main(argv);
  },
  console: async (argv) => {
    const { main } = await import("@harnesshub/cli/console");
    return main(argv);
  },
  init: async (argv) => {
    const { main } = await import("@harnesshub/cli/init");
    return main(argv);
  },
  library: async (argv) => {
    const { main } = await import("@harnesshub/cli/library");
    return main(argv);
  },
  tui: async (argv) => {
    const { main } = await import("@harnesshub/cli/tui");
    return main(argv);
  },
  // The rollout command line parses its subcommand itself.
  rollout: async (argv) => {
    const { main } = await import("@harnesshub/cli/cli");
    return main(argv);
  },
  ...Object.fromEntries(
    ["agents", "wire", "use", "unwire", "profile"].map(
      (name): [string, Command] => [
        name,
        async (argv) => {
          const { main } = await import("@harnesshub/cli/agents");
          return main(argv);
        },
      ],
    ),
  ),
  ...Object.fromEntries(
    ["backup", "restore", "sync"].map((name): [string, Command] => [
      name,
      async (argv) => {
        const { main } = await import("@harnesshub/cli/backup");
        return main(argv);
      },
    ]),
  ),
  ...Object.fromEntries(
    [
      "status",
      "provider",
      "import",
      "credential",
      "key",
      "group",
      "model",
      "catalog",
      "usage",
      "gateway",
      "subscription",
    ].map((name): [string, Command] => [
      name,
      async (argv) => {
        const { main } = await import("@harnesshub/cli/admin");
        return main(argv);
      },
    ]),
  ),
};

/**
 * Every command `main` runs. The single executable (tools/sea) runs `main`
 * for all of them, and its build fails when one of these does not answer
 * `--help` from the built binary.
 */
export const COMMAND_NAMES: readonly string[] = Object.keys(COMMANDS);

/**
 * Run one `hh` command: `serve`, `version`, `config`, `benchmark` and `tools`
 * go to the daemon's entries; `console`, `rollout` and the model-plane commands (`status`, `provider`,
 * `credential`, `key`, `group`, `model`, `catalog`, `usage`, `gateway`,
 * `subscription`), the agent commands (`agents`, `wire`, `use`, `unwire`,
 * `profile`, `library`, `tui`) and `init` to the CLI's, which
 * reach the running daemon over HTTP. `--help` prints the commands on stdout;
 * a missing or unknown command prints them on stderr and fails with exit code 2.
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
  if (name === "--version") return version(argv);
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
