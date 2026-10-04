// SPDX-License-Identifier: MIT
/**
 * The console's message catalogs, one module per area so that areas can
 * change their messages independently; keys start with the area's name.
 */
import * as agents from "./agents";
import * as backup from "./backup";
import * as common from "./common";
import * as library from "./library";
import * as providers from "./providers";
import * as routing from "./routing";
import * as settings from "./settings";
import * as subscriptions from "./subscriptions";
import * as tasks from "./tasks";
import * as usage from "./usage";
import type { Translation } from "./types";

/** Each area's catalogs, for the contract test (no key in two areas). */
export const areas = {
  agents,
  backup,
  common,
  library,
  providers,
  routing,
  settings,
  subscriptions,
  tasks,
  usage,
} as const;

/** The source catalog. */
export const zhCN = {
  ...agents.zh,
  ...backup.zh,
  ...common.zh,
  ...library.zh,
  ...providers.zh,
  ...routing.zh,
  ...settings.zh,
  ...subscriptions.zh,
  ...tasks.zh,
  ...usage.zh,
} as const;

export const en: Translation<typeof zhCN> = {
  ...agents.en,
  ...backup.en,
  ...common.en,
  ...library.en,
  ...providers.en,
  ...routing.en,
  ...settings.en,
  ...subscriptions.en,
  ...tasks.en,
  ...usage.en,
};
