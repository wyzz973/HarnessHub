import { createHash } from "node:crypto";
import { DiscoveryInputError } from "../../contexts/catalog/domain/discovery.js";
import { validateDefinitions } from "../../contexts/catalog/domain/catalog-parser.js";
import type { CatalogSource, ControlRecipe, HarnessDefinition, PackageIdentity } from "../../contexts/catalog/domain/catalog.js";

const platforms = ["darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64", "windows-aarch64", "windows-x86_64"];
const productIds: Readonly<Record<string, string>> = { "claude-acp": "claude", "codex-acp": "codex", "pi-acp": "pi", "qwen-code": "qwen" };
/** Reviewed local commands, not guesses derived from package names. */
const knownEntries: Readonly<Record<string, readonly string[]>> = {
  auggie: ["auggie"], "claude-acp": ["claude-agent-acp"], cline: ["cline"], "codex-acp": ["codex-acp"],
  "factory-droid": ["droid"], gemini: ["gemini"], "github-copilot-cli": ["copilot"], "grok-build": ["grok"],
  kilo: ["kilo"], "minimax-code": ["mcode"], "pi-acp": ["pi-acp"], qoder: ["qodercli"], "qwen-code": ["qwen"], sigit: ["sigit"],
};
const nativeEntries: Readonly<Record<string, readonly string[]>> = { "claude-acp": ["claude"], "codex-acp": ["codex"], "pi-acp": ["pi"], poolside: ["pool"] };
const configHints: Readonly<Record<string, readonly string[]>> = {
  "claude-acp": [".claude"], "codex-acp": [".codex"], "pi-acp": [".pi/agent"],
  gemini: [".gemini"], "qwen-code": [".qwen"], opencode: [".config/opencode"],
  "github-copilot-cli": [".copilot"], cursor: [".cursor"], goose: [".config/goose"],
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DiscoveryInputError(field + " must be an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new DiscoveryInputError(field + " contains an unknown field");
}
function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/u.test(value)) throw new DiscoveryInputError(field + " must be a bounded string");
  return value;
}
function argumentsAndEnvironment(value: Record<string, unknown>): { readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  const rawArgs: unknown = value.args === undefined ? [] : value.args;
  if (!Array.isArray(rawArgs) || rawArgs.length > 32) throw new DiscoveryInputError("distribution args must be a bounded array");
  const args = rawArgs.map((arg: unknown) => typeof arg === "string" && arg.length <= 4096 && !/[\0\r\n]/u.test(arg) ? arg : (() => { throw new DiscoveryInputError("invalid distribution argument"); })());
  const rawEnv = object(value.env === undefined ? {} : value.env, "distribution.env");
  if (Object.keys(rawEnv).length > 32) throw new DiscoveryInputError("too many distribution environment variables");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || typeof value !== "string" || value.length > 4096 || /[\0\r\n]/u.test(value)) throw new DiscoveryInputError("invalid distribution environment variable");
    Object.defineProperty(env, key, { value, enumerable: true, configurable: true });
  }
  return { args, env };
}

function packageIdentity(spec: string, kind: "npm" | "python", binNames: readonly string[]): PackageIdentity {
  const separator = kind === "python" && spec.includes("==") ? "==" : "@";
  const at = separator === "@" ? spec.lastIndexOf("@") : spec.indexOf(separator);
  if (at <= 0) throw new DiscoveryInputError("registry package must have a fixed version");
  return { kind, name: spec.slice(0, at), version: spec.slice(at + separator.length), binNames };
}

