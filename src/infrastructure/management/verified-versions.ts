import { coerce, gte, lte, satisfies, valid, validRange } from "semver";
import type { HarnessVersionVerification } from "../../contracts/management.js";
import type { NativeResumeView } from "../../contracts/web.js";

/** Both ends had a recorded real verification; a version that is not semver is compared exactly. */
export type VersionRange = readonly [from: string, to: string];
/**
 * What HarnessHub ran for real on one Harness (ADR-038): the product's versions and, for an adapter entry, the adapter's.
 * `unofficial` marks a record made on an installation outside the product's official channels (a development directory,
 * a source build): ADR-044 keeps it as historical evidence until a verification through an official channel replaces it
 * (ADR-038, 2026-10-17), and the catalog names the official channel's version in the meantime.
 */
export interface VerifiedVersions { readonly program: VersionRange; readonly adapter?: VersionRange; readonly unofficial?: true }
/**
 * The versions of each Harness that HarnessHub ran for real, as the capability matrix records them
 * (`plan/native-capabilities.json`, `installation`): the product's own version and, for an adapter entry, the adapter's
 * (ADR-038). Changed together with the matrix, after a real verification on another version; `versionConsistency`
 * reconciles it with the matrix, the read tables and the catalog.
 */
export const VERIFIED_VERSIONS: Readonly<Record<string, VerifiedVersions>> = {
  claude: { program: ["2.1.296", "2.1.296"], adapter: ["0.89.1", "0.89.1"] },
  codex: { program: ["0.162.1", "0.162.1"] },
  cursor: { program: ["2026.10.01-e373342", "2026.10.01-e373342"] },
  gemini: { program: ["0.62.0", "0.62.0"] },
  opencode: { program: ["1.18.35", "1.18.35"] },
  pi: { program: ["0.85.1", "0.85.1"], unofficial: true },
  openclaw: { program: ["2026.3.23-2", "2026.3.23-2"] },
  hermes: { program: ["0.12.0", "0.12.0"] },
  dsh: { program: ["0.2.0-rc.2", "0.2.0-rc.2"] },
};
function within(version: string, [from, to]: VersionRange): boolean {
  if (version === from || version === to) return true;
  return valid(version) !== null && valid(from) !== null && valid(to) !== null && gte(version, from) && lte(version, to);
}
function described([from, to]: VersionRange): string { return from === to ? from : from + "–" + to; }
/**
 * Whether a Harness runs a version HarnessHub verified with the real program (ADR-038). Null when nothing was verified for
 * this Harness or its product version is not known, so nothing is claimed. The answer is a hint: it never blocks a Harness.
 */
export function versionVerification(harnessId: string, programVersion: string | null, entryVersion: string | null): HarnessVersionVerification | null {
  if (!Object.hasOwn(VERIFIED_VERSIONS, harnessId) || programVersion === null) return null;
  const verified = VERIFIED_VERSIONS[harnessId]!;
  // An adapter entry in front of the product has its own version; it counts only when it is known and differs.
  const adapter = verified.adapter !== undefined && entryVersion !== null && entryVersion !== programVersion ? entryVersion : null;
  const inside = within(programVersion, verified.program) && (adapter === null || within(adapter, verified.adapter!));
  return { state: inside ? "verified" : "unverified", program: described(verified.program), ...(verified.adapter === undefined ? {} : { adapter: described(verified.adapter) }) };
}
/**
 * Whether an adapter version in front of a product is one HarnessHub verified it with (ADR-038), for the upgrade of the
 * adapter itself; null when no adapter was verified for this Harness or the version is not known.
 */
export function adapterVersionVerification(harnessId: string, adapterVersion: string | null): HarnessVersionVerification | null {
  if (!Object.hasOwn(VERIFIED_VERSIONS, harnessId) || adapterVersion === null) return null;
  const verified = VERIFIED_VERSIONS[harnessId]!; if (verified.adapter === undefined) return null;
  return { state: within(adapterVersion, verified.adapter) ? "verified" : "unverified", program: described(verified.program), adapter: described(verified.adapter) };
}

/** One disagreement `versionConsistency` found among the places that state a Harness's versions. */
export interface VersionInconsistency {
  readonly harnessId: string;
  /**
   * `ids`: the verified versions, the capability matrix and the read tables do not name the same Harnesses, or one of
   * them names a Harness twice. `matrix`: the matrix's installation does not name the verified upper end (or the
   * adapter's). `read-range`: a read table's range is no range, or does not cover an end of the verified program range.
   * `catalog-package`: the version a Harness's own catalog package names is not the verified upper end; for an
   * `unofficial` record, it lies outside the read table's range.
   */
  readonly kind: "ids" | "matrix" | "read-range" | "catalog-package";
  readonly detail: string;
}
/** The places that state a Harness's versions, as their owners give them; `versionConsistency` reads nothing else. */
export interface VersionConsistencyInput {
  readonly verified: Readonly<Record<string, VerifiedVersions>>;
  /** The capability matrix's Harnesses (`plan/native-capabilities.json`), each with the installation its real checks ran on. */
  readonly matrix: readonly { readonly id: string; readonly installation: string }[];
  /** Each read table's `verified` range (`capabilityReadTables`). */
  readonly readTables: readonly { readonly harnessId: string; readonly verified: string }[];
  /** The version a Harness's own catalog package names (`src/adapters/catalog.ts`; no registry adapter), for one that has a package. */
  readonly catalogPackages: readonly { readonly harnessId: string; readonly version: string }[];
}
/**
 * A version as the capability page compares it with a read range (`covered` in the capability scan): without a leading
 * `v` or leading zeros in its numbers, so Cursor's dated versions (2026.10.01-e373342) read as semver; null for none.
 */
