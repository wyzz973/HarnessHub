import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import type { ArtifactId, ArtifactRecord, RunId } from "../domain/types.js";

/** Publishes complete content to an exclusive file; the caller commits the resulting metadata. */
export function createArtifactPublisher(root: string) {
  return async (
    runId: RunId,
    value: { name: string; mediaType: string; text: string },
  ): Promise<ArtifactRecord> => {
    if (Buffer.byteLength(value.text) > 4 * 1024 * 1024)
      throw new HubError(
        "ARTIFACT_TOO_LARGE",
        "Artifact exceeds the 4 MiB transport limit",
      );
    const id = randomUUID() as ArtifactId;
    const directory = path.resolve(root, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, id);
    await writeFile(file, value.text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return {
      id,
      runId,
      name: path.basename(value.name),
      mediaType: value.mediaType,
      size: Buffer.byteLength(value.text),
      sha256: createHash("sha256").update(value.text).digest("hex"),
      path: file,
      createdAt: Date.now(),
    };
  };
}
/** Read only registered content inside the artifact root, verifying integrity before disclosure. */
export async function readArtifact(
  root: string,
  artifact: ArtifactRecord,
): Promise<Buffer> {
  const base = await realpath(root);
  const file = await realpath(artifact.path);
  const relative = path.relative(base, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new HubError(
      "INVALID_ARTIFACT",
      "Artifact path is outside its registered root",
      403,
    );
  const bytes = await readFile(file);
  if (
    bytes.length !== artifact.size ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  )
    throw new HubError(
      "ARTIFACT_CORRUPT",
      "Artifact integrity check failed",
      409,
    );
  return bytes;
}
