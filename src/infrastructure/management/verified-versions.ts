import { gte, lte, valid } from "semver";
import type { HarnessVersionVerification } from "../../contracts/management.js";

/** Both ends had a recorded real verification; a version that is not semver is compared exactly. */
type VersionRange = readonly [from: string, to: string];
/**
 * The versions of each Harness that HarnessHub ran for real, as the capability matrix records them
 * (`plan/native-capabilities.json`, `installation`): the product's own version and, for an adapter entry, the adapter's
 * (ADR-038). Changed together with the matrix, after a real verification on another version.
 */
export const VERIFIED_VERSIONS: Readonly<Record<string, { readonly program: VersionRange; readonly adapter?: VersionRange }>> = {
  claude: { program: ["2.1.296", "2.1.296"], adapter: ["0.89.1", "0.89.1"] },
  codex: { program: ["0.162.1", "0.162.1"] },
  cursor: { program: ["2026.10.01-e373342", "2026.10.01-e373342"] },
  gemini: { program: ["0.62.0", "0.62.0"] },
  opencode: { program: ["1.18.35", "1.18.35"] },
  pi: { program: ["0.85.1", "0.85.1"] },
  openclaw: { program: ["2026.3.23-2", "2026.3.23-2"] },
  hermes: { program: ["0.12.0", "0.12.0"] },
  dsh: { program: ["0.2.1-alpha.1", "0.2.1-alpha.1"] },
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
