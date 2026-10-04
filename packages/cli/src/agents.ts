// SPDX-License-Identifier: MIT
/**
 * The agent commands of `hh` (04-agent-plane section 4): `agents` lists the
 * supported agents and `agents models` shows or hides the models one lists,
 * `wire` (alias `use`) points one at the gateway after showing the planned
 * file changes, `unwire` restores its files, and `profile` saves and applies
 * every wired agent's model choices. Diffs come from the daemon with Gateway
 * Keys masked; the key text itself is written only into the agent's
 * configuration and never printed.
 */
import type {
  Agent,
  AgentWiringInput,
  AgentWiringPlan,
  ProfilePlan,
  ReasoningEffort,
  WiringTier,
} from "@harnesshub/sdk/client";
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
  hh agents models <agent>        show the models the agent lists and hides
          [--hide REF]... [--show REF]...  hide or show models (others stay as they are)
  hh wire <agent> [model]         show the changes, confirm, wire to the gateway
          [--models REF[,REF]]... models the agent may list (default: current, or every model)
          [--tier TIER=REF]...    a tier's model (Claude Code: opus, sonnet, haiku, fable, subagent)
          [--effort LEVEL]        the effort it starts with: none, minimal, low, medium,
                                  high, xhigh or max, as the agent takes them; --no-effort clears it
          [--option NAME=VALUE]...  an adapter option, such as codexAuth=chatgpt
  hh use <agent> <model>          the same as hh wire <agent> <model>
  hh wire <agent> --rotate        give the agent a new key; the old one stops working
  hh unwire <agent>               restore the agent's files and revoke its key
  hh profile list                 list saved profiles
  hh profile save <name>          save every wired agent's model choices
  hh profile show <name>          show a profile
  hh profile apply <name>         show the changes, confirm, switch the agents to it
  hh profile rm <name>            delete a profile

Models are provider/model or group/<id>; --models and --hide also take provider/*
and *. With --option codexAuth=chatgpt, Codex keeps its ChatGPT sign-in and its own
models and only reaches ChatGPT through the gateway: no key, no model. Common
options: --url URL, --data-dir DIR, --json, --yes (do not ask), --non-interactive.`;

function drift(agent: Agent): string {
  const wiring = agent.wiring;
  if (!wiring) return "-";
  if (wiring.attention) return `attention (${wiring.attention.code})`;
  if (wiring.driftError) return "unknown";
  if (!wiring.drift?.drifted) return "ok";
  return wiring.drift.kinds.join(",");
}

async function agentsCommand(args: string[]): Promise<void> {
  if (args[0] === "models") return modelsCommand(args.slice(1));
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
          ? agent.wiring.keyState === "active" ||
            agent.wiring.keyState === "none"
            ? "yes"
            : `yes (key ${agent.wiring.keyState})`
          : "no",
        agent.wiring ? (agent.wiring.model ?? "(its own)") : "-",
        agent.wiring?.keyId !== undefined
          ? String(agent.wiring.models.length)
          : "-",
        drift(agent),
      ]),
    ),
  );
}

/** A wiring plan as `hh wire` prints it: each changed file and its diff. */
export function planText(plan: AgentWiringPlan): string {
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
    wiring.keyId === undefined
      ? `${done} ${agent.name} through the gateway with its own sign-in and models; no key.`
      : `${done} ${agent.name} to ${wiring.model} through the gateway (${agent.protocol}); key ${wiring.keyId}, ${wiring.models.length} model(s) listed${wiring.hidden.length ? `, ${wiring.hidden.length} hidden` : ""}.`,
    ...Object.entries(wiring.tiers ?? {}).map(
      ([tier, model]) => `  ${tier}: ${model}`,
    ),
    ...(wiring.effort ? [`  effort: ${wiring.effort}`] : []),
    ...wiring.files.map((file) => `  ${file}`),
    `Restart running ${agent.name} sessions to use the new configuration.`,
  ].join("\n");
}

/** `NAME=VALUE` pairs of a repeated option. */
function pairs(values: unknown, flag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of list(values)) {
    const at = item.indexOf("=");
    if (at <= 0 || at === item.length - 1)
      throw new UsageError(`${flag} takes NAME=VALUE, not ${item}`);
    result[item.slice(0, at)] = item.slice(at + 1);
  }
  return result;
}

function refs(values: unknown): string[] {
  return list(values).flatMap((item) =>
    item
      .split(",")
      .map((ref) => ref.trim())
      .filter(Boolean),
  );
}

