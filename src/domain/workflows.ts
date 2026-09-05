import { Ajv } from "ajv";
import { HubError } from "./errors.js";
import { validateFileOutputs } from "./files.js";
import { fileOutputSchema } from "./schemas.js";
import type {
  ArtifactId,
  Brand,
  FileOutput,
  PublicError,
  RunId,
  SessionId,
} from "./types.js";

export type WorkflowId = Brand<string, "WorkflowId">;
export type WorkflowStatus =
  | "planning"
  | "draft"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "interrupted";
export type WorkflowCapability = "permissions" | "images";
/** Automatic selection is a recorded heuristic, never a claim about optimal model quality. */
export interface EngineSelection {
  engineId: string;
  profileRevision: string;
  mode: "auto" | "explicit";
  reason: string;
  candidates: {
    engineId: string;
    profileRevision: string;
    eligible: boolean;
    score: number | null;
    reasons: string[];
  }[];
}
/** Untrusted planner output; execution identities and routing are owned by the application. */
export interface WorkflowPlan {
  title: string;
  steps: {
    id: string;
    title: string;
    instructions: string;
    dependsOn: string[];
    outputs: FileOutput[];
    requiredCapabilities?: WorkflowCapability[];
    timeoutMs?: number;
  }[];
}
export interface WorkflowStep {
  id: string;
  title: string;
  instructions: string;
  dependsOn: string[];
  outputs: FileOutput[];
  requiredCapabilities: WorkflowCapability[];
  timeoutMs: number;
  status: WorkflowStepStatus;
  selection: EngineSelection;
  sessionId?: SessionId;
  runId?: RunId;
  output?: string;
  artifactIds?: ArtifactId[];
  error?: PublicError;
}
/** Public durable plan. A draft has no step Runs; approval binds all step Sessions before execution. */
export interface Workflow {
  schemaVersion: 1;
  id: WorkflowId;
  status: WorkflowStatus;
  goal: string;
  workspaceId: string;
  requestedEngineId: string;
  plannerEngineId: string;
  plannerProfileRevision: string;
  plannerSelection: EngineSelection;
  plannerTimeoutMs: number;
  planningSessionId?: SessionId;
  planningRunId?: RunId;
  title?: string;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  finishedAt?: number;
  error?: PublicError;
}
export interface WorkflowRequest {
  goal: string;
  workspaceId?: string;
  engineId?: string;
  plannerEngineId?: string;
  timeoutMs?: number;
}
/** The Gateway owns all writes. Updates enforce an immutable request and bound Session/Run identities. */
export interface WorkflowStore {
  create(workflow: Workflow, key?: string): void;
  findByKey(key: string): Workflow | undefined;
  get(id: WorkflowId): Workflow;
  list(): Workflow[];
  update(workflow: Workflow): void;
  submittedRun(sessionId: SessionId, key: string): RunId | undefined;
  close(): void;
}

