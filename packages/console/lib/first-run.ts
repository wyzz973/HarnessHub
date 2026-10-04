// SPDX-License-Identifier: MIT
/**
 * The first-run flow of the home page, the browser's `hh init`
 * (packages/cli/src/init.ts): the same steps through the same API, with
 * the same rule for agents already wired the chosen way.
 */
import type {
  Agent,
  AgentWiringInput,
  ProviderConfig,
} from "@harnesshub/sdk/client";

/** The models a provider exposes, as Model Refs. */
export function exposedModels(provider: ProviderConfig): string[] {
  const { models } = provider;
  return models.list
    .filter(
      (model) => models.expose === "all" || models.expose.includes(model.id),
    )
    .map((model) => `${provider.id}/${model.id}`);
}

/**
 * Whether `agent` is wired to `input`'s model and tiers with a working key
 * and no drift: wiring it again would only issue a new key, so it is left
 * alone.
 */
export function sameWiring(agent: Agent, input: AgentWiringInput): boolean {
  const wiring = agent.wiring;
  const tiers = (value: Partial<Record<string, string>> | undefined) =>
    JSON.stringify(Object.entries(value ?? {}).sort());
  return (
    wiring !== null &&
    wiring.model === input.model &&
    tiers(wiring.tiers) === tiers(input.tiers) &&
    (wiring.keyState === "active" || wiring.keyState === "none") &&
    wiring.drift?.drifted !== true &&
    wiring.driftError === undefined
  );
}

/** The steps, in order; each shows what the earlier ones chose. */
export const firstRunSteps = [
  { id: "provider", label: "Provider 与 Key" },
  { id: "models", label: "模型列表" },
  { id: "agents", label: "Agent" },
  { id: "model", label: "默认模型" },
  { id: "review", label: "确认改动" },
] as const;
export type FirstRunStep = (typeof firstRunSteps)[number]["id"];
