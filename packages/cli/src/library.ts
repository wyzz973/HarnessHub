// SPDX-License-Identifier: MIT
/**
 * `hh library` (04-agent-plane section 8): keep instruction sets, MCP
 * servers and skills once and sync them into the agents' own files. `sync`
 * shows each agent's diffs, refusals and warnings, asks, and applies the
 * confirmed plan. MCP secrets are given as references (`env:VAR`,
 * `file:PATH`) or read from stdin, never from the command line; the daemon
 * keeps a value only in its secret store and writes it into an agent's
 * file only with --allow-plaintext-secret.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessHubClient,
  LibraryAgent,
  LibraryMcpInput,
  LibraryPlan,
  LibrarySecretInput,
} from "@harnesshub/sdk/client";
import {
  confirm,
  context,
  EXIT,
  list,
  output,
  parse,
  positionals,
  report,
  table,
  UsageError,
  write,
} from "./admin.js";

const AGENTS: readonly LibraryAgent[] = [
  "claude",
  "codex",
  "gemini",
  "qwen",
  "opencode",
  "pi",
  "crush",
  "kimi",
  "hermes",
];

const USAGE = `Usage:
  hh library list [instructions|mcp|skills]   list the Library's items
  hh library show instructions <id> | mcp <name> | skill <name>
  hh library add instructions <id> --file PATH|- [--name NAME] [--agent A]...
  hh library add mcp <name> --command CMD [--arg ARG]... [--env NAME=VALUE]...
          [--secret-env NAME=SOURCE]... [--agent A]...
  hh library add mcp <name> --http URL | --sse URL [--header NAME=VALUE]...
          [--secret-header NAME=SOURCE]... [--agent A]...
  hh library add skill <directory> [--agent A]...
  hh library rm instructions <id> | mcp <name> | skill <name>
  hh library sync [agent]...            show the changes, confirm, write them
          [--allow-plaintext-secret]    write secret values an agent cannot reference
          [--copy]                      copy skills instead of linking them
          [--dry-run]                   only show the changes

Agents: ${AGENTS.join(", ")}; --agent takes several, comma-separated, or all.
An agent gets one instruction set. A secret SOURCE is env:VARIABLE, file:PATH
or stdin (one value read from standard input); the daemon refuses references
to HarnessHub's own credentials (SECRET_REF_FORBIDDEN). add --replace replaces
an item of the same name. sync exits 5 when an item was refused for an agent.
Common options: --url URL, --data-dir DIR, --json, --yes, --non-interactive.`;

/** Some items were refused for an agent; the rest was synced (exit code 5). */
class Refused extends Error {}

function agents(values: unknown): LibraryAgent[] | undefined {
  const given = list(values).flatMap((item) =>
    item
      .split(",")
      .map((agent) => agent.trim())
      .filter(Boolean),
  );
  if (!given.length) return undefined;
  if (given.includes("all")) return [...AGENTS];
  for (const agent of given)
    if (!(AGENTS as readonly string[]).includes(agent))
      throw new UsageError(
        `${agent} is not an agent the Library writes into (${AGENTS.join(", ")})`,
      );
  return [...new Set(given)] as LibraryAgent[];
}

function pairs(values: unknown, flag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of list(values)) {
    const at = item.indexOf("=");
    if (at <= 0) throw new UsageError(`${flag} takes NAME=VALUE, not ${item}`);
    result[item.slice(0, at)] = item.slice(at + 1);
  }
  return result;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Secrets of `--secret-env` or `--secret-header`; at most one is read from stdin overall. */
async function secrets(
  values: unknown,
  flag: string,
  stdin: { used: boolean },
): Promise<Record<string, LibrarySecretInput> | undefined> {
  const result: Record<string, LibrarySecretInput> = {};
  for (const [name, source] of Object.entries(pairs(values, flag))) {
    if (source.startsWith("env:") && source.length > 4)
      result[name] = { kind: "env", value: source.slice(4) };
    else if (source.startsWith("file:") && source.length > 5)
      result[name] = { kind: "file", value: path.resolve(source.slice(5)) };
    else if (source === "stdin") {
      if (stdin.used)
        throw new UsageError("Only one secret can be read from stdin");
      stdin.used = true;
      const value = (await readStdin()).replace(/\r?\n$/, "");
      if (!value) throw new UsageError(`No value for ${name} on stdin`);
      result[name] = { secret: value };
    } else
      throw new UsageError(
        `${flag} ${name} takes env:VARIABLE, file:PATH or stdin; values never go on the command line`,
      );
  }
  return Object.keys(result).length ? result : undefined;
}

function kindOf(word: string | undefined): "instructions" | "mcp" | "skills" {
  if (word === "instructions") return "instructions";
  if (word === "mcp") return "mcp";
  if (word === "skill" || word === "skills") return "skills";
  throw new UsageError(
    word === undefined
      ? "Name a kind: instructions, mcp or skill"
      : `Unknown kind: ${word}; use instructions, mcp or skill`,
  );
}

