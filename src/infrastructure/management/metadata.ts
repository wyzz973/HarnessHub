import { ManagementError, type ManagementMetadataPort, type ManagementRecipe, type ResolvedInstallSpec } from "../../contracts/management.js";
import { catalogTarget } from "../catalog/platform.js";
import { managementSlug } from "../../contexts/management/domain/input.js";

async function metadataJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal, redirect: "error", headers: { Accept: "application/json" } });
  if (!response.ok) { await response.body?.cancel(); throw new ManagementError("METADATA_FAILED", "package metadata request failed"); }
  const reader = response.body?.getReader(); if (!reader) throw new ManagementError("METADATA_FAILED", "package metadata has no body");
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new ManagementError("METADATA_LIMIT", "package metadata exceeded its byte budget"); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("INVALID_METADATA", "package metadata is invalid");
  return value as Record<string, unknown>;
}
function version(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9][0-9A-Za-z.+_-]{0,127}$/u.test(value)) throw new ManagementError("INVALID_METADATA", "package version is invalid"); return value;
}
async function npm(name: string, signal: AbortSignal): Promise<{ version: string; integrity: string | null; engines: Readonly<Record<string, string>> }> {
  const data = await metadataJson("https://registry.npmjs.org/" + encodeURIComponent(name) + "/latest", signal);
  if (data.name !== name) throw new ManagementError("INVALID_METADATA", "package metadata identity changed");
  const distribution = data.dist, engineInput = data.engines;
  const dist = distribution !== null && typeof distribution === "object" && !Array.isArray(distribution) ? distribution as Record<string, unknown> : {};
  const engines: Record<string, string> = {};
  if (engineInput !== undefined) {
    if (engineInput === null || typeof engineInput !== "object" || Array.isArray(engineInput)) throw new ManagementError("INVALID_METADATA", "package engines are invalid");
    for (const [key, value] of Object.entries(engineInput)) { if (typeof value !== "string" || value.length > 512) throw new ManagementError("INVALID_METADATA", "package engines are invalid"); engines[key] = value; }
  }
  return { version: version(data.version), integrity: typeof dist.integrity === "string" && dist.integrity.length < 1024 ? dist.integrity : null, engines };
}
export class OfficialManagementMetadata implements ManagementMetadataPort {
  async resolve(recipe: ManagementRecipe, signal: AbortSignal): Promise<ResolvedInstallSpec> {
    if (recipe.kind === "binary") {
      if (recipe.upstreamId === undefined) throw new ManagementError("UNSUPPORTED_METADATA", "binary recipe has no reviewed upstream metadata identity");
      managementSlug(recipe.upstreamId);
      const data = await metadataJson("https://raw.githubusercontent.com/agentclientprotocol/registry/main/" + recipe.upstreamId + "/agent.json", signal);
      if (data.id !== recipe.upstreamId) throw new ManagementError("INVALID_METADATA", "registry agent identity changed");
      const distribution = data.distribution;
      if (distribution === null || typeof distribution !== "object" || Array.isArray(distribution)) throw new ManagementError("INVALID_METADATA", "registry distribution is invalid");
      const binary = (distribution as Record<string, unknown>).binary;
      if (binary === null || typeof binary !== "object" || Array.isArray(binary)) throw new ManagementError("UNSUPPORTED_DISTRIBUTION", "registry no longer publishes the admitted binary distribution");
      const target = (binary as Record<string, unknown>)[catalogTarget()];
      if (target === null || typeof target !== "object" || Array.isArray(target)) throw new ManagementError("UNSUPPORTED_DISTRIBUTION", "registry does not publish this host target");
      const entry = target as Record<string, unknown>;
      if (Object.keys(entry).some(key => !["archive", "cmd", "args", "env", "sha256"].includes(key)) || typeof entry.archive !== "string" || entry.archive.length > 4096 ||
          typeof entry.cmd !== "string" || entry.cmd.length > 4096 || !entry.cmd || entry.cmd.startsWith("/") || /[\0\r\n\\]/u.test(entry.cmd) || entry.cmd.split("/").includes(".."))
        throw new ManagementError("INVALID_METADATA", "registry binary source or entry is invalid");
      const url = new URL(entry.archive);
      if (url.protocol !== "https:" || url.username || url.password) throw new ManagementError("INVALID_METADATA", "registry artifact must use HTTPS");
      const hash = entry.sha256 === undefined ? null : entry.sha256;
      if (hash !== null && (typeof hash !== "string" || !/^[a-fA-F0-9]{64}$/u.test(hash))) throw new ManagementError("INVALID_METADATA", "registry artifact hash is invalid");
      const args = entry.args === undefined ? [] : entry.args;
      if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== "string" || arg.length > 4096 || /[\0\r\n]/u.test(arg)))
        throw new ManagementError("INVALID_METADATA", "registry arguments are invalid");
      const argumentsList = args.map(arg => { if (typeof arg !== "string") throw new ManagementError("INVALID_METADATA", "registry argument is invalid"); return arg; });
      const env: Record<string, string> = {};
      if (entry.env !== undefined) {
        if (entry.env === null || typeof entry.env !== "object" || Array.isArray(entry.env) || Object.keys(entry.env).length > 32) throw new ManagementError("INVALID_METADATA", "registry environment is invalid");
        for (const [key, value] of Object.entries(entry.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || typeof value !== "string" || value.length > 4096 || /[\0\r\n]/u.test(value)) throw new ManagementError("INVALID_METADATA", "registry environment is invalid");
          Object.defineProperty(env, key, { value, enumerable: true });
        }
      }
      const refreshed = { ...recipe, referenceVersion: version(data.version), archiveUrl: entry.archive, archiveSha256: hash,
        relativeExecutable: entry.cmd, args: argumentsList, env };
      return { recipe: refreshed, version: refreshed.referenceVersion, artifactUrl: entry.archive, integrity: hash, engines: {}, dependencies: [] };
    }
    if (recipe.packageName === null) throw new ManagementError("INVALID_RECIPE", "package management recipe has no package identity");
    if (recipe.kind === "python") {
      const data = await metadataJson("https://pypi.org/pypi/" + encodeURIComponent(recipe.packageName) + "/json", signal), raw = data.info;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ManagementError("INVALID_METADATA", "Python package metadata is invalid");
      const info = raw as Record<string, unknown>;
      return { recipe, version: version(info.version), artifactUrl: null, integrity: null, engines: {}, dependencies: [] };
    }
    const data = await npm(recipe.packageName, signal), dependencies = [];
    for (const dependency of recipe.dependencies) { const entry = await npm(dependency.packageName, signal); dependencies.push({ ...dependency, version: entry.version }); }
    return { recipe, version: data.version, artifactUrl: null, integrity: data.integrity, engines: data.engines, dependencies };
  }
}
