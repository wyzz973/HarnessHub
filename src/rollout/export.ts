import { open, unlink } from "node:fs/promises";
import path from "node:path";
import type { RunId } from "../domain/types.js";

/**
 * Copies the Gateway's committed NDJSON stream without starting execution or
 * opening its database. The caller owns cancellation. Existing output paths
 * (including symlinks) are refused; failed exports remove their partial file.
 */
export async function exportRollout(options: {
  url: URL;
  runId: RunId;
  output: string;
  signal: AbortSignal;
}): Promise<{ output: string; bytes: number }> {
  const output = path.resolve(options.output);
  const file = await open(output, "wx", 0o600);
  let bytes = 0;
  try {
    const endpoint = new URL(
      `/v1/runs/${encodeURIComponent(options.runId)}/rollout`,
      options.url,
    );
    const response = await fetch(endpoint, { signal: options.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Rollout export failed: Gateway returned HTTP ${response.status}`,
      );
    }
    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim();
    if (mediaType !== "application/x-ndjson" || !response.body) {
      await response.body?.cancel();
      throw new Error(
        "Rollout export failed: expected an NDJSON response stream",
      );
    }
    // One awaited write per network chunk provides bounded memory and backpressure.
    for await (const chunk of response.body) {
      options.signal.throwIfAborted();
      await file.writeFile(chunk);
      bytes += chunk.byteLength;
    }
    options.signal.throwIfAborted();
    await file.sync();
    await file.close();
    return { output, bytes };
  } catch (error) {
    const cleanup = await Promise.allSettled([file.close()]);
    try {
      await unlink(output);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Rollout export failed and its partial file could not be removed",
      );
    }
    const failedClose = cleanup.find((result) => result.status === "rejected");
    if (failedClose?.status === "rejected") {
      throw new AggregateError(
        [error, failedClose.reason],
        "Rollout export failed and its file could not be closed",
      );
    }
    throw error;
  }
}
