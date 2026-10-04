// SPDX-License-Identifier: MIT
/**
 * The provider test and doctor (docs/provider-doctor.md) as the console
 * shows them: check names, status tones and the plan's cost line.
 */
import type {
  DoctorCheck,
  DoctorItem,
  DoctorPlan,
  DoctorStatus,
} from "@harnesshub/sdk/client";
import { formatUsd, t } from "./i18n";

/** Every check, in the daemon's order; the Record keeps the list complete. */
export const doctorCheckKeys: Readonly<Record<DoctorCheck, true>> = {
  endpoints: true,
  auth: true,
  models: true,
  streaming: true,
  usage: true,
  "max-tokens": true,
  tools: true,
  "reasoning-replay": true,
  "optional-fields": true,
  image: true,
  "native-endpoints": true,
  "served-model": true,
  latency: true,
  "context-overflow": true,
};

/** A check's name. */
export function doctorCheckName(check: DoctorCheck): string {
  return t(`providers.check.${check}`);
}

const statusTones: Readonly<
  Record<DoctorStatus, "good" | "warn" | "error" | "">
> = { pass: "good", warn: "warn", fail: "error", skip: "" };

/** A status's tag and tone. */
export function doctorStatus(status: DoctorStatus): {
  label: string;
  tone: "good" | "warn" | "error" | "";
} {
  return { label: t(`providers.status.${status}`), tone: statusTones[status] };
}

/** The estimated cost to 4 decimals, or the tokens when the model has no known price. */
export function planCost(plan: DoctorPlan): string {
  if (plan.estimatedCostUsd !== null)
    return t("providers.doctor.planCost", {
      cost: formatUsd(Number(plan.estimatedCostUsd.toFixed(4))),
    });
  const { input, output } = plan.estimatedTokens;
  return t("providers.doctor.planTokens", { input, output });
}

/** How many items have each status, in the report's order of statuses. */
export function statusCounts(
  items: readonly DoctorItem[],
): Record<DoctorStatus, number> {
  const counts: Record<DoctorStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}
