// SPDX-License-Identifier: MIT
/**
 * The screens of `hh tui` over the running daemon: the agents with their
 * model choices, a searchable model picker, the plan of a change before it
 * is written, profiles and unwiring. Every read and write is an SDK call
 * that `hh agents`, `hh wire` and `hh profile` also make; the daemon masks
 * Gateway Keys in the plans it returns, and nothing here touches agent
 * files.
 */
import os from "node:os";
import path from "node:path";
import { autoRouteGroup } from "@harnesshub/core/auto-groups";
import {
  parseModelRef,
  type ModelRef,
  type ProviderId,
  type RouteGroupId,
} from "@harnesshub/core/model-plane";
import { groupModels } from "@harnesshub/core/route-groups";
import { ruledCapabilities } from "@harnesshub/core/route-rules";
import {
  HarnessHubError,
  HarnessHubUnavailableError,
  type Agent,
  type AgentWiringInput,
  type AutoGroup,
  type HarnessHubClient,
  type ProviderConfig,
  type ProviderModel,
  type RouteGroup,
  type WiringTier,
} from "@harnesshub/sdk/client";
import { AdminTokenUnavailableError } from "@harnesshub/sdk/local";
import { localTime } from "../admin.js";
import { planText, profileText } from "../agents.js";
import { pad, shorten, width, type Key, type Styles } from "./terminal.js";

type Field =
  | { kind: "model" }
  | { kind: "tier"; tier: WiringTier }
  | { kind: "effort" }
  | { kind: "option"; name: string };

/** One choice of a picker. */
interface Item {
  value: string;
  label: string;
  note: string;
  /** The heading it is listed under: its provider, or route groups. */
  group?: string;
  /** More text the filter matches, such as the provider's name. */
  search: string;
}

interface Picker {
  crumbs: string[];
  items: Item[];
  query: string;
  /** Indexes into `items` that match `query`, in their order. */
  matches: number[];
  /** Index into `matches`. */
  cursor: number;
  empty: string;
  verb: string;
  choose: (item: Item) => Promise<void>;
}

interface Question {
  crumbs: string[];
  lines: string[];
  /** How many lines the last view made of `lines` once long notes were wrapped. */
  shown?: number;
  scroll: number;
  question: string;
  yes: () => Promise<void>;
}

type Mode =
  | { kind: "list" }
  | { kind: "pick"; picker: Picker }
  | { kind: "name"; text: string }
  | { kind: "confirm"; question: Question };

/** What a key press asks of the runner. */
export type KeyResult = "quit" | undefined;

const PAD = "  ";
const SEPARATOR = "  ·  ";
/** Smaller terminals get a notice instead of a screen that cannot fit. */
export const MIN_SIZE = { columns: 30, rows: 8 } as const;

const ATTENTION: Readonly<Record<string, string>> = {
  AGENT_FILES_CHANGED: "files changed",
  AGENT_KEY_INACTIVE: "key inactive",
  AGENT_KEY_NOT_IN_FILES: "key replaced",
  AGENT_MODEL_UNAVAILABLE: "model gone",
};

/**
 * The agent's option values: its wiring's, else the default (the first),
 * with `change` over them.
 */
function optionsOf(
  agent: Agent,
  change: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agent.capabilities.options).map(([name, values]) => [
      name,
      change[name] ?? agent.wiring?.options?.[name] ?? values[0] ?? "",
    ]),
  );
}

/** Whether, with these option values, the agent keeps its own model unless one is named. */
function ownModelAllowed(
  agent: Agent,
  options: Readonly<Record<string, string>>,
): boolean {
  return (agent.capabilities.ownModel ?? []).some((values) =>
    Object.entries(values).every(([name, value]) => options[name] === value),
  );
}

/** Wired without a model of HarnessHub's: it has no tiers or effort to set either. */
function keepsOwnModel(agent: Agent): boolean {
  return agent.wiring !== null && agent.wiring.model === undefined;
}

function fields(agent: Agent): Field[] {
  const own = keepsOwnModel(agent);
  return [
    { kind: "model" },
    ...(own
      ? []
      : agent.capabilities.tiers.map((tier): Field => ({
          kind: "tier",
          tier,
        }))),
    ...(agent.capabilities.efforts.length && !own
      ? [{ kind: "effort" } as const]
      : []),
    ...Object.keys(agent.capabilities.options).map((name): Field => ({
      kind: "option",
      name,
    })),
  ];
}

function label(field: Field): string {
  switch (field.kind) {
    case "model":
      return "model";
    case "tier":
      return field.tier;
    case "effort":
      return "effort";
    case "option":
      return field.name;
  }
}

/** The field's value in the agent's wiring; empty when it has none. */
function value(agent: Agent, field: Field): string {
  const wiring = agent.wiring;
  if (!wiring) return "";
  switch (field.kind) {
    case "model":
      return wiring.model ?? "(its own)";
    case "tier":
      return wiring.tiers?.[field.tier] ?? "";
    case "effort":
      return wiring.effort ?? "";
    case "option":
      return wiring.options?.[field.name] ?? "";
  }
}

/** The field's value to compare a choice with: "" for the agent's own model. */
function chosen(agent: Agent, field: Field): string {
  return field.kind === "model"
    ? (agent.wiring?.model ?? "")
    : value(agent, field);
}

/** What an empty choice of the field means. */
function unset(field: Field): string {
  return field.kind === "tier" ? "(follows model)" : "(not set)";
}

