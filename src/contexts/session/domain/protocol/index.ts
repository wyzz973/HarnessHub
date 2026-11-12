/**
 * The protocol's shared normalization (docs/proposals/protocol/hub-protocol.html §7): the one rule that turns what each Harness reports
 * into the protocol's items, models, usage and stop reasons. The relay's narration, the context table and the web view all read it.
 */
export { changesFrom, diffFiles, locationOf, type FileChange, type ToolDetailInput } from "./changes.js";
export { modelLabel } from "./models.js";
export { projectTurn, projectTurns, type ProjectionEnv, type ProjectionInput } from "./project.js";
export { unwrapShell, shellWords } from "./shell.js";
export { errorClass, itemStatus, runEnded, runItemStatus, stopReason, toolOutcome, turnStatus } from "./status.js";
export { classifyTool, commandTextOf, detailHead, HEAD_INPUT, LABEL_MAX, normalizeTool, plainTool, planFromInput, toolFamily, type Normalized, type ToolClass, type ToolContext, type ToolFacts, type ToolFamily } from "./tools.js";
export { turnUsage } from "./usage.js";
