// SPDX-License-Identifier: MIT
/**
 * `hh init`, the first-run wizard (06-interfaces section 5; Magpie's "add a
 * provider, pick models for agents"): checks that the daemon runs, adds a
 * provider from a preset with its key, refreshes its models, and wires the
 * chosen agents to a default model after one combined preview. Every step
 * goes through the SDK, as `hh provider add` and `hh wire` do. In a
 * terminal it asks for what the options leave out; without one, the
 * options are the answers and a missing one fails with exit code 2. The key
 * is read from a hidden prompt or a `--credential-from-*` source, never
 * from the command line.
 */
import {
  HarnessHubError,
  HarnessHubUnavailableError,
  type Agent,
  type AgentWiringInput,
  type AgentWiringPlan,
  type HarnessHubClient,
  type ProviderConfig,
  type ProviderPreset,
  type WiringTier,
} from "@harnesshub/sdk/client";
import {
  AdminTokenUnavailableError,
  DEFAULT_DAEMON_URL,
} from "@harnesshub/sdk/local";
import { choosePreset } from "@harnesshub/core/provider-presets";
import {
  ConfirmationRequired,
  context,
  credentialGiven,
  EXIT,
  hiddenPrompt,
  list,
  parse,
  readLine,
  readSecret,
  rebase,
  report,
  UsageError,
  write,
} from "./admin.js";
import { planText } from "./agents.js";

const USAGE = `Usage: hh init [options]

Sets HarnessHub up in six steps: checks that the daemon runs (start it with
hh serve), adds a provider from a preset with its key, refreshes its models,
picks the agents installed here, picks a default model (and Claude Code's
tiers), then shows every agent's changes together and wires them once you
confirm. In a terminal it asks for what the options leave out.

Options:
  --preset ID            the provider preset (hh provider presets lists them)
  --region ID --plan ID  the preset's region and plan (default: the first)
  --base URL             move the preset's endpoints to another base URL
  --credential-from-env VAR | --credential-from-file PATH | --credential-from-stdin
                         the provider's key; in a terminal it is asked for
  --agents A[,A]...      the agents to wire, or all (the installed ones), or none
  --model PROVIDER/MODEL the agents' default model
  --tier TIER=REF...     a Claude Code tier's model (opus, sonnet, haiku, fable, subagent)
  --yes                  wire without asking (the changes are still shown)

Non-interactive: hh init --preset deepseek --credential-from-env DEEPSEEK_API_KEY \\
  --agents claude,codex --model deepseek/deepseek-chat --yes
Common options: --url URL, --data-dir DIR, --json, --non-interactive.`;

/** How the wizard asks the person at the terminal. */
export interface Prompter {
  /** Asks and resolves to the answer, without its line end. */
  ask(question: string): Promise<string>;
  /** Asks without echoing the answer. */
  secret(question: string): Promise<string>;
  /** Shows a menu or progress (stderr in a terminal). */
  note(text: string): void;
}

/** The terminal: questions and menus on stderr, answers from stdin. */
export function terminalPrompter(): Prompter {
  return {
    ask: async (question) => {
      process.stderr.write(question);
      return (await readLine()).replace(/\r$/, "");
    },
    secret: (question) => hiddenPrompt(question),
    note: (text) =>
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
  };
}

/** What the options already answer. */
export interface InitAnswers {
  preset?: string;
  region?: string;
  plan?: string;
  base?: string;
  /** The provider's key, already read from its source. */
  credential?: string;
  /** Agent ids, `all` (the installed ones) or `none`. */
  agents?: string[] | "all" | "none";
  model?: string;
  tiers?: Partial<Record<WiringTier, string>>;
  /** Wire without asking. */
  yes: boolean;
}

/** `hh init --json`, and what the wizard did. */
export interface InitResult {
  provider: {
    id: string;
    /** False when a provider of that id was there already and was used. */
    created: boolean;
    models: number;
    /** Why refreshing the models failed; the preset's list was kept. */
    refreshError?: string;
  };
  agents: Array<{
    agent: string;
    model?: string;
    tiers?: Partial<Record<WiringTier, string>>;
    outcome: "wired" | "unchanged" | "failed";
    error?: string;
  }>;
}