/** What the agents say to do after a write, each once, as the confirmation shows it. */
function afterWriting(notices: ReadonlyArray<string | undefined>): string[] {
  return [
    ...new Set(notices.filter((notice): notice is string => !!notice)),
  ].map((notice) => `After writing: ${notice}`);
}

/** A status line with the agent's notice after it, such as restarting it. */
function withNotice(text: string, notice: string | undefined): string {
  return notice ? `${text} ${notice}` : text;
}

/**
 * Entries an administrator's policy (Claude Code's managed settings) sets
 * over the wiring's, for the status line: each file and its dotted key
 * paths. Read only; nothing here writes those files.
 */
function managedDetail(agent: Agent): string | undefined {
  const managed = agent.wiring?.managed ?? [];
  if (!managed.length) return undefined;
  return `Managed settings win over the wiring: ${managed
    .map((file) =>
      file.keyPaths.length
        ? `${tilde(file.path)} sets ${file.keyPaths.map((keyPath) => keyPath.join(".")).join(", ")}`
        : `${tilde(file.path)} could not be read`,
    )
    .join("; ")}.`;
}

/** Wired, with an active key, no drift and nothing to look at. */
function healthy(agent: Agent): boolean {
  const wiring = agent.wiring;
  return (
    wiring !== null &&
    !wiring.attention &&
    wiring.keyState === "active" &&
    wiring.driftError === undefined &&
    !wiring.drift?.drifted
  );
}

/** A not-found agent that is not wired is folded under the list. */
function folded(agent: Agent): boolean {
  return agent.installation.status === "not-found" && agent.wiring === null;
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(2))}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

function dollars(amount: number): string {
  return `$${Number(amount.toPrecision(3))}`;
}

/** Context window and price per million tokens, as far as they are known. */
function modelNote(contextWindow?: number, price?: ProviderModel["price"]) {
  const parts: string[] = [];
  if (contextWindow !== undefined) parts.push(`${tokens(contextWindow)} ctx`);
  if (price?.input !== undefined && price.output !== undefined)
    parts.push(`${dollars(price.input)} / ${dollars(price.output)} per M`);
  else if (price?.input !== undefined)
    parts.push(`${dollars(price.input)} in per M`);
  return parts.join(" · ");
}

function exposed(provider: ProviderConfig): ProviderModel[] {
  const expose = provider.models.expose;
  return expose === "all"
    ? provider.models.list
    : provider.models.list.filter((model) => expose.includes(model.id));
}

function subsequence(text: string, query: string): boolean {
  let at = 0;
  for (const character of text) if (character === query[at]) at += 1;
  return at === query.length;
}

/** Every word of the query is in the item's text, or runs through its value in order. */
function matches(item: Item, query: string): boolean {
  const text = `${item.label} ${item.search} ${item.note}`.toLowerCase();
  const valueText = item.value.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word) || subsequence(valueText, word));
}

function refilter(picker: Picker): void {
  picker.matches = picker.items
    .map((item, index) => (matches(item, picker.query) ? index : -1))
    .filter((index) => index >= 0);
  picker.cursor = 0;
}

function tilde(file: string): string {
  const home = os.homedir();
  const relative = path.relative(home, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? `~${path.sep}${relative}`
    : file;
}

/** Plain `text` broken at spaces into lines of at most `columns`; a longer word is left to the screen to cut. */
function wrapWords(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next) > columns) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** A plan's notes that are sentences, not file contents: wrapped instead of cut. */
const NOTE = /^(Warning|After writing): /;

/** Status lines at most: a long notice wraps, and a longer one is cut. */
const STATUS_LINES = 3;

