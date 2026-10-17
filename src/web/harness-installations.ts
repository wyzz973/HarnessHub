import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { ClassifiedCandidate, InstallationCandidate, ObservedInstallations } from "../contexts/catalog/domain/catalog.js";
import { prefixLabel, UNMAINTAINED_CHANNELS, type InstallationChannel } from "../contexts/catalog/domain/channels.js";
import { productChannels } from "../adapters/catalog-channels.js";
import type { InstallationObservation, InstallationUpdate, UpgradeKind } from "../contracts/management.js";
import type { HarnessView, InstallationView } from "../contracts/web.js";

export { prefixLabel } from "../contexts/catalog/domain/channels.js";
/** A channel in the user's terms; null is an entry admitted only because development allows unofficial entries. */
export function channelLabel(channel: InstallationChannel | null, home: string): string {
  if (channel === null) return "开发入口（非官网安装）";
  switch (channel.kind) {
    case "npm": return "npm 全局（" + prefixLabel(channel.prefix ?? "", home) + "）";
    case "brew-formula": return "Homebrew";
    case "brew-cask": return "Homebrew Cask";
    case "script": return "官方安装脚本";
    case "uv": return "uv 工具";
    case "pnpm": return "pnpm 全局";
    case "bun": return "bun 全局";
  }
}
/** An installation's reference: stable while its channel, directory and program stay the same; it carries no path. */
export function installationRef(candidate: ClassifiedCandidate): string {
  return createHash("sha256").update((candidate.channel?.kind ?? "entry") + "\0" + (candidate.channel?.root ?? "") + "\0" + candidate.resolvedPath).digest("hex");
}
/** Whether HarnessHub can uninstall an installation: a maintained channel, and for a script a layout whose removal is recorded. */
function removable(harnessId: string, channel: InstallationChannel | null, home: string): boolean {
  if (channel === null || UNMAINTAINED_CHANNELS.has(channel.kind)) return false;
  return channel.kind !== "script" || productChannels(harnessId)?.scripts.some(layout => join(home, layout.root) === channel.root && layout.removal !== null) === true;
}
/**
 * The installations of a Harness for its page: the first of each role in search order is the one this Gateway runs.
 * `upgrade` says how management upgrades one by its reference, and what its last update check found (ADR-044).
 */
export function installationViews(harnessId: string, installation: ObservedInstallations, home: string,
  upgrade: (ref: string) => { readonly kind: UpgradeKind | "terminal" | "maintenance"; readonly update: InstallationUpdate | null } | null = () => null): readonly InstallationView[] {
  const roles = new Set<string>();
  return installation.candidates.map(candidate => {
    const active = !roles.has(candidate.role);
    roles.add(candidate.role);
    const ref = installationRef(candidate), how = candidate.channel === null ? null : upgrade(ref);
    return { ref, channel: candidate.channel?.kind ?? null, label: channelLabel(candidate.channel, home), command: candidate.entries[0]?.name ?? basename(candidate.path),
      version: candidate.version, role: candidate.role, active, maintained: candidate.channel !== null && !UNMAINTAINED_CHANNELS.has(candidate.channel.kind),
      canUninstall: removable(harnessId, candidate.channel, home), upgrade: how?.kind ?? null,
      latest: how?.update ? { version: how.update.latest, source: how.update.source, checkedAt: how.update.checkedAt, error: how.update.error } : null };
  });
}
/**
 * The official installations of one Harness for management (ADR-044), in search order: only those in a channel, since
 * an entry admitted for development has none to maintain. `controlOf` names the control a found command is the entry of.
 */
export function installationObservations(harnessId: string, installation: ObservedInstallations, home: string, controlOf: (command: string) => string): readonly InstallationObservation[] {
  const roles = new Set<string>();
  return installation.candidates.flatMap(candidate => {
    const active = !roles.has(candidate.role); roles.add(candidate.role);
    const channel = candidate.channel; if (channel === null) return [];
    const command = candidate.entries[0]?.name ?? basename(candidate.path);
    return [{ harnessId, controlId: controlOf(command), ref: installationRef(candidate), role: candidate.role, channel: channel.kind, name: channel.name, root: channel.root, prefix: channel.prefix,
      entry: candidate.path, resolvedPath: candidate.resolvedPath, version: candidate.version, active, label: channelLabel(channel, home) }];
  });
}
/** The first program found under the product's command outside every official channel, without its path; null when none. */
export function unofficialView(installation: ObservedInstallations, product: string | undefined): HarnessView["unofficial"] {
  const named = (candidate: InstallationCandidate) => candidate.entries.some(entry => entry.name === product);
  const found = installation.unofficial.find(named);
  return found === undefined ? null : { command: product!, onPath: found.source === "path", pathDefault: installation.unofficialDefault?.resolvedPath === found.resolvedPath };
}
