import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { HubError } from "../domain/errors.js";
import { isRelativeFilePath } from "../domain/files.js";
import type { ToolPackageManifest, ToolPackageInspection } from "./types.js";

export const MANIFEST_NAME = "tool-package.json";
export const limits = Object.freeze({
  manifestBytes: 4 * 1024 * 1024,
  files: 10_000,
  fileBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
});
const text = { type: "string", minLength: 1, maxLength: 8192 };
const relative = { type: "string", minLength: 1, maxLength: 1024 };
const strings = {
  type: "object",
  maxProperties: 32,
  additionalProperties: text,
  propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
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
      minItems: 1,
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
        type: "object",
        additionalProperties: false,
        required: ["name", "launch", "entry"],
        properties: {
          name: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$" },
          launch: { enum: ["node", "native"] },
          entry: relative,
          args: {
            type: "array",
            maxItems: 128,
            items: {
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
            },
          },
          env: strings,
          secretEnv: strings,
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
  if (!(manifest.skills?.length || manifest.mcpServers?.length))
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "A package must provide Skills or MCP servers",
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
  const forbidden =
    /^(?:PATH|HOME|USERPROFILE|XDG_.*|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|HARNESSHUB_.*)$/;
  for (const server of servers) {
    const entry = files.get(server.entry);
    if (!entry || (server.launch === "native" && !entry.executable))
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        "MCP entry must be a declared file; native entries require executable:true",
      );
    if (server.launch === "node" && (server.args?.length ?? 0) > 127)
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        "Node MCP entries allow 127 additional arguments",
      );
    for (const argument of server.args ?? []) {
      if (typeof argument === "string") {
        if (
          argument.includes("\0") ||
          /^(?:--?(?:api-key|token|password|secret)|[A-Z_]*(?:KEY|TOKEN|SECRET)=)/i.test(
            argument,
          )
        )
          throw packageError(
            "INVALID_TOOL_PACKAGE",
            "MCP credentials require explicit secret binding slots",
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
    for (const [name, value] of Object.entries(server.env ?? {}))
      if (
        forbidden.test(name) ||
        /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE/i.test(name) ||
        value.includes("\0") ||
        /\b(?:sk-|ghp_|Bearer )[a-zA-Z0-9_-]{12,}/.test(value) ||
        server.secretEnv?.[name]
      )
        throw packageError(
          "INVALID_TOOL_PACKAGE",
          "Ordinary environment fields cannot contain secrets or process-control overrides",
        );
    for (const [name, slot] of Object.entries(server.secretEnv ?? {}))
      if (forbidden.test(name) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(slot))
        throw packageError(
          "INVALID_TOOL_PACKAGE",
          "Secret environment fields must name explicit local binding slots",
        );
  }
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
