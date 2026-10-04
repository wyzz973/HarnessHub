// SPDX-License-Identifier: MIT
/**
 * The provider presets shipped in this package's `presets/` directory
 * (`<id>.json`, 03-model-plane section 4). They are data, read from disk next
 * to the compiled module; the single-executable build extracts them under its
 * root at the same relative path (tools/sea/build.mjs).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  endpointProblem,
  isProviderConfig,
} from "@harnesshub/core/model-plane-records";
import {
  choosePreset,
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
 * Validate one preset file's content: the JSON Schema, the file name, unique
 * region, plan and Magpie IDs that name existing choices, top-level endpoints
 * equal to the default choice's, and the expansion of every region and plan
 * into a valid provider whose endpoints follow the base-URL convention.
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
  const preset = value;
  if (`${preset.id}.json` !== file) fail(`its id is ${preset.id}`);
  const endpoints = (
    where: string,
    list: Partial<Record<WireProtocol, string>> | undefined,
  ) => {
    for (const [protocol, url] of Object.entries(list ?? {})) {
      const problem = endpointProblem(protocol as WireProtocol, url);
      if (problem) fail(`${where}.${protocol} ${problem}`);
    }
  };
  endpoints("endpoints", preset.endpoints);
  const unique = (kind: string, ids: string[]) => {
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) fail(`${kind} ${duplicate} appears twice`);
  };
  unique(
    "region",
    (preset.regions ?? []).map((region) => region.id),
  );
  unique(
    "plan",
    (preset.plans ?? []).map((plan) => plan.id),
  );
  unique(
    "Magpie ID",
    (preset.magpie ?? []).map((entry) => entry.id),
  );
  unique(
    "header hint",
    (preset.headerHints ?? []).map((hint) => hint.name.toLowerCase()),
  );
  preset.regions?.forEach((region, index) =>
    endpoints(`regions[${index}].endpoints`, region.endpoints),
  );
  preset.plans?.forEach((plan, index) =>
    endpoints(`plans[${index}].endpoints`, plan.endpoints),
  );
  for (const entry of preset.magpie ?? [])
    try {
      choosePreset(preset, entry);
    } catch (error) {
      fail(`Magpie ID ${entry.id}: ${(error as Error).message}`);
    }
  if (
    !isDeepStrictEqual(choosePreset(preset).preset.endpoints, preset.endpoints)
  )
    fail("endpoints differ from those of the first region and plan");
  for (const region of preset.regions ?? [undefined])
    for (const plan of preset.plans ?? [undefined]) {
      const provider = providerFromPreset(preset, {
        ...(region ? { region: region.id } : {}),
        ...(plan ? { plan: plan.id } : {}),
        // The shape stands in for the URL the user supplies.
        ...(preset.userEndpoint ? { endpoints: preset.endpoints } : {}),
        headers: Object.fromEntries(
          (preset.headerHints ?? [])
            .filter((hint) => hint.required)
            .map((hint) => [hint.name, "value"]),
        ),
        now: new Date(0).toISOString(),
      });
      if (!isProviderConfig(provider))
        fail(
          `it does not expand to a valid provider${region ? ` in region ${region.id}` : ""}${plan ? ` on plan ${plan.id}` : ""}`,
        );
    }
  return preset;
}

let cache: ProviderPreset[] | undefined;

/**
 * Every shipped preset, sorted by id. Read and validated once per process;
 * a Magpie ID may name only one preset.
 *
 * @throws Error when a preset file is invalid (a packaging defect).
 */
export function listPresets(): ProviderPreset[] {
  if (!cache) {
    const directory = presetDirectory();
    const presets = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        checkPreset(name, readFileSync(path.join(directory, name), "utf8")),
      )
      // By id, not file name: `stepfun` comes before `stepfun-cn`.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const owners = new Map<string, string>();
    for (const preset of presets)
      for (const id of magpieIds(preset)) {
        const owner = owners.get(id);
        if (owner)
          throw new Error(
            `Provider presets ${owner} and ${preset.id} both claim the Magpie ID ${id}`,
          );
        owners.set(id, preset.id);
      }
    cache = presets;
  }
  return cache;
}

/** The preset with this id, or undefined. */
export function getPreset(id: string): ProviderPreset | undefined {
  return listPresets().find((preset) => preset.id === id);
}

/** The Magpie preset IDs a preset answers to: its `magpie` list, or its own ID. */
function magpieIds(preset: ProviderPreset): string[] {
  return preset.magpie?.map((entry) => entry.id) ?? [preset.id];
}

/**
 * The preset, region and plan a Magpie import link names
 * (`magpie://import?preset=<id>&region=<region>`, yetone/magpie@2e340f7).
 * Magpie has one list of choices per preset where HarnessHub separates
 * regions from plans, so its `region` is looked up among the regions, then
 * among the plans.
 *
 * @returns undefined when no shipped preset answers to the Magpie ID (its
 *   decision-API presets, for example). A region that is neither is
 *   returned as a region, for `choosePreset` to refuse.
 */
export function resolveMagpiePreset(
  magpieId: string,
  region?: string,
): { preset: ProviderPreset; region?: string; plan?: string } | undefined {
  const preset = listPresets().find((item) =>
    magpieIds(item).includes(magpieId),
  );
  if (!preset) return undefined;
  const implied = preset.magpie?.find((entry) => entry.id === magpieId);
  const choice = {
    ...(implied?.region ? { region: implied.region } : {}),
    ...(implied?.plan ? { plan: implied.plan } : {}),
  };
  if (region === undefined) return { preset, ...choice };
  if (
    !preset.regions?.some((item) => item.id === region) &&
    preset.plans?.some((item) => item.id === region)
  )
    return { preset, ...choice, plan: region };
  return { preset, ...choice, region };
}
