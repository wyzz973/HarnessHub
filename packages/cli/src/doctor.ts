// SPDX-License-Identifier: MIT
/**
 * `hh provider test <id>` and `hh provider doctor <id>` (03 section 9). Both
 * send real requests to the provider's upstream through the daemon, which
 * records each in the ledger under `client:doctor`. The doctor prints its
 * plan (model calls and estimated cost) before it runs; `--fix` prints the
 * proposed provider change and applies it only after confirmation.
 */
import type {
  DoctorItem,
  DoctorPlan,
  ProviderPatch,
} from "@harnesshub/sdk/client";
import {
  confirm,
  context,
  output,
  parse,
  positionals,
  table,
  UsageError,
  write,
} from "./admin.js";

const usd = (amount: number) => `$${amount.toFixed(6)}`;

function planText(plan: DoctorPlan): string {
  return [
    `Doctor: ${plan.provider}, model ${plan.model}${plan.wireModel !== plan.model ? ` (sent as ${plan.wireModel})` : ""}, on the ${plan.protocol} endpoint`,
    `Plan: ${plan.modelCalls} model calls (at most ${plan.maxModelCalls})${plan.listRequests ? ` and ${plan.listRequests} model list request` : ""}; estimated cost ${
      plan.estimatedCostUsd === null
        ? `unknown (the model has no price; about ${plan.estimatedTokens.input} input and ${plan.estimatedTokens.output} output tokens)`
        : usd(plan.estimatedCostUsd)
    }`,
  ].join("\n");
}

function itemText(item: DoctorItem): string {
  const lines = [
    `${item.status.toUpperCase().padEnd(4)}  ${item.check.padEnd(17)} ${item.summary}`,
  ];
  const indent = (text: string) => `      ${text}`;
  for (const detail of item.details) lines.push(indent(detail));
  if (item.status === "fail" || item.status === "warn") {
    if (item.excerpt)
      lines.push(
        indent(
          `error: ${item.excerpt}${item.httpStatus ? ` (HTTP ${item.httpStatus}${item.url ? `, ${item.url}` : ""})` : ""}`,
        ),
      );
    for (const suggestion of item.suggestions)
      lines.push(indent(`try: ${suggestion}`));
  }
  return lines.join("\n");
}

/**
 * Run `hh provider test` or `hh provider doctor`; `args` follow the action.
 *
 * @throws UsageError for bad arguments; ConfirmationRequired (exit 4) when
 *   `--deep` or `--fix` needs a confirmation that cannot be asked.
 */
export async function doctorCommand(
  action: "test" | "doctor",
  args: string[],
): Promise<void> {
  const { values, positionals: given } = parse(args, {
    model: { type: "string" },
    deep: { type: "boolean" },
    fix: { type: "boolean" },
    "slow-ms": { type: "string" },
  });
  const ctx = context(values);
  const [id] = positionals(given, ["id"]);
  const model = typeof values.model === "string" ? values.model : undefined;
  const client = await ctx.client();
  if (action === "test") {
    if (values.deep || values.fix || values["slow-ms"] !== undefined)
      throw new UsageError("provider test takes only --model");
    const report = await client.providers.test(id!, model ? { model } : {});
    return output(ctx, report, () =>
      [
        `Test: ${report.provider}, model ${report.model}${report.wireModel !== report.model ? ` (sent as ${report.wireModel})` : ""}`,
        table(
          ["ENDPOINT", "STATUS", "TIME", "FIRST BYTE", "SERVED MODEL", "URL"],
          report.endpoints.map((item) => [
            item.protocol,
            item.ok ? String(item.status) : `${item.status || "-"} failed`,
            `${item.durationMs} ms`,
            item.firstByteMs === undefined ? "-" : `${item.firstByteMs} ms`,
            item.servedModel ?? "-",
            item.url,
          ]),
        ),
        ...report.endpoints
          .filter((item) => item.error)
          .map((item) => `${item.protocol}: ${item.error}`),
        `${report.modelCalls} model calls, cost ${usd(report.costUsd)}${report.unpricedCalls ? ` (${report.unpricedCalls} without a price)` : ""}`,
      ].join("\n"),
    );
  }
  let slowMs: number | undefined;
  if (typeof values["slow-ms"] === "string") {
    slowMs = Number(values["slow-ms"]);
    if (!Number.isInteger(slowMs) || slowMs < 1 || slowMs > 600_000)
      throw new UsageError("--slow-ms takes milliseconds from 1 to 600000");
  }
  const options = {
    ...(model ? { model } : {}),
    ...(values.deep ? { deep: true } : {}),
    ...(slowMs !== undefined ? { slowMs } : {}),
  };
  const { plan } = await client.providers.doctor(id!, {
    ...options,
    dryRun: true,
  });
  if (!ctx.json) write(planText(plan));
  if (values.deep) {
    const probe = plan.checks.find((item) => item.check === "context-overflow");
    if (probe?.modelCalls)
      await confirm(
        ctx,
        `--deep sends about ${plan.estimatedTokens.input} input tokens in all. Run it?`,
      );
  }
  const report = await client.providers.doctor(id!, options);
  const items = report.items ?? [];
  const count = (status: DoctorItem["status"]) =>
    items.filter((item) => item.status === status).length;
  output(ctx, report, () =>
    [
      "",
      ...items.map(itemText),
      "",
      `${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail, ${count("skip")} skip; ${report.modelCalls ?? 0} model calls, cost ${usd(report.costUsd ?? 0)}${report.unpricedCalls ? ` (${report.unpricedCalls} without a price)` : ""}`,
      ...(report.patch && !values.fix
        ? [
            `Proposed change: hh provider doctor ${id}${model ? ` --model ${model}` : ""} --fix`,
          ]
        : []),
    ].join("\n"),
  );
  if (!values.fix) return;
  if (!report.patch) {
    if (!ctx.json) write("Nothing to fix.");
    return;
  }
  if (!ctx.json)
    write(
      `Proposed change to provider ${id} (PATCH /api/v1/providers/${id}):\n${JSON.stringify(report.patch, null, 2)}`,
    );
  await confirm(ctx, `Apply this change to provider ${id}?`);
  // The daemon proposed it for exactly this request (PATCH /providers/{id}).
  await client.providers.update(id!, report.patch as ProviderPatch);
  if (!ctx.json) write(`Updated provider ${id}.`);
}