function importAgent(value: unknown, repository: string, revision: string, platform: string): HarnessDefinition {
  const agent = object(value, "registry agent");
  keys(agent, ["id", "name", "version", "description", "repository", "website", "authors", "license", "license_url", "icon", "distribution", "preview"], "registry agent");
  const upstreamId = text(agent.id, "agent.id", 96);
  if (!/^[a-z][a-z0-9-]*$/u.test(upstreamId)) throw new DiscoveryInputError("invalid registry agent id");
  text(agent.version, "agent.version", 128); text(agent.description, "agent.description");
  const source: CatalogSource = { repository, revision, upstreamId, url: "https://github.com/" + repository + "/blob/" + revision + "/" + upstreamId + "/agent.json" };
  const distribution = object(agent.distribution, "agent.distribution");
  keys(distribution, ["binary", "npx", "uvx"], "agent.distribution");
  if (Object.keys(distribution).length === 0) throw new DiscoveryInputError("registry agent requires a distribution");
  const controls: ControlRecipe[] = [];
  const observedNames = new Set<string>(nativeEntries[upstreamId] ?? []);
  if (distribution.binary !== undefined) {
    const targets = object(distribution.binary, "binary targets"); keys(targets, platforms, "binary targets");
    if (Object.keys(targets).length === 0) throw new DiscoveryInputError("binary distribution requires a target");
    for (const [target, raw] of Object.entries(targets)) {
      const metadata = object(raw, "binary target"); keys(metadata, ["archive", "cmd", "args", "env", "sha256"], "binary target");
      const relativeExecutable = text(metadata.cmd, "binary.cmd");
      // Registry Windows archive separators are normalized as path metadata, never shell text.
      const relativePath = relativeExecutable.replaceAll("\\", "/");
      if (relativePath.startsWith("/") || /^[A-Za-z]:/u.test(relativePath) || relativePath.split("/").some((segment) => segment === ".." || segment === "")) throw new DiscoveryInputError("binary cmd must stay inside its archive root");
      const archive = text(metadata.archive, "binary.archive");
      const parsed = new URL(archive);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new DiscoveryInputError("archive must be an HTTPS URL");
      const sha256 = metadata.sha256 === undefined ? undefined : text(metadata.sha256, "binary.sha256", 64);
      if (sha256 !== undefined && !/^[a-fA-F0-9]{64}$/u.test(sha256)) throw new DiscoveryInputError("invalid archive hash");
      const launch = argumentsAndEnvironment(metadata);
      if (target === platform) {
        const basename = relativePath.split("/").at(-1);
        if (basename === undefined) throw new DiscoveryInputError("missing binary basename");
        const executableNames = [...new Set([...(nativeEntries[upstreamId] ?? []), basename])];
        executableNames.forEach((name) => observedNames.add(name));
        controls.push({ id: upstreamId + "-binary", protocol: "acp-v1", executableNames, ...launch, package: null,
          distribution: { kind: "binary", archive, relativeExecutable: relativePath, ...(sha256 === undefined ? {} : { sha256 }) }, requiredExecutables: [], source });
      }
    }
  }
  for (const [field, kind] of [["npx", "npm"], ["uvx", "python"]] as const) {
    if (distribution[field] === undefined) continue;
    const metadata = object(distribution[field], field + " distribution"); keys(metadata, ["package", "args", "env"], field + " distribution");
    const packageSpec = text(metadata.package, field + ".package", 384);
    const executableNames = knownEntries[upstreamId] ?? [];
    executableNames.forEach((name) => observedNames.add(name));
    controls.push({ id: upstreamId + "-" + kind, protocol: "acp-v1", executableNames, ...argumentsAndEnvironment(metadata),
      package: packageIdentity(packageSpec, kind, executableNames), distribution: { kind, packageSpec }, requiredExecutables: upstreamId === "pi-acp" ? ["pi"] : [], source });
  }
  const productId = productIds[upstreamId] ?? upstreamId;
  return { id: productId, name: text(agent.name, "agent.name", 128), aliases: productId === upstreamId ? [] : [upstreamId], binaryNames: [...observedNames], configHints: configHints[upstreamId] ?? [], controls };
}

/** Import a reviewed, offline stable registry snapshot. Distribution metadata never installs a program. */
export function importRegistry(value: unknown, platform: string): readonly HarnessDefinition[] {
  if (!platforms.includes(platform)) throw new DiscoveryInputError("unsupported registry platform: " + platform);
  const snapshot = object(value, "registry snapshot");
  keys(snapshot, ["schemaVersion", "repository", "revision", "license", "licenseUrl", "reviewedOn", "entries"], "registry snapshot");
  if (snapshot.schemaVersion !== 1) throw new DiscoveryInputError("unsupported registry snapshot version");
  const repository = text(snapshot.repository, "snapshot.repository", 256);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository)) throw new DiscoveryInputError("invalid registry repository");
  const revision = text(snapshot.revision, "snapshot.revision", 40);
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new DiscoveryInputError("registry revision must be a commit SHA");
  text(snapshot.license, "snapshot.license", 128); text(snapshot.licenseUrl, "snapshot.licenseUrl"); text(snapshot.reviewedOn, "snapshot.reviewedOn", 10);
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length > 128) throw new DiscoveryInputError("registry entries must be bounded");
  const upstreamIds = new Set<string>();
  const definitions = snapshot.entries.map((raw: unknown) => {
    const entry = object(raw, "registry entry"); keys(entry, ["path", "sourceSha256", "sha256", "agent"], "registry entry");
    const hash = text(entry.sha256, "entry.sha256", 64); const sourceHash = text(entry.sourceSha256, "entry.sourceSha256", 64);
    if (!/^[a-f0-9]{64}$/u.test(hash) || !/^[a-f0-9]{64}$/u.test(sourceHash)) throw new DiscoveryInputError("invalid registry metadata hash");
    if (createHash("sha256").update(JSON.stringify(entry.agent)).digest("hex") !== hash) throw new DiscoveryInputError("registry metadata hash mismatch");
    const definition = importAgent(entry.agent, repository, revision, platform);
    const upstreamId = definition.controls[0]?.source.upstreamId ?? text(object(entry.agent, "agent").id, "agent.id", 96);
    if (entry.path !== upstreamId + "/agent.json") throw new DiscoveryInputError("registry entry path does not match agent id");
    if (upstreamIds.has(upstreamId)) throw new DiscoveryInputError("duplicate upstream id: " + upstreamId);
    upstreamIds.add(upstreamId);
    return definition;
  });
  validateDefinitions(definitions);
  return definitions;
}