async function listCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  if (given.length > 1) throw new UsageError("Expected at most one kind");
  const only = given[0] === undefined ? undefined : kindOf(given[0]);
  const client = await ctx.client();
  const [instructions, mcp, skills] = await Promise.all([
    only === undefined || only === "instructions"
      ? client.library.instructions.list()
      : undefined,
    only === undefined || only === "mcp"
      ? client.library.mcp.list()
      : undefined,
    only === undefined || only === "skills"
      ? client.library.skills.list()
      : undefined,
  ]);
  const rows = [
    ...(instructions?.items ?? []).map((item) => [
      "instructions",
      item.id,
      item.agents.join(",") || "-",
      `${item.name} (${item.size} bytes)`,
    ]),
    ...(mcp?.items ?? []).map((item) => [
      "mcp",
      item.name,
      item.agents.join(",") || "-",
      item.transport === "stdio"
        ? `stdio ${[item.command, ...(item.args ?? [])].join(" ")}`
        : `${item.transport} ${item.url}`,
    ]),
    ...(skills?.items ?? []).map((item) => [
      "skill",
      item.name,
      item.agents.join(",") || "-",
      `${item.description.slice(0, 60)} (${item.files} files)`,
    ]),
  ];
  output(
    ctx,
    {
      ...(instructions ? { instructions: instructions.items } : {}),
      ...(mcp ? { mcp: mcp.items } : {}),
      ...(skills ? { skills: skills.items } : {}),
    },
    () => table(["KIND", "NAME", "AGENTS", "DETAIL"], rows),
  );
}

async function showCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  const [word, key] = positionals(given, ["kind", "name"]) as [string, string];
  const client = await ctx.client();
  const kind = kindOf(word);
  if (kind === "instructions") {
    const item = await client.library.instructions.get(key);
    return output(ctx, item, () =>
      [
        `${item.id}: ${item.name}; agents: ${item.agents.join(", ") || "-"}`,
        "",
        item.text ?? "",
      ].join("\n"),
    );
  }
  const item =
    kind === "mcp"
      ? await client.library.mcp.get(key)
      : await client.library.skills.get(key);
  output(ctx, item, () => JSON.stringify(item, null, 2));
}

async function addCommand(args: string[]): Promise<void> {
  const [word, ...rest] = args;
  const kind = kindOf(word);
  const { values, positionals: given } = parse(rest, {
    agent: { type: "string", multiple: true },
    replace: { type: "boolean" },
    file: { type: "string" },
    name: { type: "string" },
    command: { type: "string" },
    arg: { type: "string", multiple: true },
    env: { type: "string", multiple: true },
    "secret-env": { type: "string", multiple: true },
    http: { type: "string" },
    sse: { type: "string" },
    header: { type: "string", multiple: true },
    "secret-header": { type: "string", multiple: true },
  });
  const ctx = context(values);
  const [key] = positionals(given, [
    kind === "skills" ? "directory" : "name",
  ]) as [string];
  const chosen = agents(values.agent);
  const client = await ctx.client();
  if (kind === "instructions") {
    if (typeof values.file !== "string")
      throw new UsageError(
        "Give the Markdown with --file PATH, or --file - for stdin",
      );
    const text =
      values.file === "-"
        ? await readStdin()
        : await readFile(values.file, "utf8");
    const input = {
      ...(typeof values.name === "string" ? { name: values.name } : {}),
      text,
      ...(chosen ? { agents: chosen } : {}),
    };
    const item = values.replace
      ? await client.library.instructions.replace(key, input)
      : await client.library.instructions.create(key, input);
    return output(
      ctx,
      item,
      () =>
        `${values.replace ? "Saved" : "Added"} instruction set ${item.id} for ${item.agents.join(", ") || "no agent yet"}; run hh library sync to write it.`,
    );
  }
  if (kind === "skills") {
    const item = await client.library.skills.import(path.resolve(key), chosen);
    return output(
      ctx,
      item,
      () =>
        `Imported skill ${item.name} (${item.files} files) for ${item.agents.join(", ") || "no agent yet"}; run hh library sync to place it.`,
    );
  }
  const stdin = { used: false };
  const url = values.http ?? values.sse;
  const remote = url !== undefined;
  if (
    [values.command, values.http, values.sse].filter(
      (value) => value !== undefined,
    ).length !== 1
  )
    throw new UsageError(
      "Give one of --command (a stdio server), --http URL or --sse URL",
    );
  const secretEnv = await secrets(values["secret-env"], "--secret-env", stdin);
  const secretHeaders = await secrets(
    values["secret-header"],
    "--secret-header",
    stdin,
  );
  const env = pairs(values.env, "--env");
  const headers = pairs(values.header, "--header");
  const input: LibraryMcpInput = remote
    ? {
        transport: values.sse !== undefined ? "sse" : "http",
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(secretHeaders ? { secretHeaders } : {}),
        ...(chosen ? { agents: chosen } : {}),
      }
    : {
        transport: "stdio",
        command: values.command as string,
        ...(list(values.arg).length ? { args: list(values.arg) } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(secretEnv ? { secretEnv } : {}),
        ...(chosen ? { agents: chosen } : {}),
      };
  if (
    remote &&
    (Object.keys(env).length || secretEnv || list(values.arg).length)
  )
    throw new UsageError("--arg, --env and --secret-env are for stdio servers");
  if (!remote && (Object.keys(headers).length || secretHeaders))
    throw new UsageError(
      "--header and --secret-header are for --http and --sse servers",
    );
  const item = values.replace
    ? await client.library.mcp.replace(key, input)
    : await client.library.mcp.create(key, input);
  output(
    ctx,
    item,
    () =>
      `${values.replace ? "Saved" : "Added"} MCP server ${item.name} for ${item.agents.join(", ") || "no agent yet"}; run hh library sync to write it.`,
  );
}

async function rmCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {});
  const ctx = context(values);
  const [word, key] = positionals(given, ["kind", "name"]) as [string, string];
  const kind = kindOf(word);
  const client = await ctx.client();
  if (kind === "instructions") await client.library.instructions.remove(key);
  else if (kind === "mcp") await client.library.mcp.remove(key);
  else await client.library.skills.remove(key);
  output(
    ctx,
    { deleted: { kind, name: key } },
    () =>
      `Deleted ${kind === "skills" ? "skill" : kind === "mcp" ? "MCP server" : "instruction set"} ${key}; run hh library sync to take it out of the agents.`,
  );
}

