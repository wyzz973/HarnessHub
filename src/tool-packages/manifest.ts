import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { HubError } from "../domain/errors.js";
import { isRelativeFilePath } from "../domain/files.js";
import type {
  ToolPackageInspection,
  ToolPackageManifest,
  ToolPackageMcp,
  ToolPackageStdioMcp,
} from "./types.js";

export const MANIFEST_NAME = "tool-package.json";
export const limits = Object.freeze({
  manifestBytes: 4 * 1024 * 1024,
  files: 10_000,
  fileBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
});
const text = { type: "string", minLength: 1, maxLength: 8192 };
const relative = { type: "string", minLength: 1, maxLength: 1024 };
/** RFC 9110 token characters; also used for secret slot keys of remote headers. */
const HEADER_NAME = "^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]{0,63}$";
/** Environment names that would override process control or HarnessHub itself. */
export const FORBIDDEN_ENVIRONMENT =
  /^(?:PATH|HOME|USERPROFILE|XDG_.*|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|HARNESSHUB_.*)$/;
/** Names whose values must be secret references in manifests and engine configuration. */
export const SECRET_FIELD_NAME =
  /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE/i;
/** Values that are recognizably credentials even under an ordinary name. */
export const SECRET_VALUE = /\b(?:sk-|ghp_|Bearer )[a-zA-Z0-9_-]{12,}/;
/** Local binding slot names referenced by secretEnv/secretHeaders. */
export const SLOT_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const strings = {
  type: "object",
  maxProperties: 32,
  additionalProperties: text,
  propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
};
const argument = {
  anyOf: [
    text,
    {
      type: "object",
      additionalProperties: false,
      required: ["anchor", "path"],
      properties: { anchor: { const: "package" }, path: relative },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["anchor"],
      properties: { anchor: { const: "workspace" } },
    },
  ],
};
const launchable = {
  type: "object",
  additionalProperties: false,
  required: ["name", "launch", "entry"],
  properties: {
    name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$" },
    launch: { enum: ["node", "native"] },
    entry: relative,
    args: { type: "array", maxItems: 128, items: argument },
  },
};
const headers = {
  type: "object",
  maxProperties: 32,
  additionalProperties: text,
  propertyNames: { pattern: HEADER_NAME },
};
const slots = {
  type: "object",
  maxProperties: 32,
  additionalProperties: { type: "string" },
  propertyNames: { pattern: HEADER_NAME },
};
const remote = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type", "url"],
  properties: {
    name: launchable.properties.name,
    type: { enum: ["http", "sse"] },
    url: text,
    headers,
    secretHeaders: slots,
  },
};
const validate = new Ajv({ allErrors: true }).compile<ToolPackageManifest>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "version", "displayName", "files"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
    version: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" },
    displayName: { type: "string", minLength: 1, maxLength: 128 },
    files: {
      type: "array",
      maxItems: limits.files,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "size", "sha256"],
        properties: {
          path: relative,
          size: { type: "integer", minimum: 0, maximum: limits.fileBytes },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          executable: { type: "boolean" },
        },
      },
    },
    skills: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: relative },
      },
    },
    mcpServers: {
      type: "array",
      maxItems: 16,
      items: {
        anyOf: [
          {
            ...launchable,
            properties: {
              ...launchable.properties,
              env: strings,
              secretEnv: strings,
            },
          },
          remote,
        ],
      },
    },
    cliTools: {
      type: "array",
      maxItems: 16,
      items: {
        ...launchable,
        properties: {
          ...launchable.properties,
          description: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
    defaultSecretBindings: {
      type: "object",
      maxProperties: 64,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { const: "env" },
          value: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
        },
      },
    },
  },
});

