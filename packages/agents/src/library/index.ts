// SPDX-License-Identifier: MIT
/**
 * The Library (04 section 8): instruction sets, MCP servers and skills kept
 * once in HarnessHub's data directory and synced into the core agents'
 * own files, with the preview, backups, atomic writes and owned-entry
 * removal of global wiring. The daemon owns the store and the secrets;
 * these functions never read the process environment or the user's home
 * beyond the context they are given.
 */
export { LibraryError, type LibraryErrorCode } from "./errors.js";
export { LibraryStore } from "./store.js";
export {
  applyLibrarySync,
  planLibrarySync,
  SKILL_MARKER,
  type ConfirmedLibraryPlan,
  type LibraryAgentPlan,
  type LibraryPlan,
  type LibraryPlanFile,
  type LibraryPlanSkill,
  type LibraryRefusal,
  type LibrarySources,
  type LibrarySyncOptions,
} from "./sync.js";
export { libraryCapabilities, libraryTarget } from "./targets.js";
export {
  parseAgents,
  parseInstructionSet,
  parseMcpServer,
} from "./validate.js";
export {
  libraryAgents,
  type InstructionSet,
  type LibraryAgent,
  type LibraryIndex,
  type LibraryKind,
  type LibrarySecretRef,
  type McpServerItem,
  type SkillItem,
} from "./types.js";