/** The hints joined by `·`, wrapped to `columns`. */
function wrap(hints: string[], columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const hint of hints) {
    const next = line ? `${line}${SEPARATOR}${hint}` : hint;
    if (line && width(next) > columns) {
      lines.push(line);
      line = hint;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The agents screen and its pickers. `key` handles one key press (the
 * runner calls it with one key at a time and awaits it), `view` renders the
 * current state for a terminal size, and `changed` is called while a
 * daemon call is running so the runner can draw its progress.
 *
 * A daemon refusal (`HarnessHubError`) or a daemon that stopped answering
 * is shown on the status line and the screen stays; any other error
 * rejects `key`.
 */
export class AgentsScreen {
  #agents: Agent[] = [];
  #providers: ProviderConfig[] = [];
  #groups: RouteGroup[] = [];
  #autoGroups: AutoGroup[] = [];
  #row = 0;
  #column = 0;
  #all = false;
  #mode: Mode = { kind: "list" };
  #flash: { text: string; ok: boolean } | undefined;
  #busy: string | undefined;
  /** Rows the last view gave the scrolled list, for page keys. */
  #page = 10;

  /** A daemon call is running; keys pressed now were typed before its result was shown. */
  get busy(): boolean {
    return this.#busy !== undefined;
  }

  constructor(
    private readonly client: HarnessHubClient,
    private readonly style: Styles,
    private readonly changed: () => void,
  ) {}

  /** Read the agents, providers, route groups and automatic groups; rejects when the daemon fails. */
  async load(): Promise<void> {
    const previous = this.#rows()[this.#row];
    const selected = previous?.id;
    // The cursor stays on its field when the agent's fields change (keeping
    // its own model, Codex has no effort).
    const field = previous && fields(previous)[this.#column];
    const [agents, providers, groups, automatic] = await Promise.all([
      this.client.agents.list(),
      this.client.providers.list(),
      this.client.routeGroups.list(),
      this.client.autoGroups.list(),
    ]);
    this.#agents = agents.items;
    this.#providers = providers.items;
    this.#groups = groups.items;
    this.#autoGroups = automatic.items;
    const rows = this.#rows();
    const at = rows.findIndex((agent) => agent.id === selected);
    this.#row =
      at >= 0 ? at : Math.max(0, Math.min(this.#row, rows.length - 1));
    const agent = rows[this.#row];
    const same = agent
      ? fields(agent).findIndex(
          (candidate) =>
            field !== undefined && label(candidate) === label(field),
        )
      : -1;
    this.#column = agent
      ? same >= 0
        ? same
        : Math.min(this.#column, fields(agent).length - 1)
      : 0;
  }

  async key(key: Key): Promise<KeyResult> {
    this.#flash = undefined;
    switch (this.#mode.kind) {
      case "list":
        return this.#listKey(key);
      case "pick":
        return this.#pickKey(this.#mode.picker, key);
      case "name":
        return this.#nameKey(this.#mode, key);
      case "confirm":
        return this.#confirmKey(this.#mode.question, key);
    }
  }

  #rows(): Agent[] {
    return [
      ...this.#agents.filter((agent) => !folded(agent)),
      ...(this.#all ? this.#agents.filter(folded) : []),
    ];
  }

  #succeed(text: string): void {
    this.#flash = { text, ok: true };
  }

  #fail(text: string): void {
    this.#flash = { text, ok: false };
  }

  /**
   * Run daemon calls with `busy` on the status line. A refusal or an
   * unreachable daemon is shown and yields undefined; other errors reject.
   */
  async #call<T>(
    busy: string,
    work: () => Promise<T>,
  ): Promise<{ value: T } | undefined> {
    this.#busy = busy;
    this.changed();
    try {
      return { value: await work() };
    } catch (error) {
      if (error instanceof HarnessHubError) {
        this.#fail(`${error.message} (${error.code})`);
        return undefined;
      }
      if (
        error instanceof HarnessHubUnavailableError ||
        error instanceof AdminTokenUnavailableError
      ) {
        this.#fail(`${error.message}. Start it with hh serve, then press r.`);
        return undefined;
      }
      throw error;
    } finally {
      this.#busy = undefined;
    }
  }

  async #listKey(key: Key): Promise<KeyResult> {
    const rows = this.#rows();
    const agent = rows[this.#row];
    const count = agent ? fields(agent).length : 1;
    switch (key.name === "char" ? key.text : key.name) {
      case "q":
      case "escape":
        return "quit";
      case "up":
      case "k":
        if (rows.length)
          this.#row = (this.#row + rows.length - 1) % rows.length;
        this.#column = 0;
        return;
      case "down":
      case "j":
        if (rows.length) this.#row = (this.#row + 1) % rows.length;
        this.#column = 0;
        return;
      case "left":
      case "h":
      case "backtab":
        this.#column = (this.#column + count - 1) % count;
        return;
      case "right":
      case "l":
      case "tab":
        this.#column = (this.#column + 1) % count;
        return;
      case "enter":
      case " ":
        if (agent) this.#openField(agent, fields(agent)[this.#column]!);
        return;
      case "s":
        this.#mode = { kind: "name", text: "" };
        return;
      case "p":
        await this.#openProfiles();
        return;
      case "r":
        if (await this.#call("Refreshing…", () => this.load()))
          this.#succeed("Refreshed.");
        return;
      case "u":
        if (agent) this.#askUnwire(agent);
        return;
      case "R":
        if (agent) this.#askRotate(agent);
        return;
      case "f":
        if (this.#agents.some(folded)) {
          const id = agent?.id;
          this.#all = !this.#all;
          const at = this.#rows().findIndex((item) => item.id === id);
          this.#row = Math.max(0, at);
        }
        return;
      default:
        return;
    }
  }

  async #pickKey(picker: Picker, key: Key): Promise<KeyResult> {
    const count = picker.matches.length;
    switch (key.name) {
      case "char":
        picker.query += key.text;
        refilter(picker);
        return;
      case "backspace":
        picker.query = [...picker.query].slice(0, -1).join("");
        refilter(picker);
        return;
      case "clear":
        picker.query = "";
        refilter(picker);
        return;
      case "up":
        if (count) picker.cursor = (picker.cursor + count - 1) % count;
        return;
      case "down":
        if (count) picker.cursor = (picker.cursor + 1) % count;
        return;
      case "pageup":
        picker.cursor = Math.max(0, picker.cursor - this.#page);
        return;
      case "pagedown":
        picker.cursor = Math.max(
          0,
          Math.min(count - 1, picker.cursor + this.#page),
        );
        return;
      case "escape":
        this.#mode = { kind: "list" };
        return;
      case "enter": {
        const item = picker.items[picker.matches[picker.cursor] ?? -1];
        if (item) await picker.choose(item);
        return;
      }
      default:
        return;
    }
  }

  async #nameKey(mode: { text: string }, key: Key): Promise<KeyResult> {
    switch (key.name) {
      case "char":
        mode.text += key.text;
        return;
      case "backspace":
        mode.text = [...mode.text].slice(0, -1).join("");
        return;
      case "clear":
        mode.text = "";
        return;
      case "escape":
        this.#mode = { kind: "list" };
        return;
      case "enter": {
        const name = mode.text.trim();
        if (!name) return;
        this.#mode = { kind: "list" };
        const saved = await this.#call(`Saving profile ${name}…`, () =>
          this.client.profiles.save(name),
        );
        if (saved)
          this.#succeed(
            `Saved profile ${name}: ${Object.keys(saved.value.agents).length} agent(s).`,
          );
        return;
      }
      default:
        return;
    }
  }

  async #confirmKey(question: Question, key: Key): Promise<KeyResult> {
    const most = Math.max(
      0,
      (question.shown ?? question.lines.length) - this.#page,
    );
    switch (key.name === "char" ? key.text.toLowerCase() : key.name) {
      case "y":
        this.#mode = { kind: "list" };
        await question.yes();
        return;
      case "n":
      case "q":
      case "escape":
        this.#mode = { kind: "list" };
        this.#succeed("Cancelled; nothing was changed.");
        return;
      case "up":
        question.scroll = Math.max(0, question.scroll - 1);
        return;
      case "down":
        question.scroll = Math.min(most, question.scroll + 1);
        return;
      case "pageup":
        question.scroll = Math.max(0, question.scroll - this.#page);
        return;
      case "pagedown":
        question.scroll = Math.min(most, question.scroll + this.#page);
        return;
      default:
        return;
    }
  }

  #modelItems(agent: Agent): Item[] {
    const hidden = new Set(agent.wiring?.hidden ?? []);
    const items: Item[] = [];
    for (const provider of this.#providers) {
      const heading =
        provider.name === provider.id
          ? provider.id
          : `${provider.name} (${provider.id})`;
      for (const model of exposed(provider)) {
        const ref = `${provider.id}/${model.id}`;
        items.push({
          value: ref,
          label: ref,
          note: modelNote(model.contextWindow, model.price),
          group: heading,
          search: provider.name,
        });
      }
    }
    const automatic = this.#autoGroups
      .filter((group) => !group.hidden)
      .map(autoRouteGroup);
    for (const [heading, groups] of [
      ["Route groups", this.#groups],
      ["Automatic groups", automatic],
    ] as const)
      for (const group of groups) {
        const { contextWindow, inputModalities } = this.#groupCapabilities(
          group,
          [...this.#groups, ...automatic],
        );
        items.push({
          value: `group/${group.id}`,
          label: `group/${group.id}`,
          note: [
            group.strategy,
            `${group.members.length} ${group.members.length === 1 ? "model" : "models"}`,
            modelNote(contextWindow),
            inputModalities?.includes("image") ? "images" : "",
          ]
            .filter(Boolean)
            .join(" · "),
          group: heading,
          search: group.members.join(" "),
        });
      }
    for (const item of items)
      if (hidden.has(item.value))
        item.note = [item.note, "hidden from this agent"]
          .filter(Boolean)
          .join(" · ");
    return items;
  }

  /**
   * What a group offers as one model, as the gateway lists it: its models
   * (groups in it resolved) and what its rules make reachable.
   */
  #groupCapabilities(group: RouteGroup, groups: readonly RouteGroup[]) {
    const providers = new Map<string, ProviderConfig>(
      this.#providers.map((provider) => [provider.id, provider]),
    );
    const byId = new Map<string, RouteGroup>(
      groups.map((entry) => [entry.id, entry]),
    );
    const metadata = (ref: ModelRef): ProviderModel | undefined => {
      const parsed = parseModelRef(ref);
      if (parsed?.kind !== "model") return undefined;
      return providers
        .get(parsed.provider)
        ?.models.list.find((model) => model.id === parsed.model);
    };
    return ruledCapabilities(
      group,
      groupModels(
        group,
        (id: RouteGroupId) => byId.get(id),
        (provider: ProviderId, model: string) =>
          providers
            .get(provider)
            ?.models.list.some((entry) => entry.id === model) ?? false,
      ),
      metadata,
    );
  }

  #items(agent: Agent, field: Field): Item[] {
    const empty: Item = {
      value: "",
      label: unset(field),
      note: field.kind === "tier" ? "the agent's model" : "the agent's default",
      search: "",
    };
    switch (field.kind) {
      case "model":
        return [
          ...(ownModelAllowed(agent, optionsOf(agent))
            ? [
                {
                  value: "",
                  label: "(its own model)",
                  note: `${agent.name} keeps the model it picks itself`,
                  search: "own",
                },
              ]
            : []),
          ...this.#modelItems(agent),
        ];
      case "tier":
        return [empty, ...this.#modelItems(agent)];
      case "effort":
        return [
          empty,
          ...agent.capabilities.efforts.map((effort) => ({
            value: effort,
            label: effort,
            note: "",
            search: "",
          })),
        ];
      case "option":
        return (agent.capabilities.options[field.name] ?? []).map(
          (option, index) => ({
            value: option,
            label: option,
            note: index === 0 ? "default" : "",
            search: "",
          }),
        );
    }
  }

  #openField(agent: Agent, field: Field): void {
    const current = chosen(agent, field);
    const items = this.#items(agent, field);
    for (const item of items)
      if (item.value === current && agent.wiring)
        item.note = [item.note, "current"].filter(Boolean).join(" · ");
    const picker: Picker = {
      crumbs: [agent.name, label(field)],
      items,
      query: "",
      matches: [],
      cursor: 0,
      empty:
        field.kind === "model" || field.kind === "tier"
          ? "The gateway has no models yet: add a provider with hh provider add or hh init."
          : "Nothing to choose.",
      verb: "choose",
      choose: (item) => this.#change(agent, field, item),
    };
    refilter(picker);
    picker.cursor = Math.max(
      0,
      picker.matches.findIndex((index) => items[index]!.value === current),
    );
    this.#mode = { kind: "pick", picker };
  }

  #input(agent: Agent, field: Field, choice: string): AgentWiringInput {
    switch (field.kind) {
      case "model":
        return { model: choice || null };
      case "tier": {
        const tiers = { ...agent.wiring?.tiers };
        if (choice) tiers[field.tier] = choice;
        else delete tiers[field.tier];
        return { tiers };
      }
      case "effort":
        return {
          effort:
            agent.capabilities.efforts.find((effort) => effort === choice) ??
            null,
        };
      case "option":
        return { options: { [field.name]: choice } };
    }
  }

  /** Plan the change, then ask before writing it. */
  async #change(agent: Agent, field: Field, item: Item): Promise<void> {
    this.#mode = { kind: "list" };
    // Wiring again would only issue a new key; an agent that drifted is wired again to repair it.
    if (healthy(agent) && item.value === chosen(agent, field)) {
      this.#succeed(
        `${agent.name} already has ${label(field)} ${item.label}; nothing to write.`,
      );
      return;
    }
    const input = this.#input(agent, field, item.value);
    // A switch of options to ones that need a model, which the agent does
    // not carry over from keeping its own, asks for the model first.
    if (field.kind === "option") {
      const options = optionsOf(agent, input.options);
      const before = agent.wiring
        ? ownModelAllowed(agent, optionsOf(agent))
        : undefined;
      const needed = !ownModelAllowed(agent, options);
      const carried =
        agent.wiring?.model !== undefined &&
        before === ownModelAllowed(agent, options);
      if (needed && !carried) {
        const picker: Picker = {
          crumbs: [agent.name, `${label(field)} ${item.label}`, "model"],
          items: this.#modelItems(agent),
          query: "",
          matches: [],
          cursor: 0,
          empty:
            "The gateway has no models yet: add a provider with hh provider add or hh init.",
          verb: "choose",
          choose: (model) =>
            this.#plan(
              agent,
              { ...input, model: model.value },
              [agent.name, `${label(field)} ${item.label}`, model.label],
              `${label(field)} ${item.label}, model ${model.label}`,
            ),
        };
        refilter(picker);
        this.#mode = { kind: "pick", picker };
        this.#succeed(
          `${agent.name} needs a model with ${label(field)} ${item.label}: pick one.`,
        );
        return;
      }
    }
    await this.#plan(
      agent,
      input,
      [agent.name, label(field), item.label],
      `${label(field)} ${item.label}`,
    );
  }

  /** Plan `input` for the agent, then ask before writing it; `what` names the change. */
  async #plan(
    agent: Agent,
    input: AgentWiringInput,
    crumbs: string[],
    what: string,
  ): Promise<void> {
    this.#mode = { kind: "list" };
    const planned = await this.#call(`Planning ${agent.name}…`, () =>
      this.client.agents.plan(agent.id, input),
    );
    if (!planned) return;
    const plan = planned.value;
    if (!plan.changed) {
      this.#succeed(`${agent.name} already has ${what}; nothing to write.`);
      return;
    }
    const files = plan.files.filter((file) => file.diff).length;
    this.#mode = {
      kind: "confirm",
      question: {
        crumbs,
        lines: [...planText(plan).split("\n"), ...afterWriting([plan.notice])],
        scroll: 0,
        question: `Write these changes to ${files === 1 ? "the file" : `${files} files`} of ${agent.name}?`,
        yes: async () => {
          const wired = await this.#call(`Writing ${agent.name}…`, async () => {
            const view = await this.client.agents.wire(agent.id, {
              ...input,
              expect: plan,
            });
            await this.load();
            return view;
          });
          if (wired)
            this.#succeed(
              withNotice(`${agent.name}: ${what}.`, wired.value.notice),
            );
        },
      },
    };
  }

  #askRotate(agent: Agent): void {
    const wiring = agent.wiring;
    if (!wiring) {
      this.#fail(`${agent.name} is not wired.`);
      return;
    }
    const first = wiring.keyId === undefined;
    this.#mode = {
      kind: "confirm",
      question: {
        crumbs: [agent.name, first ? "key" : "new key"],
        lines: [
          first
            ? `Issues ${agent.name} its first Gateway Key and writes it into its files; it was wired before it took one, so HarnessHub's models refuse it until then:`
            : `Issues a new Gateway Key for ${agent.name}, writes it into its files and revokes key ${wiring.keyId}:`,
          ...wiring.files.map((file) => `  ${file}`),
          ...afterWriting([agent.notice]),
        ],
        scroll: 0,
        question: first
          ? `Give ${agent.name} a Gateway Key?`
          : `Give ${agent.name} a new key and revoke ${wiring.keyId}?`,
        yes: async () => {
          const rotated = await this.#call(
            `Writing ${agent.name}…`,
            async () => {
              const view = await this.client.agents.rotate(agent.id);
              await this.load();
              return view;
            },
          );
          if (rotated)
            this.#succeed(
              withNotice(
                `${agent.name} has key ${rotated.value.wiring?.keyId ?? "?"}${first ? "" : `; ${wiring.keyId} is revoked`}.`,
                rotated.value.notice,
              ),
            );
        },
      },
    };
  }

  #askUnwire(agent: Agent): void {
    const wiring = agent.wiring;
    if (!wiring) {
      this.#fail(`${agent.name} is not wired.`);
      return;
    }
    this.#mode = {
      kind: "confirm",
      question: {
        crumbs: [agent.name, "unwire"],
        lines: [
          `Restores these files as they were before wiring (${localTime(wiring.wiredAt)}):`,
          ...wiring.files.map((file) => `  ${file}`),
          ...afterWriting([agent.notice]),
        ],
        scroll: 0,
        question: `Unwire ${agent.name}${wiring.keyId ? ` and revoke key ${wiring.keyId}` : ""}?`,
        yes: async () => {
          const result = await this.#call(
            `Unwiring ${agent.name}…`,
            async () => {
              const unwired = await this.client.agents.unwire(agent.id);
              await this.load();
              return unwired;
            },
          );
          if (!result) return;
          const actions = new Map<string, number>();
          for (const file of result.value.files)
            actions.set(file.action, (actions.get(file.action) ?? 0) + 1);
          this.#succeed(
            withNotice(
              `Unwired ${agent.name}: ${[...actions].map(([action, count]) => `${count} ${action}`).join(", ") || "no files"}${wiring.keyId ? `; key ${wiring.keyId} revoked` : ""}.`,
              result.value.agent.notice,
            ),
          );
        },
      },
    };
  }

  async #openProfiles(): Promise<void> {
    const listed = await this.#call("Reading profiles…", () =>
      this.client.profiles.list(),
    );
    if (!listed) return;
    const picker: Picker = {
      crumbs: ["profiles"],
      items: listed.value.items.map((profile) => ({
        value: profile.name,
        label: profile.name,
        note: Object.entries(profile.agents)
          .map(([id, choice]) => `${id} ${choice.model ?? "(its own)"}`)
          .join(" · "),
        search: "",
      })),
      query: "",
      matches: [],
      cursor: 0,
      empty: "No profiles yet: press s in the list to save one.",
      verb: "preview",
      choose: (item) => this.#previewProfile(item.value),
    };
    refilter(picker);
    this.#mode = { kind: "pick", picker };
  }

  async #previewProfile(name: string): Promise<void> {
    this.#mode = { kind: "list" };
    const planned = await this.#call(`Planning profile ${name}…`, () =>
      this.client.profiles.plan(name),
    );
    if (!planned) return;
    const plan = planned.value;
    const changed = plan.agents.filter((agent) => agent.changed);
    if (!changed.length) {
      this.#succeed(`Every agent already matches profile ${name}.`);
      return;
    }
    this.#mode = {
      kind: "confirm",
      question: {
        crumbs: ["profiles", name],
        lines: [
          ...profileText(plan).split("\n"),
          ...afterWriting(changed.map((agent) => agent.plan?.notice)),
        ],
        scroll: 0,
        question: `Switch ${changed.map((agent) => agent.adapterId).join(", ")} to profile ${name}?`,
        yes: async () => {
          const applied = await this.#call(
            `Applying profile ${name}…`,
            async () => {
              const result = await this.client.profiles.apply(name, plan);
              await this.load();
              return result;
            },
          );
          if (!applied) return;
          const switched = applied.value.agents
            .filter((agent) => agent.outcome === "applied")
            .map((agent) => agent.adapterId);
          // The agents' own notices, each once, from the views just reloaded.
          const notices = [
            ...new Set(
              this.#agents
                .filter((agent) => switched.includes(agent.id))
                .flatMap((agent) => (agent.notice ? [agent.notice] : [])),
            ),
          ];
          this.#succeed(
            [
              `Applied profile ${name}: ${switched.join(", ")}.`,
              ...notices,
            ].join(" "),
          );
        },
      },
    };
  }

  /** The screen for a terminal of `columns` by `rows`. */
  view(columns: number, rows: number): string[] {
    if (columns < MIN_SIZE.columns || rows < MIN_SIZE.rows)
      return [
        `Too small: ${columns}x${rows}`,
        `Needs ${MIN_SIZE.columns}x${MIN_SIZE.rows}`,
      ];
    const footer = wrap(this.#hints(), columns - PAD.length).map(
      (line) => PAD + line,
    );
    const bottom = [...this.#statusLines(columns), ...footer];
    const height = Math.max(1, rows - bottom.length - 1);
    const body = this.#body(columns, height).slice(0, height);
    return [
      ...body,
      ...Array.from({ length: rows - bottom.length - body.length }, () => ""),
      ...bottom,
    ];
  }

  #hints(): string[] {
    const s = this.style;
    const hint = (keys: string, what: string) => `${keys} ${s.muted(what)}`;
    switch (this.#mode.kind) {
      case "list":
        return [
          hint("↑↓", "agent"),
          hint("←→", "field"),
          hint("↵", "change"),
          hint("s", "save profile"),
          hint("p", "profiles"),
          hint("r", "refresh"),
          hint("u", "unwire"),
          hint("R", "new key"),
          ...(this.#agents.some(folded)
            ? [hint("f", this.#all ? "fold" : "all agents")]
            : []),
          hint("q", "quit"),
        ];
      case "pick":
        return [
          hint("type", "filter"),
          hint("↑↓", "move"),
          hint("↵", this.#mode.picker.verb),
          hint("esc", "back"),
        ];
      case "name":
        return [hint("↵", "save"), hint("esc", "cancel")];
      case "confirm":
        return [
          hint("y", "yes"),
          hint("n", "no"),
          ...((this.#mode.question.shown ?? this.#mode.question.lines.length) >
          this.#page
            ? [hint("↑↓", "scroll")]
            : []),
        ];
    }
  }

  /** The status: a mark, its text and the text's style. */
  #status(): { mark: string; text: string; style: (text: string) => string } {
    const s = this.style;
    const plain = (text: string) => text;
    if (this.#busy)
      return { mark: "", text: `… ${this.#busy}`, style: s.muted };
    if (this.#flash)
      return this.#flash.ok
        ? { mark: `${s.ok("✓")} `, text: this.#flash.text, style: plain }
        : { mark: `${s.bad("✗")} `, text: this.#flash.text, style: plain };
    if (this.#mode.kind === "confirm")
      return { mark: "", text: this.#mode.question.question, style: s.bold };
    if (this.#mode.kind === "list") {
      const agent = this.#rows()[this.#row];
      const detail = agent && this.#detail(agent);
      if (detail) return { mark: "", text: detail, style: s.bad };
    }
    return { mark: "", text: "", style: plain };
  }

  /** The status wrapped to `columns` in up to {@link STATUS_LINES} lines, so a notice is read whole. */
  #statusLines(columns: number): string[] {
    const { mark, text, style } = this.#status();
    const indent = " ".repeat(width(mark));
    const lines = wrapWords(text, columns - PAD.length - width(mark));
    const kept = lines.slice(0, STATUS_LINES);
    // What does not fit stays on the last line, for the screen to cut.
    if (lines.length > STATUS_LINES)
      kept[STATUS_LINES - 1] = lines.slice(STATUS_LINES - 1).join(" ");
    return (kept.length ? kept : [""]).map(
      (line, index) => `${PAD}${index ? indent : mark}${style(line)}`,
    );
  }

  #header(crumbs: string[]): string {
    const s = this.style;
    return (
      PAD +
      s.accent("◉ HarnessHub") +
      crumbs.map((crumb) => s.muted(" › ") + crumb).join("")
    );
  }

  #body(columns: number, height: number): string[] {
    switch (this.#mode.kind) {
      case "list":
        return this.#listBody(columns, height);
      case "pick":
        return this.#pickBody(this.#mode.picker, columns, height);
      case "name":
        return this.#nameBody(this.#mode.text);
      case "confirm":
        return this.#confirmBody(this.#mode.question, columns, height);
    }
  }

  #state(agent: Agent): string {
    const s = this.style;
    const wiring = agent.wiring;
    if (!wiring)
      return agent.installation.status === "not-found"
        ? s.faint("not installed")
        : s.muted("not wired");
    if (wiring.attention)
      return s.bad(
        `! ${ATTENTION[wiring.attention.code] ?? wiring.attention.code}`,
      );
    if (wiring.keyState === "none") return s.bad("! no key");
    if (wiring.keyState !== "active") return s.bad(`! key ${wiring.keyState}`);
    if (wiring.driftError) return s.bad("? drift unknown");
    if (wiring.drift?.drifted)
      return s.bad(`! drift ${wiring.drift.kinds.join(",")}`);
    if (wiring.managed?.length) return s.bad("! managed");
    return s.ok("✓ wired");
  }

  /** Why the agent needs attention, for the status line. */
  #detail(agent: Agent): string | undefined {
    const wiring = agent.wiring;
    if (!wiring) return undefined;
    if (wiring.attention) return wiring.attention.message;
    if (wiring.keyState === "none")
      return `Wired without a Gateway Key (before ${agent.name} took one), so HarnessHub's models refuse it; R gives it one.`;
    if (wiring.keyState === "suspended")
      return `Its Gateway Key is suspended: hh key resume ${wiring.keyId ?? ""} lets it in again; R issues a new one.`;
    if (wiring.keyState !== "active")
      return `Its Gateway Key is ${wiring.keyState}; R issues a new one.`;
    if (wiring.driftError) return `Drift unknown: ${wiring.driftError}`;
    const [first, ...more] = wiring.drift?.drifted ? wiring.drift.findings : [];
    if (!first) return managedDetail(agent);
    return `Changed since wiring: ${first.path} ${first.keyPath.join(".")} (${first.reason})${more.length ? ` and ${more.length} more` : ""}.`;
  }

  #listBody(columns: number, height: number): string[] {
    const s = this.style;
    const rows = this.#rows();
    const hidden = this.#agents.filter(folded);
    const lines = [this.#header(["agents"]), ""];
    const below = hidden.length && !this.#all ? 2 : rows.length === 0 ? 1 : 0;
    const visible = Math.max(1, height - lines.length - below);
    this.#page = visible;
    const start = Math.max(
      0,
      Math.min(this.#row - visible + 1, rows.length - visible),
    );
    const shown = rows.slice(Math.max(0, start), Math.max(0, start) + visible);
    const nameWidth = Math.max(0, ...rows.map((agent) => width(agent.name)));
    const stateWidth = Math.max(
      0,
      ...rows.map((agent) => width(this.#state(agent))),
    );
    const modelWidth = Math.min(
      40,
      Math.max(
        1,
        ...rows.map((agent) => width(value(agent, { kind: "model" }))),
      ),
    );
    shown.forEach((agent, offset) => {
      const index = Math.max(0, start) + offset;
      const selected = index === this.#row;
      const marker = selected ? s.accent("▸ ") : "  ";
      const name = pad(agent.name, nameWidth);
      let line = `${PAD}${marker}${
        selected ? s.accent(name) : folded(agent) ? s.faint(name) : s.bold(name)
      }  ${pad(this.#state(agent), stateWidth)} `;
      fields(agent).forEach((field, column) => {
        const text = value(agent, field);
        const here = selected && column === this.#column;
        if (field.kind === "tier" && !text && !here) return;
        const shownText = text || "—";
        let cell = here
          ? s.pill(shownText)
          : text
            ? ` ${shownText} `
            : ` ${s.faint(shownText)} `;
        if (field.kind === "model") cell = pad(cell, modelWidth + 2);
        else cell = `${s.muted(label(field))}${cell}`;
        line += ` ${cell}`;
      });
      if (selected) {
        const file =
          agent.wiring?.files[0] ?? agent.installation.configDirectories[0];
        // Right-aligned, cut in the middle when it does not fit.
        const room = columns - width(line) - 4;
        if (file && room >= 12) {
          const where = shorten(tilde(file), room);
          line += " ".repeat(room + 2 - width(where)) + s.faint(where);
        }
      }
      lines.push(line);
    });
    if (rows.length === 0)
      lines.push(PAD + s.muted("  No agent is installed or wired here."));
    if (hidden.length && !this.#all)
      lines.push(
        "",
        `${PAD}  ${s.faint(`${hidden.length} not installed: ${hidden.map((agent) => agent.name).join(", ")}`)}`,
      );
    return lines;
  }

  #pickBody(picker: Picker, columns: number, height: number): string[] {
    const s = this.style;
    const lines = [
      this.#header(picker.crumbs),
      "",
      `${PAD}${s.accent("❯")} ${picker.query}${s.caret()}`,
      "",
    ];
    if (!picker.items.length)
      return [...lines, PAD + "  " + s.muted(picker.empty)];
    if (!picker.matches.length)
      return [...lines, PAD + "  " + s.muted("No match.")];
    const display: Array<{ heading: string } | { match: number }> = [];
    let group: string | undefined;
    picker.matches.forEach((index, match) => {
      const item = picker.items[index]!;
      if (item.group !== undefined && item.group !== group)
        display.push({ heading: item.group });
      group = item.group;
      display.push({ match });
    });
    const visible = Math.max(1, height - lines.length - 1);
    const at = display.findIndex(
      (row) => "match" in row && row.match === picker.cursor,
    );
    const start = at >= visible ? at - visible + 1 : 0;
    const end = Math.min(display.length, start + visible);
    this.#page = Math.max(1, visible - 1);
    const labelWidth = Math.min(
      Math.max(
        ...picker.matches.map((index) => width(picker.items[index]!.label)),
      ),
      Math.max(24, Math.floor(columns / 2)),
    );
    const window = display.slice(start, end);
    for (const row of window) {
      if ("heading" in row) {
        lines.push(`${PAD}  ${s.muted(row.heading)}`);
        continue;
      }
      const item = picker.items[picker.matches[row.match]!]!;
      const selected = row.match === picker.cursor;
      const text = pad(item.label, labelWidth);
      lines.push(
        `${PAD}${selected ? s.accent("▸ ") : "  "}${selected ? s.accent(text) : text}${item.note ? `  ${s.muted(item.note)}` : ""}`,
      );
    }
    if (start > 0 || end < display.length) {
      const shown = window.flatMap((row) =>
        "match" in row ? [row.match] : [],
      );
      lines.push(
        `${PAD}  ${s.faint(`${(shown[0] ?? 0) + 1}–${(shown.at(-1) ?? 0) + 1} of ${picker.matches.length}`)}`,
      );
    }
    return lines;
  }

  #nameBody(text: string): string[] {
    const s = this.style;
    const wired = this.#agents.filter((agent) => agent.wiring);
    const nameWidth = Math.max(0, ...wired.map((agent) => width(agent.name)));
    return [
      this.#header(["save profile"]),
      "",
      `${PAD}${s.accent("❯")} ${text}${s.caret()}`,
      "",
      `${PAD}  ${s.muted(
        wired.length
          ? "Saves the model, tiers, effort and options of every wired agent:"
          : "No agent is wired; the profile would be empty.",
      )}`,
      ...wired.map((agent) => {
        const wiring = agent.wiring!;
        const extra = [
          ...Object.entries(wiring.tiers ?? {}).map(
            ([tier, model]) => `${tier} ${model}`,
          ),
          ...(wiring.effort ? [`effort ${wiring.effort}`] : []),
          ...Object.entries(wiring.options ?? {}).map(
            ([option, choice]) => `${option} ${choice}`,
          ),
        ];
        return `${PAD}    ${pad(agent.name, nameWidth)}  ${wiring.model ?? "(its own)"}${extra.length ? s.muted(`  ${extra.join(" · ")}`) : ""}`;
      }),
    ];
  }

  #confirmBody(question: Question, columns: number, height: number): string[] {
    const s = this.style;
    const lines = [this.#header(question.crumbs), ""];
    const visible = Math.max(1, height - lines.length);
    this.#page = visible;
    // Warnings and notices are sentences: wrapped, where file lines are cut.
    const display = question.lines.flatMap<{
      text: string;
      note: string | undefined;
    }>((text) => {
      const note = NOTE.exec(text)?.[1];
      return note
        ? wrapWords(text, columns - PAD.length - 2).map((line, index) => ({
            text: index ? `  ${line}` : line,
            note,
          }))
        : [{ text, note: undefined }];
    });
    question.shown = display.length;
    const start = Math.min(
      question.scroll,
      Math.max(0, display.length - visible),
    );
    for (const { text, note } of display.slice(start, start + visible)) {
      if (note === "Warning") {
        lines.push(PAD + s.bad(text));
        continue;
      }
      if (note) {
        lines.push(PAD + s.bold(text));
        continue;
      }
      // File names stay visible: paths are cut in the middle.
      const line = /^(Change |Create |--- |\+\+\+ )/.test(text)
        ? shorten(text, columns - PAD.length)
        : text;
      if (/^(Change|Create) /.test(line) || /^[\w-]+:$/.test(line))
        lines.push(PAD + s.bold(line));
      else if (line.startsWith("+") && !line.startsWith("+++"))
        lines.push(PAD + s.added(line));
      else if (line.startsWith("-") && !line.startsWith("---"))
        lines.push(PAD + s.removed(line));
      else lines.push(PAD + s.muted(line));
    }
    return lines;
  }
}