export function packageError(code: string, message: string): HubError {
  return new HubError(
    code,
    message,
    code === "TOOL_PACKAGE_NOT_FOUND" ? 404 : 400,
  );
}
export function portableKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}
export function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Stable key ordering defines package identity independently of JSON whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Validates declarations only. No package code, credentials or host paths are evaluated. */
export function parseManifest(input: unknown): ToolPackageInspection {
  if (!validate(input))
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "Expected a supported tool-package.json schemaVersion 1 manifest",
    );
  const manifest = structuredClone(input);
  const names = new Set<string>();
  const spellings = new Map<string, string>();
  const directoryNames = new Set<string>();
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  let totalBytes = 0;
  for (const file of manifest.files) {
    const key = portableKey(file.path);
    if (
      !isRelativeFilePath(file.path) ||
      file.path.split("/").length > 64 ||
      key === MANIFEST_NAME ||
      key.startsWith(`${MANIFEST_NAME}/`) ||
      names.has(key)
    )
      throw packageError(
        "INVALID_TOOL_PACKAGE_PATH",
        "File paths must be unique portable relative paths outside the manifest, at most 64 levels deep",
      );
    const parts = file.path.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const spelling = parts.slice(0, count).join("/");
      const portable = portableKey(spelling);
      if (spellings.has(portable) && spellings.get(portable) !== spelling)
        throw packageError(
          "INVALID_TOOL_PACKAGE_PATH",
          "Portable paths cannot contain case or Unicode aliases",
        );
      spellings.set(portable, spelling);
      if (count < parts.length) {
        directoryNames.add(portable);
        if (directoryNames.size > 20_000)
          throw packageError(
            "TOOL_PACKAGE_TOO_LARGE",
            "Package exceeds 20,000 directories",
          );
      }
    }
    names.add(key);
    totalBytes += file.size;
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let count = 1; count < parts.length; count++)
      if (names.has(parts.slice(0, count).join("/")))
        throw packageError(
          "INVALID_TOOL_PACKAGE_PATH",
          "A file cannot also be a directory",
        );
  }
  if (totalBytes > limits.totalBytes)
    throw packageError(
      "TOOL_PACKAGE_TOO_LARGE",
      "Package payload exceeds 256 MiB",
    );
  if (!(
    manifest.skills?.length ||
    manifest.mcpServers?.length ||
    manifest.cliTools?.length
  ))
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "A package must provide Skills, MCP servers or CLI tools",
    );
  const skills = manifest.skills ?? [];
  if (
    new Set(skills.map((skill) => portableKey(skill.path))).size !==
    skills.length
  )
    throw packageError("INVALID_TOOL_PACKAGE", "Skill paths must be unique");
  let skillBytes = 0;
  for (const skill of skills) {
    const file = files.get(skill.path);
    if (
      !file ||
      skill.path.split("/").at(-1) !== "SKILL.md" ||
      file.size > 65536
    )
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        "Each Skill must declare a SKILL.md file no larger than 64 KiB",
      );
    skillBytes += file.size;
  }
  if (skillBytes > 262144)
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "Skill instructions exceed 256 KiB combined",
    );
  const servers = manifest.mcpServers ?? [];
  if (
    new Set(servers.map((server) => portableKey(server.name))).size !==
    servers.length
  )
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "MCP server names must be unique",
    );
  const cliTools = manifest.cliTools ?? [];
  if (
    new Set(cliTools.map((tool) => portableKey(tool.name))).size !==
    cliTools.length
  )
    throw packageError("INVALID_TOOL_PACKAGE", "CLI tool names must be unique");
  if (!manifest.files.length && (skills.length || cliTools.length))
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "Only packages that declare remote MCP endpoints alone may omit files",
    );
  const validateLaunchable = (
    item: { launch: "node" | "native"; entry: string; args?: unknown[] },
    kind: "MCP" | "CLI",
  ) => {
    const entry = files.get(item.entry);
    if (!entry || (item.launch === "native" && !entry.executable))
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        `${kind} entry must be a declared file; native entries require executable:true`,
      );
    if (item.launch === "node" && (item.args?.length ?? 0) > 127)
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        `Node ${kind} entries allow 127 additional arguments`,
      );
    for (const raw of item.args ?? []) {
      const argument = raw as
        string | { anchor: "package"; path: string } | { anchor: "workspace" };
      if (typeof argument === "string") {
        if (
          argument.includes("\0") ||
          /^(?:--?(?:api-key|token|password|secret)|[A-Z_]*(?:KEY|TOKEN|SECRET)=)/i.test(
            argument,
          )
        )
          throw packageError(
            "INVALID_TOOL_PACKAGE",
            `${kind} credentials cannot be embedded in fixed arguments`,
          );
      } else if (
        argument.anchor === "package" &&
        (!isRelativeFilePath(argument.path) ||
          (!files.has(argument.path) &&
            !manifest.files.some((file) =>
              file.path.startsWith(`${argument.path}/`),
            )))
      )
        throw packageError(
          "INVALID_TOOL_PACKAGE_PATH",
          "Package arguments must refer to declared files or their directories",
        );
    }
  };
  const slotNames = new Set<string>();
  for (const server of servers) {
    if (!isStdioMcp(server)) {
      validateRemote(server);
      for (const slot of Object.values(server.secretHeaders ?? {}))
        slotNames.add(slot);
      continue;
    }
    validateLaunchable(server, "MCP");
    for (const [name, value] of Object.entries(server.env ?? {}))
      if (
        FORBIDDEN_ENVIRONMENT.test(name) ||
        SECRET_FIELD_NAME.test(name) ||
        value.includes("\0") ||
        SECRET_VALUE.test(value) ||
        server.secretEnv?.[name]
      )
        throw packageError(
          "INVALID_TOOL_PACKAGE",
          "Ordinary environment fields cannot contain secrets or process-control overrides",
        );
    for (const [name, slot] of Object.entries(server.secretEnv ?? {})) {
      if (FORBIDDEN_ENVIRONMENT.test(name) || !SLOT_NAME.test(slot))
        throw packageError(
          "INVALID_TOOL_PACKAGE",
          "Secret environment fields must name explicit local binding slots",
        );
      slotNames.add(slot);
    }
  }
  for (const tool of cliTools) validateLaunchable(tool, "CLI");
  for (const slot of Object.keys(manifest.defaultSecretBindings ?? {}))
    if (!slotNames.has(slot))
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        "Default secret bindings may only name slots declared by secretEnv or secretHeaders",
      );
  manifest.files.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    manifest,
    digest: hash(canonicalJson(manifest)),
    fileCount: manifest.files.length,
    totalBytes,
  };
}

