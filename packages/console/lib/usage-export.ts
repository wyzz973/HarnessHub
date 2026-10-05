// SPDX-License-Identifier: MIT
/**
 * CSV downloads of the Usage page (`format=csv` of `/api/v1/model-calls`
 * and `/api/v1/usage`). The request carries the tab's session token like
 * every other, so the page fetches the stream through the SDK and saves it
 * as a file; a plain link would send the cookie alone and get 401.
 */
import type { CallFilter, UsageGroupBy } from "@harnesshub/sdk/client";
import { apiClient } from "./session";

/** The daemon's file names: `harnesshub-calls-2026-10-05.csv` or `harnesshub-usage-by-model-2026-10-05.csv`, by the local date. */
export function csvFileName(
  what: { kind: "calls" } | { kind: "usage"; groupBy: UsageGroupBy },
  now: Date,
): string {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return what.kind === "calls"
    ? `harnesshub-calls-${day}.csv`
    : `harnesshub-usage-by-${what.groupBy}-${day}.csv`;
}

/** Hand a body to the browser as a file download; the object URL is released afterwards. */
async function save(stream: ReadableStream<Uint8Array>, name: string) {
  const blob = await new Response(stream, {
    headers: { "content-type": "text/csv; charset=utf-8" },
  }).blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // The click has started the download; the URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Download the calls (`kind: "calls"`) or the sums by `groupBy`, for the
 * filter shown. Rejects with the SDK's errors; nothing is saved then.
 */
export async function downloadUsageCsv(
  what: { kind: "calls" } | { kind: "usage"; groupBy: UsageGroupBy },
  filter: CallFilter,
): Promise<void> {
  const client = apiClient();
  const stream =
    what.kind === "calls"
      ? await client.modelCalls.csv(filter)
      : await client.usage.csv({ ...filter, groupBy: what.groupBy });
  await save(stream, csvFileName(what, new Date()));
}
