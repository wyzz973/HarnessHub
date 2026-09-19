import { configurationSchema, providerSchema } from "./engine-configuration";
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
const acpSchema = z
  .object({
    sessionMode: z.literal("resume").optional(),
    // Same bound as ACP_INITIALIZE_TIMEOUT_LIMIT_MS in src/domain/engines.ts.
    initializeTimeoutMs: z.number().int().min(1).max(300_000).optional(),
  })
  .strict();
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
  acp: acpSchema.optional(),
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
    acp: acpSchema.optional(),
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
/** `GET /v1/runtime/info` (ADR 0013): the Gateway's startup mode, never user preference. */
export const runtimeInfoSchema = z.object({
  competition: z.boolean(),
  competitionEngine: z.string().optional(),
  fullAccess: z.boolean(),
  consoleUrl: z.string().optional(),
});
export const harnessModelEngineStatusSchema = z.object({
  engineId: z.string(),
  status: z.enum(["applied", "unsupported", "disabled"]),
  reason: z.string().optional(),
});
/** `HarnessModelView`: secret references only, never secret values. */
export const harnessModelViewSchema = z.object({
  configured: z.boolean(),
  source: z.enum(["environment", "file", "settings"]).optional(),
  model: z.string().optional(),
  alias: z.string(),
  provider: providerSchema.optional(),
  engines: z.array(harnessModelEngineStatusSchema),
});
/**
 * `POST /v1/harness/model/test`: one short real Run on the chosen engine. `ok` means the Run
 * completed with a non-empty reply; `status` is that Run's status and `error` is redacted.
 */
export const harnessModelTestSchema = z.object({
  ok: z.boolean(),
  status: runStatusSchema,
  durationMs: z.number(),
  runId: z.string(),
  error: errorSchema.optional(),
});
export const toolPackRecordSchema = z.object({
  id: z.string(),
  version: z.string(),
  digest: z.string(),
  installedAt: z.number().optional(),
  status: z.string().optional(),
  displayName: z.string().optional(),
  /** Skill, MCP server and CLI tool counts read from the stored manifest. */
  counts: z
    .object({
      skills: z.number().optional(),
      mcp: z.number().optional(),
      cli: z.number().optional(),
    })
    .optional(),
  /** Engines whose current configuration contains this version, when the Gateway reports it. */
  engines: z.array(z.string()).optional(),
  /** Why the stored manifest could not be read. */
  problem: errorSchema.optional(),
  /** Shipped with the distribution and installed on first start. */
  preinstalled: z.boolean().optional(),
});
const packageRefSchema = z.object({ id: z.string(), version: z.string() });
/** Per-engine outcome of apply/import/unbind; statuses beyond the ADR are shown verbatim. */
export const toolPackEngineResultSchema = z.object({
  engineId: z.string(),
  status: z.string(),
  revision: z.string().optional(),
  reason: z.string().optional(),
  capabilities: z
    .object({
      skills: z.array(z.string()).optional(),
      mcp: z.array(z.string()).optional(),
      cli: z.array(z.string()).optional(),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
});
/** Accepts both the multi-engine ADR 0013 response and the legacy single-engine fields. */
export const toolPackApplySchema = z.object({
  ok: z.boolean().optional(),
  package: packageRefSchema.optional(),
  results: z.array(toolPackEngineResultSchema).optional(),
  engineId: z.string().optional(),
  revision: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});
export const toolPackImportSchema = z.object({
  ok: z.boolean().optional(),
  package: packageRefSchema,
  counts: z
    .object({
      skills: z.number().optional(),
      mcp: z.number().optional(),
      cli: z.number().optional(),
    })
    .optional(),
  apply: toolPackApplySchema.optional(),
  warnings: z.array(z.string()).optional(),
});
/** `model.call` event data: one upstream call through the Worker model gateway. */
export const modelCallSchema = z.object({
  id: z.string(),
  inbound: z.enum([
    "openai-completions",
    "openai-responses",
    "anthropic",
    "google",
  ]),
  stream: z.boolean(),
  requestedModel: z.string().optional(),
  upstreamModel: z.string(),
  status: z.number(),
  ok: z.boolean(),
  durationMs: z.number(),
  finishReason: z.string().optional(),
  usage: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
      reasoning: z.number().optional(),
    })
    .optional(),
  toolCalls: z.number(),
  error: errorSchema.optional(),
});
/** One diagnostic JSON Lines record; every other field depends on `event`. */
export const logRecordSchema = z
  .object({ time: z.string(), level: z.string(), event: z.string() })
  .catchall(z.unknown());
/** `GET /v1/sessions/{id}/logs`: one page of a Session's engine or Gateway log. */
export const sessionLogsSchema = z.object({
  source: z.enum(["engine", "gateway"]),
  file: z.string(),
  exists: z.boolean(),
  records: z.array(logRecordSchema),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
  skipped: z.number().int().nonnegative(),
});
export type LogRecord = z.infer<typeof logRecordSchema>;
export type SessionLogs = z.infer<typeof sessionLogsSchema>;
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;
export type HarnessModelView = z.infer<typeof harnessModelViewSchema>;
export type HarnessModelTest = z.infer<typeof harnessModelTestSchema>;
export type ToolPackRecord = z.infer<typeof toolPackRecordSchema>;
export type ToolPackEngineResult = z.infer<typeof toolPackEngineResultSchema>;
export type ToolPackApply = z.infer<typeof toolPackApplySchema>;
export type ToolPackImport = z.infer<typeof toolPackImportSchema>;
export type ModelCall = z.infer<typeof modelCallSchema>;
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
