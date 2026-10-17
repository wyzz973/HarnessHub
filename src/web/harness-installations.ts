import { basename } from "node:path";
import type { InstallationCandidate, ObservedInstallations } from "../contexts/catalog/domain/catalog.js";
import { UNMAINTAINED_CHANNELS, type InstallationChannel } from "../contexts/catalog/domain/channels.js";
import type { HarnessView, InstallationView } from "../contracts/web.js";

/**
 * An npm global prefix in the user's terms: Homebrew's Node.js, or the Node.js version a version manager keeps there.
 * The path itself is not returned.
 */
export function prefixLabel(prefix: string, home: string): string {
  if (prefix === "/opt/homebrew" || prefix === "/usr/local") return "Homebrew 的 Node.js";
  const inHome = prefix.startsWith(home + "/") ? prefix.slice(home.length + 1) : null;
  const managers: readonly (readonly [RegExp, string])[] = [
    [/^\.nvm\/versions\/node\/([^/]+)$/u, "nvm"], [/(?:^|\/)fnm\/node-versions\/([^/]+)\/installation$/u, "fnm"],
    [/^\.volta\/tools\/image\/node\/([^/]+)$/u, "Volta"], [/(?:^|\/)mise\/installs\/node\/([^/]+)$/u, "mise"], [/^\.asdf\/installs\/nodejs\/([^/]+)$/u, "asdf"],
  ];
  for (const [pattern, manager] of managers) {
    const version = inHome === null ? undefined : pattern.exec(inHome)?.[1];
    if (version !== undefined) return manager + " " + version;
  }
  return "其他 npm 前缀";
}
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
/** The installations of a Harness for its page: the first of each role in search order is the one this Gateway runs. */
export function installationViews(installation: ObservedInstallations, home: string): readonly InstallationView[] {
  const roles = new Set<string>();
  return installation.candidates.map(candidate => {
    const active = !roles.has(candidate.role);
    roles.add(candidate.role);
    return { channel: candidate.channel?.kind ?? null, label: channelLabel(candidate.channel, home), command: candidate.entries[0]?.name ?? basename(candidate.path),
      version: candidate.version, role: candidate.role, active, maintained: candidate.channel !== null && !UNMAINTAINED_CHANNELS.has(candidate.channel.kind) };
  });
}
/** The first program found under the product's command outside every official channel, without its path; null when none. */
export function unofficialView(installation: ObservedInstallations, product: string | undefined): HarnessView["unofficial"] {
  const named = (candidate: InstallationCandidate) => candidate.entries.some(entry => entry.name === product);
  const found = installation.unofficial.find(named);
  return found === undefined ? null : { command: product!, onPath: found.source === "path", pathDefault: installation.unofficialDefault?.resolvedPath === found.resolvedPath };
}