async function wireCommand(args: string[], alias: boolean): Promise<void> {
  const { values, positionals: given } = parse(args, {
    models: { type: "string", multiple: true },
    tier: { type: "string", multiple: true },
    effort: { type: "string" },
    "no-effort": { type: "boolean" },
    option: { type: "string", multiple: true },
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
  const [id, model] = given as [string, string | undefined];
  if (values.effort !== undefined && values["no-effort"])
    throw new UsageError("Give --effort or --no-effort, not both");
  const client = await ctx.client();
  const models = refs(values.models);
  const tiers = pairs(values.tier, "--tier");
  const options = pairs(values.option, "--option");
  // Absent choices keep the current wiring's; the daemon asks for a model when there is none.
  const input: AgentWiringInput = {
    ...(model !== undefined ? { model } : {}),
    ...(models.length ? { models } : {}),
    ...(Object.keys(tiers).length
      ? { tiers: tiers as Partial<Record<WiringTier, string>> }
      : {}),
    ...(values.effort !== undefined
      ? { effort: values.effort as ReasoningEffort }
      : values["no-effort"]
        ? { effort: null }
        : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
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

async function modelsCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {
    hide: { type: "string", multiple: true },
    show: { type: "string", multiple: true },
  });
  const ctx = context(values);
  const [id] = positionals(given, ["agent"]) as [string];
  const client = await ctx.client();
  const current = await client.agents.get(id);
  const hide = refs(values.hide);
  const show = refs(values.show);
  let agent = current;
  if (hide.length || show.length) {
    if (!current.wiring)
      throw new UsageError(`${id} is not wired; wire it first: hh wire ${id}`);
    const hidden = [...new Set([...current.wiring.hidden, ...hide])].filter(
      (ref) => !show.includes(ref),
    );
    agent = await client.agents.setHidden(id, hidden);
  }
  const wiring = agent.wiring;
  output(ctx, agent, () =>
    !wiring
      ? `${agent.name} is not wired.`
      : [
          `${agent.name} lists ${wiring.models.length} model(s)${wiring.hidden.length ? `; hidden: ${wiring.hidden.join(", ")}` : ""}.`,
          ...wiring.models.map(
            (ref) => `  ${ref}${ref === wiring.model ? "  (model)" : ""}`,
          ),
          ...(hide.length || show.length
            ? [`Restart running ${agent.name} sessions to see the new list.`]
            : []),
        ].join("\n"),
  );
}

/** A profile plan as `hh profile apply` prints it: each changed agent's file diffs. */
export function profileText(plan: ProfilePlan): string {
  return plan.agents
    .map((agent) =>
      agent.plan
        ? `${agent.adapterId}:\n${planText(agent.plan) || "  (no file changes)"}`
        : `${agent.adapterId}: unchanged`,
    )
    .join("\n");
}

async function profileCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals: given } = parse(rest, {});
  const ctx = context(values);
  const client = await ctx.client();
  switch (action) {
    case "list": {
      positionals(given, []);
      const page = await client.profiles.list();
      return output(ctx, page, () =>
        table(
          ["NAME", "AGENTS", "UPDATED"],
          page.items.map((profile) => [
            profile.name,
            Object.keys(profile.agents).join(",") || "-",
            localTime(profile.updatedAt),
          ]),
        ),
      );
    }
    case "save": {
      const [name] = positionals(given, ["name"]) as [string];
      const profile = await client.profiles.save(name);
      return output(
        ctx,
        profile,
        () =>
          `Saved profile ${profile.name}: ${Object.keys(profile.agents).length} agent(s).`,
      );
    }
    case "show": {
      const [name] = positionals(given, ["name"]) as [string];
      const profile = await client.profiles.get(name);
      return output(ctx, profile, () =>
        table(
          ["AGENT", "MODEL", "TIERS", "EFFORT", "OPTIONS"],
          Object.entries(profile.agents).map(([id, choice]) => [
            id,
            choice.model ?? "(its own)",
            Object.entries(choice.tiers ?? {})
              .map(([tier, model]) => `${tier}=${model}`)
              .join(",") || "-",
            choice.effort ?? "-",
            Object.entries(choice.options ?? {})
              .map(([option, value]) => `${option}=${value}`)
              .join(",") || "-",
          ]),
        ),
      );
    }
    case "apply": {
      const [name] = positionals(given, ["name"]) as [string];
      const plan = await client.profiles.plan(name);
      const changed = plan.agents.filter((agent) => agent.changed);
      if (!changed.length)
        return output(
          ctx,
          { profile: plan.profile, agents: [] },
          () => `Every agent already matches profile ${name}.`,
        );
      if (!ctx.json) write(profileText(plan));
      await confirm(
        ctx,
        `Switch ${changed.map((agent) => agent.adapterId).join(", ")} to profile ${name}?`,
      );
      const applied = await client.profiles.apply(name, plan);
      return output(ctx, applied, () =>
        [
          ...applied.agents.map(
            (item) =>
              `${item.outcome.padEnd(9)} ${item.adapterId}${item.agent.wiring?.model ? ` ${item.agent.wiring.model}` : ""}`,
          ),
          "Restart running agent sessions to use the new configuration.",
        ].join("\n"),
      );
    }
    case "rm": {
      const [name] = positionals(given, ["name"]) as [string];
      await client.profiles.remove(name);
      return output(ctx, { deleted: name }, () => `Deleted profile ${name}.`);
    }
    default:
      throw new UsageError(
        action === undefined
          ? "Name a profile command: list, save, show, apply or rm"
          : `Unknown profile command: ${action}`,
      );
  }
}

const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<void>>> = {
  agents: agentsCommand,
  wire: (args) => wireCommand(args, false),
  use: (args) => wireCommand(args, true),
  unwire: unwireCommand,
  profile: profileCommand,
};

/**
 * Run one agent command (`argv` starts with `agents`, `wire`, `use`,
 * `unwire` or `profile`). Exit codes are those of the model-plane commands: 0, 1
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
