// SPDX-License-Identifier: MIT
/**
 * `hh config`: shows and edits `<configDir>/config.jsonc` (config-file.ts)
 * without a running daemon. `show` and `get` resolve the file, the
 * documented environment variables and the defaults as `hh serve` would
 * without flags; `set` and `unset` edit the file in place, keeping its
 * comments, after checking the result. Changes take effect at the next
 * `hh serve`.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { HubError } from "@harnesshub/core/errors";
import {
  checkConfigPath,
  defaultConfigDir,
  editConfigFile,
  formatSource,
  formatValue,
  readConfigFile,
  resolveConfig,
  runtimeSettings,
  type ConfigEntry,
} from "./config-file.js";

const USAGE = `Usage:
  hh config show [--json]          every setting, its value and where it comes
                                   from, and where the runtime settings live
  hh config get <path> [--json]    one setting (or a group, such as server)
  hh config set <path> <value>     set it in config.jsonc; the value is JSON or text
  hh config unset <path>           remove it from config.jsonc

Paths are dot-separated: server.port, catalog.url, gateway.limits.idleTimeoutMs.
Values come from a flag of hh serve, then an environment variable, then
config.jsonc, then the default. Changes take effect at the next hh serve.
Common options: --config-dir DIR (default: the platform's HarnessHub config
directory), --json.`;

class UsageError extends Error {}

function write(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** The value at `dotted` of the resolved entries: a setting, a key inside one, or a group. */
function lookup(entries: ConfigEntry[], dotted: string): unknown {
  const exact = entries.find((entry) => entry.path === dotted);
  if (exact) return exact.value;
  const owner = entries.find((entry) => dotted.startsWith(`${entry.path}.`));
  if (owner) {
    let current = owner.value;
    for (const key of dotted.slice(owner.path.length + 1).split("."))
      current =
        typeof current === "object" && current !== null
          ? (current as Record<string, unknown>)[key]
          : undefined;
    return current;
  }
  const group: Record<string, unknown> = {};
  for (const entry of entries)
    if (entry.path.startsWith(`${dotted}.`) && entry.value !== undefined)
      group[entry.path.slice(dotted.length + 1)] = entry.value;
  return group;
}

/** A value given on the command line: JSON when it parses, else the text itself. */
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * Runs `hh config <command>` (`argv` starts with `config`). Exit codes: 0,
 * 1 internal, 2 usage or an invalid configuration.
 */
export async function main(argv: string[]): Promise<number> {
  const [, command, ...rest] = argv;
  if (
    command === undefined ||
    command === "--help" ||
    rest.includes("--help")
  ) {
    write(USAGE);
    return command === undefined ? 2 : 0;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        "config-dir": { type: "string" },
      },
    });
    const configDir = path.resolve(values["config-dir"] ?? defaultConfigDir());
    const resolve = async () =>
      resolveConfig({
        config: await readConfigFile(configDir),
        env: process.env,
      });
    switch (command) {
      case "show": {
        if (positionals.length) throw new UsageError("show takes no arguments");
        const config = await resolve();
        const runtime = runtimeSettings(config);
        if (values.json)
          write(
            JSON.stringify(
              {
                file: config.file,
                settings: config.entries.map((entry) => ({
                  path: entry.path,
                  value: entry.value,
                  source: entry.source,
                  description: entry.description,
                })),
                runtime,
              },
              null,
              2,
            ),
          );
        else
          write(
            [
              `File: ${config.file}`,
              table([
                ["SETTING", "VALUE", "SOURCE"],
                ...config.entries.map((entry) => [
                  entry.path,
                  formatValue(entry.value),
                  formatSource(entry.source),
                ]),
              ]),
              "",
              "Runtime settings, changed through the API, the console or the CLI (not hh config):",
              ...runtime.map(
                (setting) =>
                  `  ${setting.name}: ${setting.file} (${setting.command})`,
              ),
            ].join("\n"),
          );
        return 0;
      }
      case "get": {
        if (positionals.length !== 1) throw new UsageError("Expected <path>");
        const dotted = positionals[0]!;
        checkConfigPath(dotted);
        const value = lookup((await resolve()).entries, dotted);
        write(
          values.json || typeof value !== "string"
            ? JSON.stringify(value ?? null, null, values.json ? 2 : 0)
            : value,
        );
        return 0;
      }
      case "set":
      case "unset": {
        const expected = command === "set" ? 2 : 1;
        if (positionals.length !== expected)
          throw new UsageError(
            command === "set" ? "Expected <path> <value>" : "Expected <path>",
          );
        const [dotted, text] = positionals as [string, string | undefined];
        const updated = await editConfigFile(
          configDir,
          dotted,
          text === undefined ? undefined : parseValue(text),
        );
        write(
          `${command === "set" ? "Set" : "Removed"} ${dotted} in ${updated.file}; restart hh serve to use it.`,
        );
        return 0;
      }
      default:
        throw new UsageError(`Unknown config command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof TypeError) {
      process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (error instanceof HubError) {
      process.stderr.write(`Error: ${error.message} (${error.code})\n`);
      return error.code.startsWith("CONFIG_") ? 2 : 1;
    }
    throw error;
  }
}