function readVersion(version: string): string | null {
  const normalized = version.replace(/^v/u, "").replace(/(^|\.)0+(?=\d)/gu, "$1");
  return valid(normalized) ?? coerce(normalized, { includePrerelease: true })?.version ?? null;
}
/** Whether a read range covers a version, prereleases included: 0.2.1-alpha.1 is inside >=0.2.0-rc.2 <0.3.0, 0.2.0-rc.1 is not. */
function covers(range: string, version: string): boolean {
  const parsed = readVersion(version);
  return parsed !== null && satisfies(parsed, range, { includePrerelease: true });
}
/** Whether `text` names `version` whole, optionally after a `v`: "2.1.296" names 2.1.296 but not 2.1.29. */
function names(text: string, version: string): boolean {
  if (version === "") return false;
  for (let at = text.indexOf(version); at !== -1; at = text.indexOf(version, at + 1)) {
    const start = text[at - 1] === "v" ? at - 1 : at, before = text[start - 1], after = text.slice(at + version.length);
    if ((before === undefined || !/[0-9A-Za-z.+-]/u.test(before)) && !/^(?:[0-9A-Za-z+-]|\.[0-9A-Za-z])/u.test(after)) return true;
  }
  return false;
}
/**
 * What disagrees among the places that state a Harness's versions (ADR-038, 2026-10-21): (a) the verified versions, the
 * capability matrix and the read tables name the same Harnesses, once each; (b) the matrix's installation names the
 * verified upper end, and the adapter's for an adapter entry; (c) each read table's range covers both ends of the
 * verified program range, prereleases included; (d) a Harness's own catalog package names the verified upper end, or,
 * for an `unofficial` record whose version the official channel does not carry, a version inside the read table's range.
 * Pure and total: it reads nothing, throws nothing, and an empty answer means the places agree.
 */
export function versionConsistency(input: VersionConsistencyInput): readonly VersionInconsistency[] {
  const found: VersionInconsistency[] = [];
  const report = (harnessId: string, kind: VersionInconsistency["kind"], detail: string): void => { found.push({ harnessId, kind, detail }); };
  const verifiedOf = (id: string): VerifiedVersions | undefined => Object.hasOwn(input.verified, id) ? input.verified[id] : undefined;
  // (a) The same Harnesses in the three places, each named once.
  const lists: readonly (readonly [place: string, ids: readonly string[]])[] = [["verified versions", Object.keys(input.verified)],
    ["capability matrix", input.matrix.map(item => item.id)], ["read tables", input.readTables.map(table => table.harnessId)]];
  for (const [place, ids] of lists) for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) report(id, "ids", `the ${place} name it more than once`);
  for (const id of new Set(lists.flatMap(([, ids]) => ids))) for (const [place, ids] of lists) if (!ids.includes(id)) report(id, "ids", `missing from the ${place}`);
  // (b) The matrix names the versions its real checks ran on.
  for (const item of input.matrix) {
    const verified = verifiedOf(item.id); if (verified === undefined) continue;
    if (!names(item.installation, verified.program[1])) report(item.id, "matrix", `the installation does not name the verified ${verified.program[1]}: ${item.installation}`);
    if (verified.adapter !== undefined && !names(item.installation, verified.adapter[1])) report(item.id, "matrix", `the installation does not name the verified adapter ${verified.adapter[1]}: ${item.installation}`);
  }
  // (c) A version verified for real is one the capability page reads by checked rules, so the two marks agree.
  const ranges = new Map<string, string>();
  for (const table of input.readTables) {
    const verified = verifiedOf(table.harnessId); if (verified === undefined) continue;
    if (validRange(table.verified, { includePrerelease: true }) === null) { report(table.harnessId, "read-range", `${JSON.stringify(table.verified)} is no range`); continue; }
    if (!ranges.has(table.harnessId)) ranges.set(table.harnessId, table.verified);
    for (const end of new Set(verified.program)) if (!covers(table.verified, end)) report(table.harnessId, "read-range", `${table.verified} does not cover the verified ${end}`);
  }
  // (d) The catalog's own package names the verified version; an unofficial record's, the official channel's, read by checked rules.
  const named = new Set<string>();
  for (const item of input.catalogPackages) {
    if (named.has(item.harnessId)) { report(item.harnessId, "catalog-package", "the catalog names a second package of its own"); continue; }
    named.add(item.harnessId);
    const verified = verifiedOf(item.harnessId);
    if (verified === undefined) report(item.harnessId, "catalog-package", `the catalog names ${item.version} and nothing was verified`);
    else if (verified.unofficial !== true) { if (item.version !== verified.program[1]) report(item.harnessId, "catalog-package", `the catalog names ${item.version}, the verified upper end is ${verified.program[1]}`); }
    else {
      // A missing or invalid range is already reported under (a) or (c).
      const range = ranges.get(item.harnessId);
      if (range !== undefined && !covers(range, item.version)) report(item.harnessId, "catalog-package", `the catalog names ${item.version}, outside the read range ${range} (the verified ${verified.program[1]} is unofficial)`);
    }
  }
  return found;
}