/** Narrows a manifest MCP declaration to a package-launched stdio server. */
export function isStdioMcp(
  server: ToolPackageMcp,
): server is ToolPackageStdioMcp {
  return "launch" in server;
}

/** Mirrors the engine configuration URL rule so invalid endpoints fail at install time. */
export function remoteUrlProblem(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "MCP URL must be an absolute HTTP(S) URL";
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return "MCP URL must use HTTP(S), without credentials, query or fragment";
  return undefined;
}

function validateRemote(server: Exclude<ToolPackageMcp, ToolPackageStdioMcp>) {
  const problem = remoteUrlProblem(server.url);
  if (problem) throw packageError("INVALID_TOOL_PACKAGE", problem);
  const secret = new Set(
    Object.keys(server.secretHeaders ?? {}).map((name) => name.toLowerCase()),
  );
  for (const [name, value] of Object.entries(server.headers ?? {}))
    if (
      SECRET_FIELD_NAME.test(name) ||
      /[\r\n\0]/.test(value) ||
      SECRET_VALUE.test(value) ||
      secret.has(name.toLowerCase())
    )
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        "Ordinary MCP headers cannot contain credentials; use secretHeaders slots",
      );
  for (const slot of Object.values(server.secretHeaders ?? {}))
    if (!SLOT_NAME.test(slot))
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        "Secret headers must name explicit local binding slots",
      );
}
