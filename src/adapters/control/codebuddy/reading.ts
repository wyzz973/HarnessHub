import type { ContentKind } from "../../../contracts/content.js";
import type { CommandClass, CommandLookup } from "../../../contracts/control.js";
import type { RelayCapabilities } from "../../../contracts/relay.js";
import { hubClearReading, relayCommands, relayDeclaration, type RelayClassify } from "../relay-classify.js";
import { measureBy } from "../relay-turn.js";

/** A command as CodeBuddy Code 2.184 finds one in a prompt (its queue's `isSlashCommand`): a slash first, then a name of letters, digits and dashes. */
const COMMAND = /^\/([a-z][a-z0-9-]*)(?=\s|$)/iu;

/**
 * CodeBuddy Code's reading: the Hub's clear (`/clear`, `/reset`, `/new` alone, no attachment) is the Hub's; a listed command is a command, `/compact`
 * compacting and any other's effect unknown; anything else is words, and before the catalog arrives a command-shaped word may be one.
 */
export function codebuddyReading(text: string, commands: CommandLookup | null, attachments: readonly ContentKind[]): CommandClass {
  const clear = hubClearReading(text, attachments);
  if (clear !== null) return clear;
  const named = COMMAND.exec(text);
  if (named === null) return { kind: "content" };
  const name = named[1]!, args = text.slice(1 + name.length).trim();
  if (commands === null) return { kind: "possible_command", name };
  const listed = commands(name, args);
  if (listed === undefined) return { kind: "content" };
  const effect = listed.effect !== undefined && listed.effect !== "unknown" ? listed.effect : name === "compact" ? "compact" : "unknown";
  return { kind: "command", name, args, effect };
}
export const codebuddyClassify: RelayClassify = (text, catalog, attachments = []) => codebuddyReading(text, catalog === null ? null : relayCommands(catalog), attachments);

/**
 * CodeBuddy Code's relay declaration: one text (packet, a blank line, the user's words); its first reply, thought or tool call is weak live evidence,
 * and a completed turn proves nothing by itself; commands as it reads them; one process per conversation; no native title entry.
 */
export const codebuddyRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "agent_output", successProvesRecorded: false },
  execution: "process",
  commands: { classify: codebuddyClassify },
  placement: { parts: "single", maxInput: null, measure: measureBy("single", "chars", ["file"]) },
  title: "none",
});