const KIND_TITLES = [
  ["vendor", "Vendors"],
  ["relay", "Relays"],
  ["local", "Local"],
  ["custom", "Custom"],
] as const;

/** Up to five names close to `given` (a prefix of it, or within two edits). */
function candidates(given: string, names: readonly string[]): string[] {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j]!;
        row[j] = Math.min(
          row[j]! + 1,
          row[j - 1]! + 1,
          previous + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        previous = current;
      }
    }
    return row[b.length]!;
  };
  return names
    .filter((name) => name.startsWith(given) || distance(given, name) <= 2)
    .slice(0, 5);
}

function unknown(
  what: string,
  given: string,
  names: readonly string[],
): UsageError {
  const close = candidates(given, names);
  return new UsageError(
    `There is no ${what} ${given}${close.length ? `; did you mean ${close.join(", ")}?` : ""}`,
  );
}

/**
 * Asks until `pick` accepts the answer; `pick` resolves to undefined to
 * ask again (after saying why with `prompter.note`).
 */
async function until<T>(
  prompter: Prompter,
  question: string,
  pick: (answer: string) => T | undefined,
): Promise<T> {
  for (;;) {
    const chosen = pick((await prompter.ask(question)).trim());
    if (chosen !== undefined) return chosen;
  }
}

/** A preset from a numbered, grouped menu, narrowed by searching. */
async function askPreset(
  prompter: Prompter,
  presets: readonly ProviderPreset[],
): Promise<ProviderPreset> {
  let shown = [...presets];
  for (;;) {
    const lines: string[] = [];
    let number = 0;
    const numbered: ProviderPreset[] = [];
    for (const [kind, title] of KIND_TITLES) {
      const items = shown.filter((item) => item.kind === kind);
      if (!items.length) continue;
      lines.push(`${title}:`);
      for (const item of items) {
        numbered.push(item);
        lines.push(
          `  ${String(++number).padStart(2)}. ${item.id.padEnd(20)} ${item.name}${item.auth.methods.includes("api-key") ? "" : " (no key)"}`,
        );
      }
    }
    prompter.note(lines.join("\n"));
    const answer = (
      await prompter.ask("Preset (number or id; other text searches): ")
    ).trim();
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    if (numbered[index]) return numbered[index];
    const exact = presets.find((item) => item.id === answer);
    if (exact) return exact;
    const search = answer.toLowerCase();
    const found = presets.filter(
      (item) =>
        item.id.includes(search) || item.name.toLowerCase().includes(search),
    );
    if (!answer || !found.length) {
      prompter.note(
        answer ? `No preset matches "${answer}".` : "Choose a preset.",
      );
      shown = [...presets];
    } else shown = found;
  }
}

/** One of `options` (the first by default) from a numbered menu. */
async function askOption<T extends { id: string; name: string }>(
  prompter: Prompter,
  what: string,
  options: readonly T[],
): Promise<T> {
  prompter.note(
    [
      `${what}s:`,
      ...options.map(
        (option, index) =>
          `  ${String(index + 1).padStart(2)}. ${option.id.padEnd(20)} ${option.name}`,
      ),
    ].join("\n"),
  );
  return until(
    prompter,
    `${what} (number or id; Enter for ${options[0]!.id}): `,
    (answer) => {
      if (!answer) return options[0];
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      const found =
        options[index] ?? options.find((item) => item.id === answer);
      if (!found) prompter.note(`There is no ${what.toLowerCase()} ${answer}.`);
      return found;
    },
  );
}

/** The models a provider exposes, as Model Refs. */
function exposed(provider: ProviderConfig): string[] {
  const { models } = provider;
  return models.list
    .filter(
      (model) => models.expose === "all" || models.expose.includes(model.id),
    )
    .map((model) => `${provider.id}/${model.id}`);
}

function pairs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const at = item.indexOf("=");
    if (at <= 0 || at === item.length - 1)
      throw new UsageError(`Expected TIER=MODEL, not ${item}`);
    result[item.slice(0, at)] = item.slice(at + 1);
  }
  return result;
}

