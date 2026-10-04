// SPDX-License-Identifier: MIT
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import { outputLimit, type WiringModel } from "./types.js";

/**
 * Desktop apps that take a model's output limit as the most they offer
 * (ZCode, WorkBuddy) get at most this many: some catalogs report a window
 * there, which the app would offer in full.
 */
const APP_OUTPUT_CAP = 128_000;

/** A model's output limit for a desktop app, or undefined when unknown. */
export function appOutput(model: WiringModel): number | undefined {
  const output = outputLimit(model);
  return output === undefined ? undefined : Math.min(output, APP_OUTPUT_CAP);
}

/** The level an app starts a model at: medium when it has it, else its middle level that thinks. */
export function defaultLevel(levels: readonly string[]): string | undefined {
  if (levels.includes("medium")) return "medium";
  const thinking = levels.filter(
    (level) => level !== "disabled" && level !== "none",
  );
  return thinking[Math.floor(thinking.length / 2)] ?? levels[0];
}

/** Reasoning levels without `none`, which apps express as thinking switched off. */
export function thinkingLevels(
  efforts: readonly ReasoningEffort[],
): ReasoningEffort[] {
  return efforts.filter((effort) => effort !== "none");
}
