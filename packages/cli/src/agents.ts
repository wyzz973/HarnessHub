// SPDX-License-Identifier: MIT
/**
 * The agent commands of `hh` (04-agent-plane section 4): `agents` lists the
 * supported agents, `wire` (alias `use`) points one at the gateway after
 * showing the planned file changes, `unwire` restores its files. Diffs come
 * from the daemon with Gateway Keys masked; the key text itself is written
 * only into the agent's configuration and never printed.
 */
import type { Agent, AgentWiringPlan } from "@harnesshub/sdk/client";
import {
  confirm,
  context,
  EXIT,
  list,
  localTime,
  output,
  parse,
  positionals,
  report,
  table,
  UsageError,
  write,
} from "./admin.js";

const USAGE = `Usage:
  hh agents                       list agents: installed, wired, model, drift
  hh wire <agent> [model]         show the changes, confirm, wire to the gateway
          [--models REF[,REF]]... models the agent lists (default: current, or model)
  hh use <agent> <model>          the same as hh wire <agent> <model>
  hh wire <agent> --rotate        give the agent a new key; the old one stops working
  hh unwire <agent>               restore the agent's files and revoke its key

Models are provider/model or group/<id>. Common options: --url URL, --data-dir DIR,
--json, --yes (do not ask), --non-interactive.`;

function drift(agent: Agent): string {
  const wiring = agent.wiring;
  if (!wiring) return "-";
  if (wiring.driftError) return "unknown";
  if (!wiring.drift?.drifted) return "ok";
  return wiring.drift.kinds.join(",");
}

async function agentsCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  positionals(given, []);
  const page = await (await ctx.client()).agents.list();
  output(ctx, page, () =>
    table(
      ["AGENT", "NAME", "INSTALLED", "WIRED", "MODEL", "MODELS", "DRIFT"],
      page.items.map((agent) => [
        agent.id,
        agent.name,
        agent.installation.status,
        agent.wiring
          ? agent.wiring.keyState === "active"
            ? "yes"
            : `yes (key ${agent.wiring.keyState})`
          : "no",
        agent.wiring?.model ?? "-",
        agent.wiring ? String(agent.wiring.models.length) : "-",
        drift(agent),
      ]),
    ),
  );
}

function planText(plan: AgentWiringPlan): string {
  return plan.files
    .filter((file) => file.diff)
    .map(
      (file) =>
        `${file.exists ? "Change" : "Create"} ${file.path}\n${file.diff}`,
    )
    .join("\n");
}

function summary(agent: Agent, done: string): string {
  const wiring = agent.wiring!;
  return [
    `${done} ${agent.name} to ${wiring.model} through the gateway (${agent.protocol}); key ${wiring.keyId}, ${wiring.models.length} model(s) listed.`,
    ...wiring.files.map((file) => `  ${file}`),
    `Restart running ${agent.name} sessions to use the new configuration.`,
  ].join("\n");
}

async function wireCommand(args: string[], alias: boolean): Promise<void> {
  const { values, positionals: given } = parse(args, {
    models: { type: "string", multiple: true },
    rotate: { type: "boolean" },
  });
  const ctx = context(values);
  if (values.rotate) {
    if (alias) throw new UsageError("hh use has no --rotate; use hh wire");
    const [id] = positionals(given, ["agent"]) as [string];
    await confirm(
      ctx,
      `Give ${id} a new Gateway Key? Its configuration is rewritten and the old key stops working.`,
    );
    const agent = await (await ctx.client()).agents.rotate(id);
    return output(ctx, agent, () => summary(agent, "Rotated the key of"));
  }
  if (given.length < 1 || given.length > 2 || (alias && given.length !== 2))
    throw new UsageError(
      alias ? "Expected <agent> <model>" : "Expected <agent> [model]",
    );
  const [id, named] = given as [string, string | undefined];
  const client = await ctx.client();
  const model = named ?? (await client.agents.get(id)).wiring?.model;
  if (model === undefined)
    throw new UsageError(`Name a model: hh wire ${id} <provider/model>`);
  const models = list(values.models).flatMap((item) =>
    item
      .split(",")
      .map((ref) => ref.trim())
      .filter(Boolean),
  );
  const input = { model, ...(models.length ? { models } : {}) };
  const plan = await client.agents.plan(id, input);
  if (!ctx.json) write(planText(plan));
  await confirm(
    ctx,
    `Write these changes to ${plan.files.length === 1 ? "the file" : `${plan.files.length} files`} of ${id}?`,
  );
  const agent = await client.agents.wire(id, { ...input, expect: plan });
  output(ctx, { plan, agent }, () => summary(agent, "Wired"));
}

async function unwireCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  const [id] = positionals(given, ["agent"]) as [string];
  const client = await ctx.client();
  const current = await client.agents.get(id);
  if (current.wiring)
    await confirm(
      ctx,
      `Restore the configuration of ${current.name} from before wiring (${localTime(current.wiring.wiredAt)}) and revoke its key?`,
    );
  const result = await client.agents.unwire(id);
  output(ctx, result, () =>
    [
      ...result.files.map((file) => `${file.action.padEnd(15)} ${file.path}`),
      `Unwired ${result.agent.name}; key ${current.wiring?.keyId ?? "-"} revoked.`,
    ].join("\n"),
  );
}

const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<void>>> = {
  agents: agentsCommand,
  wire: (args) => wireCommand(args, false),
  use: (args) => wireCommand(args, true),
  unwire: unwireCommand,
};

/**
 * Run one agent command (`argv` starts with `agents`, `wire`, `use` or
 * `unwire`). Exit codes are those of the model-plane commands: 0, 1
 * internal, 2 usage, 3 daemon unavailable, 4 confirmation needed, 5
 * conflict (for example a file changed after the preview), 6
 * authentication, 7 limit or not ready, 130 interrupted.
 */
export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || args.includes("--help")) {
    write(USAGE);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    process.stderr.write(`Unknown command: ${name}\n${USAGE}\n`);
    return EXIT.usage;
  }
  try {
    await command(args);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return EXIT.usage;
    }
    return report(error, args.includes("--json"));
  }
}
