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
// Adapters following Magpie (MIT) @2e340f7.
import { cline } from "./cline.js";
import { grok } from "./grok.js";
import { hermes } from "./hermes.js";
import { mimocode } from "./mimocode.js";
import { minimaxCode } from "./minimax-code.js";
import { omo } from "./omo.js";
import { omp } from "./omp.js";
import { openchamber } from "./openchamber.js";
import { pencil } from "./pencil.js";
import { qoder, qoderCn } from "./qoder.js";
import { t3code } from "./t3code.js";
// Agents that keep HarnessHub's entries as elements of their own lists.
import { claudeDesktop } from "./claude-desktop.js";
import { dsh } from "./dsh.js";
// Agents that send no key of their own: it goes in the path (ADR 0033).
import { commandcode } from "./commandcode.js";
import { fx } from "./fx.js";
import { muse } from "./muse.js";
import { droid } from "./droid.js";
import { workbuddy } from "./workbuddy.js";
import { zcode } from "./zcode.js";

export type * from "./types.js";

/** Every agent global wiring supports, by id. */
export const wiringAdapters: ReadonlyMap<string, WiringAdapter> = new Map(
  [
    ...[claude, codex, gemini, qwen, opencode, pi, crush, kimi],
    // Following Magpie (MIT) @2e340f7.
    ...[
      mimocode,
      omo,
      hermes,
      minimaxCode,
      grok,
      qoder,
      qoderCn,
      cline,
      omp,
      pencil,
      t3code,
      openchamber,
    ],
    ...[droid, workbuddy, zcode, claudeDesktop, dsh],
    ...[commandcode, fx, muse],
  ].map((adapter) => [adapter.id, adapter]),
);

/**
 * What to do after a change for the agent to use it: the adapter's own
 * notice, or to restart running sessions; undefined for an agent that picks
 * changes up by itself (`restartNotice: null`).
 */
export function restartNotice(adapter: WiringAdapter): string | undefined {
  if (adapter.restartNotice === null) return undefined;
  return (
    adapter.restartNotice ??
    `Restart running ${adapter.name} sessions to use the new configuration.`
  );
}

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
