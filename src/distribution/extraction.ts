import { lstat } from "node:fs/promises";
import path from "node:path";
import { bundlePath } from "./manifest.js";
import type { BundleManifest } from "./types.js";

/**
 * Files checked for presence, the longest bundle-relative paths first. Windows Explorer's
 * "Extract All" silently skips entries whose destination passes 260 characters, so the
 * longest paths are the ones that go missing; a complete extraction costs a few stats.
 */
export const EXTRACTION_PROBE_COUNT = 25;
/**
 * Root length above which even a complete extraction is fragile: the longest bundle path
 * is about 200 characters, and engines create deeper paths under `state/` while running.
 */
export const EXTRACTION_ROOT_WARN = 60;

/** Message of a failed extraction; both languages because a judge may read either. */
export function incompleteExtractionMessage(
  missing: readonly string[],
): string {
  const sample = missing.slice(0, 3).join(", ");
  return [
    "解压不完整（Windows 路径超过 260 字符限制）。",
    "请用 7-Zip 或 `tar -xf` 解压到较短的路径（例如 D:\\hh）后重试。",
    `缺少文件 / missing ${missing.length} file(s), for example: ${sample}`,
    "Incomplete extraction: re-extract with 7-Zip or `tar -xf` into a short path.",
  ].join(" ");
}

/** Warning for a deep bundle root; the bundle still starts. */
export function longRootMessage(root: string): string {
  return [
    `解压路径较长（${root.length} 字符）：${root}`,
    "引擎在运行时会创建更深的路径，建议改用较短的目录（例如 D:\\hh）。",
    `The bundle root is ${root.length} characters; a shorter path such as D:\\hh is safer.`,
  ].join(" ");
}

/**
 * Verify that the deepest files of the inventory exist, so a bundle extracted with a tool
 * that dropped long paths fails immediately with an actionable message instead of at the
 * first engine start. Only presence is checked; `hub.cmd doctor --full` verifies hashes.
 *
 * @param warn - receives {@link longRootMessage} when the root is deep but usable.
 * @throws Error {@link incompleteExtractionMessage} when any probed file is missing.
 */
export async function assertCompleteExtraction(
  root: string,
  manifest: BundleManifest,
  options: { warn?: (message: string) => void; probe?: number } = {},
): Promise<void> {
  const probe = options.probe ?? EXTRACTION_PROBE_COUNT;
  const deepest = [...manifest.files]
    .sort((left, right) => right.path.length - left.path.length)
    .slice(0, probe);
  const missing: string[] = [];
  for (const file of deepest) {
    const info = await lstat(bundlePath(root, file.path)).catch(
      () => undefined,
    );
    if (!info?.isFile()) missing.push(file.path);
  }
  if (missing.length) throw new Error(incompleteExtractionMessage(missing));
  if (path.resolve(root).length > EXTRACTION_ROOT_WARN)
    options.warn?.(longRootMessage(path.resolve(root)));
}
