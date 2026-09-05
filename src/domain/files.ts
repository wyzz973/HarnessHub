import { HubError } from "./errors.js";
import type { FileOutput } from "./types.js";

/** Portable relative file paths have no parent traversal, empty components or Windows aliases. */
export function isRelativeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\\:<>"|?*\x00-\x1f]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
/** Reject ambiguous or escaping output declarations before accepting a Run. */
export function validateFileOutputs(outputs: FileOutput[]): void {
  if (
    !outputs.length ||
    outputs.length > 32 ||
    new Set(outputs.map((o) => o.name.normalize("NFC").toLowerCase())).size !==
      outputs.length ||
    new Set(outputs.map((o) => o.path.normalize("NFC").toLowerCase())).size !==
      outputs.length ||
    outputs.some(
      (o) =>
        !isRelativeFilePath(o.path) ||
        !isRelativeFilePath(o.name) ||
        o.name.includes("/") ||
        o.name.length > 255 ||
        (o.mediaType !== undefined &&
          !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/.test(
            o.mediaType,
          )),
    )
  )
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Output paths and unique names must identify portable relative files",
    );
}