/**
 * The agents `--agents` names: all the installed ones, none, or each by
 * its exact id, which must be installed here.
 *
 * @throws UsageError for an unknown or missing agent.
 */
function chosenAgents(
  agents: readonly Agent[],
  given: string[] | "all" | "none",
): Agent[] {
  const installed = agents.filter(
    (agent) => agent.installation.status !== "not-found",
  );
  if (given === "none") return [];
  if (given === "all") return installed;
  return given.map((id) => {
    const agent = agents.find((item) => item.id === id);
    if (!agent)
      throw unknown(
        "agent",
        id,
        agents.map((item) => item.id),
      );
    if (agent.installation.status === "not-found")
      throw new UsageError(`${agent.name} (${id}) is not installed here`);
    return agent;
  });
}

/**
 * Runs the wizard against a running daemon. With `prompter` (a terminal),
 * what `answers` leave out is asked; without one, a missing answer fails
 * with UsageError. The provider is added before the agents' changes are
 * shown; agents are wired only after confirmation (or `answers.yes`), each
 * through its plan, and one that fails leaves the others wired.
 *
 * @throws UsageError for a missing or unknown answer without a terminal.
 * @throws ConfirmationRequired when the changes are declined or need `--yes`.
 */
export async function runInit(
  client: HarnessHubClient,
  answers: InitAnswers,
  prompter: Prompter | undefined,
  out: (text: string) => void,
): Promise<InitResult> {
  const note = (text: string) => prompter?.note(text);

  // 2. The preset, its region and plan, and the key.
  const presets = (await client.presets.list()).items;
  let preset: ProviderPreset;
  if (answers.preset !== undefined) {
    const found = presets.find((item) => item.id === answers.preset);
    if (!found)
      throw unknown(
        "preset",
        answers.preset,
        presets.map((item) => item.id),
      );
    preset = found;
  } else if (prompter) preset = await askPreset(prompter, presets);
  else
    throw new UsageError(
      "Name a preset with --preset (hh provider presets lists them)",
    );
  const region =
    answers.region ??
    (prompter && preset.regions
      ? (await askOption(prompter, "Region", preset.regions)).id
      : undefined);
  const plan =
    answers.plan ??
    (prompter && preset.plans
      ? (await askOption(prompter, "Plan", preset.plans)).id
      : undefined);
  let chosen: ReturnType<typeof choosePreset>;
  try {
    chosen = choosePreset(preset, { region, plan });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  let base = answers.base;
  if (base === undefined && preset.userEndpoint) {
    if (!prompter)
      throw new UsageError(
        `The preset ${preset.id} needs its base URL: give --base URL`,
      );
    base = await until(prompter, "Base URL of the server: ", (answer) => {
      try {
        rebase({}, answer);
        return answer;
      } catch (error) {
        prompter.note(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    });
  }
  if (!prompter && answers.agents !== undefined && answers.agents !== "none") {
    // Without a terminal, every answer is checked before anything is added.
    const wiring = await client.agents.list().then(
      (page) => page.items,
      (error: unknown) => {
        if (error instanceof HarnessHubError) return undefined;
        throw error;
      },
    );
    if (
      wiring &&
      chosenAgents(wiring, answers.agents).length &&
      answers.model === undefined
    )
      throw new UsageError(
        "Give the agents' default model with --model PROVIDER/MODEL",
      );
  }
  const providers = (await client.providers.list()).items;
  const existing = providers.find((item) => item.id === preset.id);
  const methods = preset.auth.methods;
  let credential = answers.credential;
  const needsKey = !existing?.credentials.length && methods.includes("api-key");
  if (credential === undefined && needsKey) {
    const optional = methods.includes("none");
    if (prompter) {
      const keys = chosen.preset.keysUrl ?? preset.keysUrl;
      const value = await prompter.secret(
        `API key for ${preset.name}${keys ? ` (from ${keys})` : ""}${optional ? "; Enter for none" : ""} (hidden): `,
      );
      if (value) credential = value;
      else if (!optional)
        throw new UsageError(`${preset.name} needs an API key`);
    } else if (!optional)
      throw new UsageError(
        `${preset.name} needs an API key: give --credential-from-env VAR, --credential-from-file PATH or --credential-from-stdin`,
      );
  }

  // The provider: added, or the one of that id used.
  let provider: ProviderConfig;
  let created = false;
  if (existing) {
    note(`Using the provider ${existing.id} that is already here.`);
    provider = existing;
    if (credential !== undefined && !existing.credentials.length)
      await client.credentials.add(existing.id, {
        name: "default",
        value: credential,
      });
  } else {
    provider = await client.providers.create({
      preset: preset.id,
      ...(region !== undefined ? { region } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(base !== undefined
        ? { endpoints: rebase(chosen.preset.endpoints, base) }
        : {}),
      ...(credential !== undefined
        ? { credential: { value: credential } }
        : {}),
    });
    created = true;
    note(
      `Added the provider ${provider.id}${provider.region ? `, region ${provider.region}` : ""}${provider.plan ? `, plan ${provider.plan}` : ""}${credential !== undefined ? " with its key in the secret store" : ""}.`,
    );
  }

  // 3. Its models.
  let refreshError: string | undefined;
  try {
    provider = await client.providers.refreshModels(provider.id);
  } catch (error) {
    if (!(error instanceof HarnessHubError)) throw error;
    refreshError = `${error.code}: ${error.message}`;
    note(
      `Refreshing the models failed (${refreshError}); the preset's list is used.`,
    );
    provider = await client.providers.get(provider.id);
  }
  const models = exposed(provider);
  note(
    `${provider.name}: ${models.length} model${models.length === 1 ? "" : "s"}${models.length ? ` (${models.slice(0, 5).join(", ")}${models.length > 5 ? ", …" : ""})` : ""}.`,
  );
  const result: InitResult = {
    provider: {
      id: provider.id,
      created,
      models: models.length,
      ...(refreshError ? { refreshError } : {}),
    },
    agents: [],
  };

  // 4. The agents to wire.
  let agents: Agent[];
  try {
    agents = (await client.agents.list()).items;
  } catch (error) {
    if (!(error instanceof HarnessHubError)) throw error;
    note(`Agents cannot be wired by this daemon: ${error.message}`);
    return result;
  }
  const installed = agents.filter(
    (agent) => agent.installation.status !== "not-found",
  );
  let selected: Agent[];
  if (answers.agents !== undefined)
    selected = chosenAgents(agents, answers.agents);
  else if (prompter && installed.length) {
    prompter.note(
      [
        "Agents installed here:",
        ...installed.map(
          (agent, index) =>
            `  ${String(index + 1).padStart(2)}. ${agent.id.padEnd(16)} ${agent.name}${agent.wiring?.model ? ` (now ${agent.wiring.model})` : ""}`,
        ),
      ].join("\n"),
    );
    selected = await until(
      prompter,
      "Agents to wire (numbers or ids, comma-separated; Enter for all; none to skip): ",
      (answer) => {
        if (!answer) return installed;
        if (answer === "none") return [];
        const picked: Agent[] = [];
        for (const part of answer
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)) {
          const index = /^\d+$/.test(part) ? Number(part) - 1 : -1;
          const agent =
            installed[index] ?? installed.find((item) => item.id === part);
          if (!agent) {
            prompter.note(`There is no installed agent ${part}.`);
            return undefined;
          }
          if (!picked.includes(agent)) picked.push(agent);
        }
        return picked;
      },
    );
  } else selected = [];
  if (!selected.length) {
    note(
      installed.length
        ? "No agent chosen; wire one later with hh wire <agent> <model>."
        : "No agent is installed here; install one, then run hh wire <agent> <model>.",
    );
    return result;
  }

  // 5. The default model, and Claude Code's tiers.
  let model = answers.model;
  if (model === undefined) {
    if (!prompter)
      throw new UsageError(
        "Give the agents' default model with --model PROVIDER/MODEL",
      );
    if (!models.length)
      throw new UsageError(
        `${provider.name} lists no models; add some with hh provider, then run hh wire`,
      );
    prompter.note(
      [
        "Models:",
        ...models
          .slice(0, 40)
          .map((ref, index) => `  ${String(index + 1).padStart(2)}. ${ref}`),
        ...(models.length > 40
          ? [`  … and ${models.length - 40} more: type one's full name`]
          : []),
      ].join("\n"),
    );
    model = await until(
      prompter,
      `Default model (number or provider/model; Enter for ${models[0]}): `,
      (answer) => {
        if (!answer) return models[0];
        const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
        const found = models[index] ?? models.find((ref) => ref === answer);
        if (!found)
          prompter.note(`${answer} is not one of the provider's models.`);
        return found;
      },
    );
  }
  const tierAgent = selected.find((agent) => agent.capabilities.tiers.length);
  let tiers = answers.tiers;
  if (tiers === undefined && tierAgent && prompter)
    tiers = await until(
      prompter,
      `${tierAgent.name} tiers (${tierAgent.capabilities.tiers.join(", ")}): Enter to use ${model} for every one, or TIER=MODEL, comma-separated: `,
      (answer) => {
        try {
          const given = pairs(answer);
          const wrong = Object.keys(given).filter(
            (tier) =>
              !tierAgent.capabilities.tiers.includes(tier as WiringTier),
          );
          if (wrong.length) {
            prompter.note(
              `${wrong.join(", ")} is not a tier of ${tierAgent.name}.`,
            );
            return undefined;
          }
          return given as Partial<Record<WiringTier, string>>;
        } catch (error) {
          prompter.note(error instanceof Error ? error.message : String(error));
          return undefined;
        }
      },
    );

  // 6. One preview for every agent, then the wiring.
  // An agent already wired to these choices, with a working key and no
  // drift, keeps its wiring: wiring again would only issue a new key.
  const planned: Array<{
    agent: Agent;
    input: AgentWiringInput;
    plan: AgentWiringPlan | undefined;
  }> = [];
  for (const agent of selected) {
    const input: AgentWiringInput = {
      model,
      ...(tiers && Object.keys(tiers).length && agent.capabilities.tiers.length
        ? { tiers }
        : {}),
    };
    planned.push({
      agent,
      input,
      plan: sameWiring(agent, input)
        ? undefined
        : await client.agents.plan(agent.id, input),
    });
  }
  out(
    planned
      .map(({ agent, plan }) =>
        plan?.changed
          ? `${agent.name} (${agent.id}):\n${planText(plan)}`
          : `${agent.name} (${agent.id}): already wired this way`,
      )
      .join("\n"),
  );
  const changing = planned.filter(({ plan }) => plan?.changed);
  if (changing.length && !answers.yes) {
    if (!prompter)
      throw new ConfirmationRequired(
        "Wiring the agents needs confirmation; pass --yes to proceed without a prompt. The provider was added.",
      );
    const answer = await prompter.ask(
      `Write these changes to ${changing.map(({ agent }) => agent.id).join(", ")}? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim()))
      throw new ConfirmationRequired(
        "Cancelled; no agent was changed. The provider stays; wire later with hh wire.",
      );
  }
  for (const { agent, input, plan } of planned) {
    const entry = {
      agent: agent.id,
      model: model!,
      ...(input.tiers ? { tiers: input.tiers } : {}),
    };
    if (!plan?.changed) {
      result.agents.push({ ...entry, outcome: "unchanged" });
      continue;
    }
    try {
      await client.agents.wire(agent.id, { ...input, expect: plan });
      result.agents.push({ ...entry, outcome: "wired" });
    } catch (error) {
      if (!(error instanceof HarnessHubError)) throw error;
      result.agents.push({
        ...entry,
        outcome: "failed",
        error: `${error.code}: ${error.message}`,
      });
    }
  }
  return result;
}

/** Whether `agent` is wired to `input`'s model and tiers, with a working key and no drift. */
function sameWiring(agent: Agent, input: AgentWiringInput): boolean {
  const wiring = agent.wiring;
  const tiers = (value: Partial<Record<string, string>> | undefined) =>
    JSON.stringify(Object.entries(value ?? {}).sort());
  return (
    wiring !== null &&
    wiring.model === input.model &&
    tiers(wiring.tiers) === tiers(input.tiers) &&
    (wiring.keyState === "active" || wiring.keyState === "none") &&
    wiring.drift?.drifted !== true &&
    wiring.driftError === undefined
  );
}

function summary(result: InitResult): string {
  const { provider } = result;
  return [
    `Provider ${provider.id}: ${provider.models} model${provider.models === 1 ? "" : "s"}${provider.created ? "" : " (it was here already)"}${provider.refreshError ? `; refreshing them failed: ${provider.refreshError}` : ""}.`,
    ...result.agents.map((item) =>
      item.outcome === "failed"
        ? `Not wired: ${item.agent}: ${item.error}`
        : `${item.outcome === "wired" ? "Wired" : "Already wired"} ${item.agent} to ${item.model}${
            item.tiers
              ? ` (${Object.entries(item.tiers)
                  .map(([tier, ref]) => `${tier}=${ref}`)
                  .join(", ")})`
              : ""
          }.`,
    ),
    ...(result.agents.some((item) => item.outcome === "wired")
      ? ["Restart running agent sessions to use the new configuration."]
      : []),
    "Next: hh usage shows the calls and tokens, hh console opens the console, hh agents shows the agents.",
  ].join("\n");
}

/**
 * Run `hh init` (`argv` starts with `init`). Exit codes are those of the
 * other commands: 0, 1 when an agent could not be wired, 2 usage (also a
 * missing answer without a terminal), 3 daemon not running, 4 confirmation
 * needed or declined, 5 conflict, 6 authentication, 130 interrupted.
 */
export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(1);
  if (args.includes("--help")) {
    write(USAGE);
    return EXIT.ok;
  }
  let json = args.includes("--json");
  try {
    const { values, positionals } = parse(args, {
      preset: { type: "string" },
      region: { type: "string" },
      plan: { type: "string" },
      base: { type: "string" },
      agents: { type: "string" },
      model: { type: "string" },
      tier: { type: "string", multiple: true },
      "credential-from-stdin": { type: "boolean" },
      "credential-from-env": { type: "string" },
      "credential-from-file": { type: "string" },
    });
    if (positionals.length) throw new UsageError("hh init takes no arguments");
    const ctx = context(values);
    json = ctx.json;
    const prompter = ctx.interactive ? terminalPrompter() : undefined;
    // 1. The daemon.
    let client: HarnessHubClient;
    try {
      client = await ctx.client();
      await client.system.info();
    } catch (error) {
      if (
        error instanceof HarnessHubUnavailableError ||
        error instanceof AdminTokenUnavailableError
      ) {
        process.stderr.write(
          `HarnessHub is not running at ${typeof values.url === "string" ? values.url : DEFAULT_DAEMON_URL} (${error.message}).\nStart it in another terminal with: hh serve\nthen run hh init again (with the same --data-dir, if you gave one).\n`,
        );
        return EXIT.unavailable;
      }
      throw error;
    }
    const agents =
      typeof values.agents === "string"
        ? values.agents === "all" || values.agents === "none"
          ? values.agents
          : values.agents
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
        : undefined;
    const tiers = list(values.tier).length
      ? (pairs(list(values.tier).join(",")) as Partial<
          Record<WiringTier, string>
        >)
      : undefined;
    const answers: InitAnswers = {
      ...(typeof values.preset === "string" ? { preset: values.preset } : {}),
      ...(typeof values.region === "string" ? { region: values.region } : {}),
      ...(typeof values.plan === "string" ? { plan: values.plan } : {}),
      ...(typeof values.base === "string" ? { base: values.base } : {}),
      ...(credentialGiven(values)
        ? { credential: await readSecret(ctx, values, "credential-") }
        : {}),
      ...(agents !== undefined ? { agents } : {}),
      ...(typeof values.model === "string" ? { model: values.model } : {}),
      ...(tiers ? { tiers } : {}),
      yes: ctx.yes,
    };
    const result = await runInit(client, answers, prompter, (text) => {
      if (!ctx.json) write(text);
    });
    write(ctx.json ? JSON.stringify(result, null, 2) : summary(result));
    return result.agents.some((item) => item.outcome === "failed")
      ? EXIT.internal
      : EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return EXIT.usage;
    }
    return report(error, json);
  }
}
