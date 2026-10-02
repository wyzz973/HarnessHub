// SPDX-License-Identifier: MIT
/**
 * The provider presets shipped in this package's `presets/` directory
 * (`<id>.json`, 03-model-plane section 4). They are data, read from disk next
 * to the compiled module; the single-executable build extracts them under its
 * root at the same relative path (tools/sea/build.mjs).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  endpointProblem,
  isProviderConfig,
} from "@harnesshub/core/model-plane-records";
import {
  isProviderPreset,
  providerFromPreset,
  type ProviderPreset,
} from "@harnesshub/core/provider-presets";
import type { WireProtocol } from "@harnesshub/core/model-plane";

/** Computed on use: a relocated single-executable module resolves its own root. */
function presetDirectory(): string {
  return fileURLToPath(new URL("../../presets/", import.meta.url));
}

/**
 * Validate one preset file's content: the JSON Schema, the file name, and
 * the expansion into a valid provider whose endpoints follow the base-URL
 * convention.
 *
 * @throws Error naming the file and the first problem.
 */
export function checkPreset(file: string, content: string): ProviderPreset {
  const fail = (reason: string): never => {
    throw new Error(`Provider preset ${file} is invalid: ${reason}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return fail("not JSON");
  }
  if (!isProviderPreset(value))
    return fail(
      (isProviderPreset.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; "),
    );
  if (`${value.id}.json` !== file) fail(`its id is ${value.id}`);
  for (const [protocol, url] of Object.entries(value.endpoints)) {
    const problem = endpointProblem(protocol as WireProtocol, url);
    if (problem) fail(`endpoints.${protocol} ${problem}`);
  }
  if (
    !isProviderConfig(
      providerFromPreset(value, { now: new Date(0).toISOString() }),
    )
  )
    fail("it does not expand to a valid provider");
  return value;
}

let cache: ProviderPreset[] | undefined;

/**
 * Every shipped preset, sorted by id. Read and validated once per process.
 *
 * @throws Error when a preset file is invalid (a packaging defect).
 */
export function listPresets(): ProviderPreset[] {
  if (!cache) {
    const directory = presetDirectory();
    cache = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) =>
        checkPreset(name, readFileSync(path.join(directory, name), "utf8")),
      );
  }
  return cache;
}

/** The preset with this id, or undefined. */
export function getPreset(id: string): ProviderPreset | undefined {
  return listPresets().find((preset) => preset.id === id);
}