function planText(plan: LibraryPlan): string {
  const lines: string[] = [];
  for (const agent of plan.agents) {
    if (!agent.changed && !agent.refused.length && !agent.warnings.length)
      continue;
    lines.push(`${agent.name} (${agent.agent}):`);
    for (const file of agent.files)
      if (file.action !== "unchanged")
        lines.push(
          `  ${file.action === "write" ? (file.exists ? "Change" : "Create") : file.action === "restore" ? "Restore the original of" : "Delete"} ${file.path}`,
          ...file.diff
            .trimEnd()
            .split("\n")
            .filter(Boolean)
            .map((line) => `    ${line}`),
        );
    for (const skill of agent.skills)
      if (skill.action !== "unchanged")
        lines.push(`  ${skill.action} skill ${skill.name}: ${skill.path}`);
    for (const item of agent.refused)
      lines.push(`  refused ${item.kind} ${item.name}: ${item.reason}`);
    for (const warning of agent.warnings) lines.push(`  warning: ${warning}`);
  }
  return lines.length
    ? lines.join("\n")
    : "Every agent is in step with the Library.";
}

async function syncCommand(args: string[]): Promise<void> {
  const { values, positionals: given } = parse(args, {
    "allow-plaintext-secret": { type: "boolean" },
    copy: { type: "boolean" },
    "dry-run": { type: "boolean" },
  });
  const ctx = context(values);
  const chosen = agents(given);
  const input = {
    ...(chosen ? { agents: chosen } : {}),
    ...(values["allow-plaintext-secret"] ? { allowPlaintextSecret: true } : {}),
    ...(values.copy ? { placement: "copy" as const } : {}),
  };
  const client = await ctx.client();
  const plan = await client.library.sync.plan(input);
  const refused = plan.agents.flatMap((agent) =>
    agent.refused.map((item) => `${agent.agent}: ${item.kind} ${item.name}`),
  );
  if (values["dry-run"] || !plan.changed) {
    output(ctx, plan, () => planText(plan));
    if (!values["dry-run"] && refused.length)
      throw new Refused(`Not synced: ${refused.join("; ")}`);
    return;
  }
  if (!ctx.json) write(planText(plan));
  const changed = plan.agents.filter((agent) => agent.changed);
  await confirm(
    ctx,
    `Write these changes to ${changed.map((agent) => agent.agent).join(", ")}?`,
  );
  const applied = await client.library.sync.apply({ ...input, expect: plan });
  output(ctx, applied, () =>
    [
      ...applied.agents
        .filter((agent) => agent.changed)
        .map((agent) => `synced    ${agent.agent}`),
      "Restart running agent sessions to pick up the changes.",
    ].join("\n"),
  );
  if (refused.length) throw new Refused(`Not synced: ${refused.join("; ")}`);
}

const COMMANDS: Readonly<Record<string, (args: string[]) => Promise<void>>> = {
  list: listCommand,
  show: showCommand,
  add: addCommand,
  rm: rmCommand,
  sync: syncCommand,
};

/**
 * Run `hh library` (`argv` starts with `library`). Exit codes are those of
 * the model-plane commands: 0, 1 internal, 2 usage, 3 daemon unavailable,
 * 4 confirmation needed, 5 conflict (a file changed after the preview, or
 * an item refused for an agent while the rest was synced), 6
 * authentication, 7 limit or not ready.
 */
export async function main(argv: string[]): Promise<number> {
  const [, name, ...args] = argv;
  if (name === undefined || name === "--help" || args.includes("--help")) {
    write(USAGE);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    process.stderr.write(`Unknown library command: ${name}\n${USAGE}\n`);
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
    if (error instanceof Refused) {
      process.stderr.write(`${error.message}\n`);
      return EXIT.conflict;
    }
    return report(error, args.includes("--json"));
  }
}