const text = { type: "string", minLength: 1, maxLength: 100 };
const timestamp = { type: "integer", minimum: 0 };
const timeout = { type: "integer", minimum: 1000, maximum: 3_600_000 };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const capabilities = {
  type: "array",
  maxItems: 2,
  uniqueItems: true,
  items: { enum: ["permissions", "images"] },
};
const stepProperties = {
  id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" },
  title: { type: "string", minLength: 1, maxLength: 200 },
  instructions: { type: "string", minLength: 1, maxLength: 16_000 },
  dependsOn: { type: "array", maxItems: 7, uniqueItems: true, items: text },
  outputs: { type: "array", maxItems: 16, items: fileOutputSchema },
  requiredCapabilities: capabilities,
  timeoutMs: timeout,
};
export const workflowRequestSchema = object(
  {
    goal: { type: "string", minLength: 1, maxLength: 16_000 },
    workspaceId: text,
    engineId: text,
    plannerEngineId: text,
    timeoutMs: timeout,
  },
  ["goal"],
);
export const workflowPlanSchema = object({
  title: { type: "string", minLength: 1, maxLength: 200 },
  steps: {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: object(stepProperties, [
      "id",
      "title",
      "instructions",
      "dependsOn",
      "outputs",
    ]),
  },
});
export const engineSelectionSchema = object({
  engineId: text,
  profileRevision: text,
  mode: { enum: ["auto", "explicit"] },
  reason: { type: "string", minLength: 1, maxLength: 1000 },
  candidates: {
    type: "array",
    items: object({
      engineId: text,
      profileRevision: text,
      eligible: { type: "boolean" },
      score: { anyOf: [{ type: "number" }, { type: "null" }] },
      reasons: { type: "array", items: { type: "string", maxLength: 1000 } },
    }),
  },
});
const publicError = object({
  code: text,
  message: { type: "string", minLength: 1, maxLength: 1000 },
});
export const workflowResponseSchema = object(
  {
    schemaVersion: { const: 1 },
    id: text,
    status: {
      enum: [
        "planning",
        "draft",
        "running",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ],
    },
    goal: { type: "string", minLength: 1, maxLength: 16_000 },
    workspaceId: text,
    requestedEngineId: text,
    plannerEngineId: text,
    plannerProfileRevision: text,
    plannerSelection: engineSelectionSchema,
    plannerTimeoutMs: timeout,
    planningSessionId: text,
    planningRunId: text,
    title: { type: "string", minLength: 1, maxLength: 200 },
    steps: {
      type: "array",
      maxItems: 8,
      items: object(
        {
          ...stepProperties,
          status: {
            enum: [
              "pending",
              "running",
              "completed",
              "failed",
              "cancelled",
              "blocked",
              "interrupted",
            ],
          },
          selection: engineSelectionSchema,
          sessionId: text,
          runId: text,
          output: { type: "string", maxLength: 8_388_608 },
          artifactIds: { type: "array", items: text },
          error: publicError,
        },
        [...Object.keys(stepProperties), "status", "selection"],
      ),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    approvedAt: timestamp,
    finishedAt: timestamp,
    error: publicError,
  },
  [
    "schemaVersion",
    "id",
    "status",
    "goal",
    "workspaceId",
    "requestedEngineId",
    "plannerEngineId",
    "plannerProfileRevision",
    "plannerSelection",
    "plannerTimeoutMs",
    "steps",
    "createdAt",
    "updatedAt",
  ],
);
const ajv = new Ajv({ allErrors: true, strict: true });
export const isWorkflowRequest = ajv.compile<WorkflowRequest>(
  workflowRequestSchema,
);
export const isWorkflow = ajv.compile<Workflow>(workflowResponseSchema);
const isPlan = ajv.compile<WorkflowPlan>(workflowPlanSchema);

/** Accept one JSON document or one enclosing markdown fence; reject cycles, unsafe paths and oversized plans. */
export function parseWorkflowPlan(output: string): WorkflowPlan {
  if (output.length > 160_000)
    throw new HubError(
      "INVALID_WORKFLOW_PLAN",
      "Planner output exceeds the plan limit",
    );
  const source = output
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/i, "$1");
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new HubError(
      "INVALID_WORKFLOW_PLAN",
      "Planner must return one valid JSON plan",
    );
  }
  if (!isPlan(decoded))
    throw new HubError(
      "INVALID_WORKFLOW_PLAN",
      "Planner output does not match the bounded plan schema",
    );
  const ids = new Set(decoded.steps.map((step) => step.id));
  if (ids.size !== decoded.steps.length)
    throw new HubError(
      "INVALID_WORKFLOW_PLAN",
      "Plan step identifiers must be unique",
    );
  for (const step of decoded.steps) {
    if (step.dependsOn.some((id) => !ids.has(id) || id === step.id))
      throw new HubError(
        "INVALID_WORKFLOW_PLAN",
        "Plan dependencies must reference other steps",
      );
    if (step.outputs.length) validateFileOutputs(step.outputs);
  }
  const reached = new Set<string>();
  while (reached.size < decoded.steps.length) {
    const ready = decoded.steps.filter(
      (step) =>
        !reached.has(step.id) && step.dependsOn.every((id) => reached.has(id)),
    );
    if (!ready.length)
      throw new HubError(
        "INVALID_WORKFLOW_PLAN",
        "Plan dependencies contain a cycle",
      );
    for (const step of ready) reached.add(step.id);
  }
  const dependsOn = (stepId: string, ancestor: string): boolean => {
    const step = decoded.steps.find((candidate) => candidate.id === stepId)!;
    return step.dependsOn.some(
      (id) => id === ancestor || dependsOn(id, ancestor),
    );
  };
  const outputOwners = new Map<string, string[]>();
  for (const step of decoded.steps) {
    for (const output of step.outputs) {
      const file = output.path.normalize("NFC").toLowerCase();
      for (const owner of outputOwners.get(file) ?? []) {
        if (!dependsOn(step.id, owner) && !dependsOn(owner, step.id))
          throw new HubError(
            "INVALID_WORKFLOW_PLAN",
            "Steps that overwrite the same output must have an explicit dependency",
          );
      }
      outputOwners.set(file, [...(outputOwners.get(file) ?? []), step.id]);
    }
  }
  return decoded;
}

export function isWorkflowTerminal(status: WorkflowStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}
