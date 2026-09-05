import { configurationSchema } from "./engine-configuration";
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
export const errorSchema = z.object({ code: z.string(), message: z.string() });
export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_permission",
  "cancelling",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
export const sessionSchema = z.object({
  id: z.string(),
  engineId: z.string(),
  profileRevision: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  configSnapshot: object.optional(),
  status: z.enum(["open", "closing", "closed"]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const permissionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  prompt: z.string(),
  status: z.enum(["pending", "decided", "applied", "expired"]),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["allow_once", "reject_once"]),
    }),
  ),
  decision: z.string().optional(),
  expiresAt: z.number(),
});
export const artifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  sha256: z.string(),
  createdAt: z.number(),
});
export const runSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  generation: z.number(),
  status: runStatusSchema,
  input: z.object({ text: z.string(), timeoutMs: z.number() }),
  createdAt: z.number(),
  deadlineAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  output: z.string().optional(),
  error: errorSchema.optional(),
  lastSeq: z.number(),
  cleanupStatus: z.string(),
  configSnapshot: object.optional(),
  permissions: z.array(permissionSchema).optional(),
  artifacts: z.array(artifactSchema).optional(),
});
export const eventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  seq: z.number(),
  occurredAt: z.number(),
  observedAt: z.number(),
  type: z.string(),
  data: object,
});
export const engineSchema = z.object({
  id: z.string(),
  driver: z.enum(["acp", "cli", "fake"]),
  revision: z.string(),
  enabled: z.boolean(),
  command: z.array(z.string()).optional(),
  model: z.string().optional(),
  configuration: configurationSchema.optional(),
  credentialEnv: z.array(z.string()).optional(),
  maxConcurrency: z.number(),
  cli: z
    .object({
      inputMode: z.enum(["stdin", "argv"]),
      maxOutputBytes: z.number(),
    })
    .optional(),
  acp: z.object({ sessionMode: z.literal("resume") }).optional(),
  capabilities: z.object({
    configured: z.object({
      resume: z.boolean(),
      permissions: z.boolean(),
      images: z.boolean(),
    }),
    observed: z.unknown(),
    validated: z.unknown(),
  }),
});
export const registrationSchema = z
  .object({
    id: z.string().min(1),
    driver: z.enum(["acp", "cli"]),
    command: z.array(z.string()).min(1),
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    configuration: configurationSchema.optional(),
    credentialEnv: z.array(z.string()).optional(),
    maxConcurrency: z.number().optional(),
    cli: z
      .object({
        inputMode: z.enum(["stdin", "argv"]).optional(),
        maxOutputBytes: z.number().optional(),
      })
      .optional(),
    acp: z.object({ sessionMode: z.literal("resume") }).optional(),
  })
  .strict();
export const candidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  executable: z.string(),
  source: z.enum(["path", "known-location", "manifest"]),
  status: z.enum(["ready", "adapter-required"]),
  registration: registrationSchema.optional(),
  notes: z.array(z.string()),
});
export const workspaceSchema = z.object({ id: z.string(), path: z.string() });
export const selectionSchema = z.object({
  engineId: z.string(),
  profileRevision: z.string(),
  mode: z.enum(["auto", "explicit"]),
  reason: z.string(),
  candidates: z.array(
    z.object({
      engineId: z.string(),
      profileRevision: z.string(),
      eligible: z.boolean(),
      score: z.number().nullable(),
      reasons: z.array(z.string()),
    }),
  ),
});
export const workflowSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  status: z.enum([
    "planning",
    "draft",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  goal: z.string(),
  workspaceId: z.string(),
  requestedEngineId: z.string(),
  plannerEngineId: z.string(),
  plannerSelection: selectionSchema,
  planningSessionId: z.string().optional(),
  planningRunId: z.string().optional(),
  title: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      instructions: z.string(),
      dependsOn: z.array(z.string()),
      outputs: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          mediaType: z.string().optional(),
        }),
      ),
      status: z.enum([
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
        "blocked",
        "interrupted",
      ]),
      selection: selectionSchema,
      sessionId: z.string().optional(),
      runId: z.string().optional(),
      output: z.string().optional(),
      artifactIds: z.array(z.string()).optional(),
      error: errorSchema.optional(),
    }),
  ),
  createdAt: z.number(),
  updatedAt: z.number(),
  error: errorSchema.optional(),
});
const nullableNumber = z.number().nullable();
export const observationSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  engineId: z.string(),
  status: runStatusSchema,
  prompt: z.string(),
  model: z.object({
    configured: z.string().nullable(),
    actual: z.string().nullable(),
    source: z.string().nullable(),
    missingReason: z.string().nullable(),
  }),
  timings: z.object({
    acceptedAt: z.number(),
    startedAt: nullableNumber,
    firstOutputAt: nullableNumber,
    finishedAt: nullableNumber,
    queueMs: nullableNumber,
    startupMs: nullableNumber,
    timeToFirstOutputMs: nullableNumber,
    durationMs: nullableNumber,
    executionMs: nullableNumber,
    cleanupMs: nullableNumber,
  }),
  tokens: z.object({
    input: nullableNumber,
    output: nullableNumber,
    cacheRead: nullableNumber,
    cacheWrite: nullableNumber,
    reasoning: nullableNumber,
    total: nullableNumber,
  }),
  cost: z.object({
    amount: nullableNumber,
    currency: z.string().nullable(),
    kind: z.string(),
    source: z.string().nullable(),
    missingReason: z.string().nullable(),
  }),
  usage: z.object({
    scope: z.string().nullable(),
    source: z.string().nullable(),
    missingReason: z.string().nullable(),
  }),
  counts: z.object({
    outputCharacters: z.number(),
    reasoningCharacters: z.number(),
    toolCalls: z.number(),
    permissions: z.number(),
    artifacts: z.number(),
  }),
  versions: z.object({
    driver: z.string().nullable(),
    profileRevision: z.string().nullable(),
    installation: z.unknown(),
  }),
  coverage: z.object({
    eventsComplete: z.boolean(),
    usage: z.unknown(),
    model: z.unknown(),
    installation: z.unknown(),
    missingReasons: z.array(z.string()),
  }),
});
export const overviewSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.number(),
  scope: z.object({
    limit: z.number(),
    totalRuns: z.number(),
    sampledRuns: z.number(),
  }),
  summary: z.object({
    totalRuns: z.number(),
    activeRuns: z.number(),
    completedRuns: z.number(),
    failedRuns: z.number(),
    cancelledRuns: z.number(),
    timedOutRuns: z.number(),
    interruptedRuns: z.number(),
    p50DurationMs: nullableNumber,
    p95DurationMs: nullableNumber,
    knownInputTokens: nullableNumber,
    knownOutputTokens: nullableNumber,
    knownTotalTokens: nullableNumber,
    usageObservedRuns: z.number(),
    usageCoverage: nullableNumber,
  }),
  engines: z.array(
    z.object({
      id: z.string(),
      enabled: z.boolean(),
      maxConcurrency: z.number(),
      activeRuns: z.number(),
      queuedRuns: z.number(),
      completedRuns: z.number(),
      failedRuns: z.number(),
      p50DurationMs: nullableNumber,
      p95DurationMs: nullableNumber,
    }),
  ),
  recentRuns: z.array(observationSchema),
});
export type Engine = z.infer<typeof engineSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Registration = z.infer<typeof registrationSchema>;
export type Run = z.infer<typeof runSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type AgentEvent = z.infer<typeof eventSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type Selection = z.infer<typeof selectionSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export function isTerminal(status: string) {
  return [
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "interrupted",
  ].includes(status);
}
