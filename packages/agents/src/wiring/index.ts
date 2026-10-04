// SPDX-License-Identifier: MIT
/**
 * Global wiring (04 section 4): rewires locally installed agents to the
 * HarnessHub gateway by editing their own configuration in place, with a
 * preview, content-addressed backups, atomic writes, read-back verification,
 * byte-exact unwire and drift detection. The daemon and CLI call these
 * functions; they persist the returned `WiringRecord` and own the keys.
 */
export {
  applyWiring,
  detectDrift,
  isKeyless,
  maskGatewayKeys,
  planWiring,
  resolveOptions,
  unwire,
  wiredKeyText,
  type ApplyOptions,
  type ConfirmedPlan,
  type DriftFinding,
  type DriftKind,
  type DriftReport,
  type PlannedChange,
  type PlannedFile,
  type UnwireAction,
  type UnwireResult,
  type WiringContext,
  type WiringOptions,
  type WiringOutcome,
  type WiringPlan,
  type WiringTarget,
} from "./operations.js";
export { detectAgent, type AgentInstallation } from "./detect.js";
export { wiringAdapter, wiringAdapters } from "./adapters/index.js";
export type { WiringAdapter, WiringModel } from "./adapters/index.js";
export {
  WiringError,
  type WiringErrorCode,
  type WiringRollback,
} from "./errors.js";
