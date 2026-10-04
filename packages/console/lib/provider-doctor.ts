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

/** Every check, in the daemon's order; the Record keeps the list complete. */
export const doctorCheckNames: Readonly<Record<DoctorCheck, string>> = {
  endpoints: "端点",
  auth: "Key 的发送方式",
  models: "模型列表",
  streaming: "流式输出",
  usage: "用量（usage）",
  "max-tokens": "输出上限字段",
  tools: "工具调用",
  "reasoning-replay": "推理回传",
  "optional-fields": "可选字段",
  image: "图片输入",
  "native-endpoints": "未声明的端点",
  "served-model": "实际服务的模型",
  latency: "延迟",
  "context-overflow": "上下文超长",
};

export const doctorStatuses: Readonly<
  Record<DoctorStatus, { label: string; tone: "good" | "warn" | "error" | "" }>
> = {
  pass: { label: "通过", tone: "good" },
  warn: { label: "警告", tone: "warn" },
  fail: { label: "失败", tone: "error" },
  skip: { label: "跳过", tone: "" },
};

/** `$0.0021`, or the tokens when the model has no known price. */
export function planCost(plan: DoctorPlan): string {
  if (plan.estimatedCostUsd !== null)
    return `预计 $${plan.estimatedCostUsd.toFixed(4)}`;
  const { input, output } = plan.estimatedTokens;
  return `价格未知，约 ${input.toLocaleString()} 输入与 ${output.toLocaleString()} 输出 token`;
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