/** The question placeholder of a one-question command; the user replaces it. */
const QUESTION = "\"你的问题\"";
/** What a command may depend on in the conversation's workspace, read without changing it. */
export interface ResumeWorkspace { readonly git: boolean }
type ResumeCommands = { readonly interactive?: (id: string) => string; readonly once: (id: string, workspace: ResumeWorkspace) => string; readonly onceNote?: (workspace: ResumeWorkspace) => string | null };
/**
 * How each Harness's own program continues one of its sessions (ADR-039): the interactive command exactly as the installed
 * version's help gives it, for a program that has one, and the one-question command that a real Turn verified on the
 * version in VERIFIED_VERSIONS. Pi's session reference is a file path, so it is only pointed to; OpenClaw's sessions live
 * in the user's own OpenClaw Gateway, so nothing is shown. Changed together with VERIFIED_VERSIONS and the verification record.
 */
const RESUME_COMMANDS: Readonly<Record<string, ResumeCommands | { readonly list: string } | { readonly hidden: true }>> = {
  claude: { interactive: id => `claude --resume ${id}`, once: id => `claude -p --resume ${id} ${QUESTION}` },
  // `codex exec` refuses a directory outside a Git repository unless told otherwise; the flag bypasses that check, so it is
  // given only where it is needed. `codex resume` has no such flag (its help lists none): it asks about the folder itself.
  codex: { interactive: id => `codex resume ${id}`, once: (id, workspace) => workspace.git ? `codex exec resume ${id} ${QUESTION}` : `codex exec --skip-git-repo-check resume ${id} ${QUESTION}`,
    onceNote: workspace => workspace.git ? null : "工作区不是 git 仓库，Codex 需要这个标志" },
  opencode: { interactive: id => `opencode -s ${id}`, once: id => `opencode run -s ${id} ${QUESTION}` },
  hermes: { interactive: id => `hermes --resume ${id}`, once: id => `hermes chat --resume ${id} -q ${QUESTION}` },
  // DeepSeek Harness has no interactive form to give: the profiles 0.2.0-rc.2 ships are acp, web, headless, sdk and
  // sdk-minimal (dsh-app-boot PROFILE_TEMPLATES), and `dsh tui --resume <session>`, an example in its help, starts a tui
  // profile only a user made; without one dsh stops with "profile "tui" does not exist". The headless form keeps --session-id.
  dsh: { once: id => `dsh headless --session-id ${id} ${QUESTION}` },
  pi: { list: "见 Pi 自己的会话列表" },
  openclaw: { hidden: true },
};
/** Only a plain identifier is shown or put into a command; anything else the program reported stays private. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/**
 * How the user can continue a conversation's native session in the Harness's own program (ADR-039), from its native
 * reference and whether the installed version was verified. Commands are given only for a verified version and a plain
 * identifier, the interactive one only for a program that has one; otherwise the identifier alone, with why. Null for a
 * hidden program and for a reference that is no plain identifier. Nothing here runs a program.
 */
export function nativeResume(harnessId: string, reference: string, verification: HarnessVersionVerification | null, workspace: ResumeWorkspace): NativeResumeView | null {
  const commands = Object.hasOwn(RESUME_COMMANDS, harnessId) ? RESUME_COMMANDS[harnessId]! : null;
  if (commands !== null && "hidden" in commands) return null;
  if (commands !== null && "list" in commands) return { harnessId, list: commands.list };
  if (!PLAIN_ID.test(reference)) return null;
  if (commands === null) return { harnessId, nativeId: reference, note: "not-verified" };
  if (verification?.state !== "verified") return { harnessId, nativeId: reference, note: "version-unverified" };
  const note = commands.onceNote?.(workspace) ?? null;
  return { harnessId, nativeId: reference, ...(commands.interactive === undefined ? {} : { interactive: commands.interactive(reference) }),
    once: commands.once(reference, workspace), ...(note === null ? {} : { onceNote: note }) };
}
