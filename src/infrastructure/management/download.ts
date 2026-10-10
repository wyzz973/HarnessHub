import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { ManagementError, type ManagementInstallContext } from "../../contracts/management.js";

export async function managementDownload(url: string, destination: string, context: ManagementInstallContext,
  maximum = 512 * 1024 * 1024): Promise<string> {
  context.assertOwned(); let current = new URL(url), response: Response | null = null;
  for (let redirects = 0; redirects < 5; redirects++) {
    if (current.protocol !== "https:" || current.username || current.password) throw new ManagementError("INVALID_SOURCE", "installation source must use HTTPS");
    response = await fetch(current, { signal: context.signal, redirect: "manual" }); context.assertOwned();
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location"); await response.body?.cancel(); context.assertOwned();
      if (next === null) throw new ManagementError("DOWNLOAD_FAILED", "installation download redirect has no destination");
      current = new URL(next, current); response = null; continue;
    }
    break;
  }
  if (response === null || !response.ok || response.body === null) { await response?.body?.cancel(); throw new ManagementError("DOWNLOAD_FAILED", "installation artifact could not be downloaded"); }
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > maximum) { await response.body.cancel(); throw new ManagementError("DOWNLOAD_LIMIT", "installation artifact exceeds its download budget"); }
  context.assertOwned(); const handle = await open(destination, "wx", 0o600); context.assertOwned();
  const reader = response.body.getReader(), hash = createHash("sha256"); let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); context.assertOwned(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > maximum) throw new ManagementError("DOWNLOAD_LIMIT", "installation artifact exceeded its download budget");
      hash.update(chunk.value); let written = 0;
      while (written < chunk.value.length) {
        context.assertOwned(); const result = await handle.write(chunk.value.subarray(written)); context.assertOwned();
        if (result.bytesWritten === 0) throw new ManagementError("DOWNLOAD_FAILED", "installation artifact write made no progress"); written += result.bytesWritten;
      }
    }
    await handle.sync(); context.assertOwned(); context.log("system", "Downloaded " + bytes + " bytes."); return hash.digest("hex");
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); await handle.close(); }
}
export async function managementText(url: string, context: ManagementInstallContext): Promise<string> {
  context.assertOwned(); const response = await fetch(url, { signal: context.signal, redirect: "error" }); context.assertOwned();
  if (!response.ok || !response.body) throw new ManagementError("METADATA_FAILED", "runtime metadata could not be read");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); context.assertOwned(); if (chunk.done) break; bytes += chunk.value.length;
    if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new ManagementError("METADATA_LIMIT", "runtime metadata exceeded its byte budget"); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
