import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { HubApplication } from "../application/service.js";
import type { EngineConfiguration } from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import type { EngineProfile } from "../domain/types.js";
import {
  bindInstalled,
  installLocal,
  listInstalled,
} from "../tool-packages/index.js";
import { canonicalJson } from "../tool-packages/manifest.js";

export interface ToolPackageRoutesOptions {
  root: string;
  nodeExecutable: string;
  commandMcpEntry: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HubError("INVALID_REQUEST", "Request body must be an object", 400);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new HubError("INVALID_REQUEST", `${field} must be a non-empty string`, 400);
  return value;
}
function merge<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const result = [...existing];
  for (const item of incoming) {
    const previous = result.find((candidate) => key(candidate) === key(item));
    if (!previous) result.push(item);
    else if (canonicalJson(previous) !== canonicalJson(item))
      throw new HubError(
        "TOOL_PACKAGE_BIND_CONFLICT",
        "An existing Skill or MCP name has different configuration",
        409,
      );
  }
  return result;
}
function registration(profile: EngineProfile): EngineRegistration {
  if (profile.driver === "fake" || !profile.command?.length)
    throw new HubError(
      "ENGINE_CONFIGURATION_UNSUPPORTED",
      "Tool packs require a configured real engine",
      400,
    );
  return {
    id: profile.id,
    driver: profile.driver,
    command: [...profile.command],
    enabled: profile.enabled,
    maxConcurrency: profile.maxConcurrency,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.credentialEnv
      ? { credentialEnv: [...profile.credentialEnv] }
      : {}),
    ...(profile.configuration
      ? { configuration: structuredClone(profile.configuration) }
      : {}),
    ...(profile.cli ? { cli: { ...profile.cli } } : {}),
    ...(profile.acp ? { acp: { ...profile.acp } } : {}),
  };
}

/** One request may install a local pack, bind it to a workspace and publish a new engine revision. */
export function registerToolPackageRoutes(
  server: FastifyInstance,
  app: HubApplication,
  options: ToolPackageRoutesOptions,
) {
  server.get("/v1/tool-packs", async () => ({
    packages: await listInstalled(options.root),
  }));

  server.post("/v1/tool-packs/apply", async (request, reply) => {
    const body = object(request.body);
    const engineId = text(body.engineId, "engineId");
    const workspace = text(body.workspace, "workspace");
    if (!path.isAbsolute(workspace))
      throw new HubError(
        "INVALID_REQUEST",
        "workspace must be an absolute directory",
        400,
      );
    const source =
      body.source === undefined ? undefined : text(body.source, "source");
    const packageInput =
      body.package === undefined ? undefined : object(body.package);
    if ((source ? 1 : 0) + (packageInput ? 1 : 0) !== 1)
      throw new HubError(
        "INVALID_REQUEST",
        "Provide exactly one of source or package",
        400,
      );
    let id: string;
    let version: string;
    if (source) {
      if (!path.isAbsolute(source))
        throw new HubError(
          "INVALID_REQUEST",
          "source must be an absolute local Tool Pack directory",
          400,
        );
      const installed = await installLocal(source, options.root);
      id = installed.manifest.id;
      version = installed.manifest.version;
    } else {
      id = text(packageInput!.id, "package.id");
      version = text(packageInput!.version, "package.version");
    }
    const secretBindings =
      body.secretBindings === undefined
        ? undefined
        : object(body.secretBindings);
    const fragment = await bindInstalled(options.root, id, version, {
      nodeExecutable: options.nodeExecutable,
      commandMcpEntry: options.commandMcpEntry,
      workspace,
      ...(secretBindings ? { secretBindings } : {}),
    });
    const base = registration(app.engineProfile(engineId));
    const configuration: EngineConfiguration = {
      ...base.configuration,
      adapter: base.configuration?.adapter ?? "generic",
      skills: merge(base.configuration?.skills ?? [], fragment.skills, (skill) =>
        process.platform === "win32" ? skill.path.toLowerCase() : skill.path,
      ),
      mcpServers: merge(
        base.configuration?.mcpServers ?? [],
        fragment.mcpServers,
        (mcp) => mcp.name.toLowerCase(),
      ),
    };
    const profile = await app.registerEngine({ ...base, configuration });
    return reply.code(200).send({
      ok: true,
      package: { id, version },
      engineId: profile.id,
      revision: profile.revision,
      capabilities: {
        skills: fragment.skills.map((skill) => skill.path),
        mcp: fragment.mcpServers.map((mcp) => mcp.name),
        cli: fragment.cliTools,
      },
      note: "Existing sessions keep their pinned engine revision; new sessions use this revision.",
    });
  });
}
