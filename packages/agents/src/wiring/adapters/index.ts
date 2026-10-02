// SPDX-License-Identifier: MIT
import { WiringError } from "../errors.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { crush } from "./crush.js";
import { gemini } from "./gemini.js";
import { kimi } from "./kimi.js";
import { opencode } from "./opencode.js";
import { pi } from "./pi.js";
import { qwen } from "./qwen.js";
import type { WiringAdapter } from "./types.js";

export type * from "./types.js";

/** Every agent global wiring supports, by id. */
export const wiringAdapters: ReadonlyMap<string, WiringAdapter> = new Map(
  [claude, codex, gemini, qwen, opencode, pi, crush, kimi].map((adapter) => [
    adapter.id,
    adapter,
  ]),
);

/** The adapter with this id; an unknown id fails with WIRING_ADAPTER_UNKNOWN. */
export function wiringAdapter(id: string): WiringAdapter {
  const adapter = wiringAdapters.get(id);
  if (!adapter)
    throw new WiringError(
      "WIRING_ADAPTER_UNKNOWN",
      `No global wiring adapter is named ${JSON.stringify(id)}`,
    );
  return adapter;
}
