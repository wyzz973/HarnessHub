// SPDX-License-Identifier: MIT
/**
 * Contracts of `POST /api/v1/providers/{id}/test` and `/doctor`
 * (03 section 9): the checks the doctor runs against a provider's upstream,
 * their results, the plan shown before anything is sent, and the report.
 * The daemon runs the checks; the CLI and SDK read these types.
 */
import type { WireProtocol } from "./model-plane.js";

/** The doctor's checks, in the order they run and are reported. */
export const doctorChecks = [
  "endpoints",
  "auth",
  "models",
  "streaming",
  "usage",
  "max-tokens",
  "tools",
  "reasoning-replay",
  "optional-fields",
  "image",
  "native-endpoints",
  "served-model",
  "latency",
  "context-overflow",
] as const;
export type DoctorCheck = (typeof doctorChecks)[number];

/** `skip`: the check does not apply or could not run; `summary` says why. */
export type DoctorStatus = "pass" | "warn" | "fail" | "skip";

/** One check's outcome. Every text is redacted; excerpts are at most 500 characters. */
export interface DoctorItem {
  check: DoctorCheck;
  status: DoctorStatus;
  /** One line. */
  summary: string;
  /** Observations, one per line (requests, statuses, URLs, values). */
  details: string[];
  /** The upstream's error message of the failing request, redacted. */
  excerpt?: string;
  /** HTTP status of the failing request, when there was one. */
  httpStatus?: number;
  /** The request URL of the failing request (never with a key). */
  url?: string;
  /** Commands that fix or work around the problem, ready to run. */
  suggestions: string[];
  /**
   * The part of the proposed provider change (a JSON Merge Patch of
   * `PATCH /providers/{id}`) that this item contributes.
   */
  patch?: Record<string, unknown>;
  /** Measured values, e.g. latency medians in ms. */
  values?: Record<string, number>;
}

/** What a doctor run will send, shown before it runs (`dryRun`). */
export interface DoctorPlan {
  provider: string;
  model: string;
  wireModel: string;
  /** The endpoint most checks use: chat, else responses, anthropic, gemini. */
  protocol: WireProtocol;
  deep: boolean;
  /** Model calls when every check runs to its end. */
  modelCalls: number;
  /** Model calls at most, with the retries a failure may add. */
  maxModelCalls: number;
  /** Model list requests (not billed, not in the ledger). */
  listRequests: number;
  /** Input and output tokens estimated for `modelCalls`. */
  estimatedTokens: { input: number; output: number };
  /** null when the model has no known price. */
  estimatedCostUsd: number | null;
  checks: Array<{ check: DoctorCheck; modelCalls: number }>;
}

/** `POST /providers/{id}/doctor` without `dryRun`. */
export interface DoctorReport {
  plan: DoctorPlan;
  startedAt: string;
  durationMs: number;
  /** Model calls sent; each is a `model.call` entry of scope `client:doctor`. */
  modelCalls: number;
  /** The sum of the calls' known costs; `unpricedCalls` had none. */
  costUsd: number;
  unpricedCalls: number;
  items: DoctorItem[];
  /** All items' patches merged; absent when nothing is proposed. */
  patch?: Record<string, unknown>;
}

/** One endpoint of `POST /providers/{id}/test`. */
export interface EndpointTest {
  protocol: WireProtocol;
  url: string;
  ok: boolean;
  /** 0 when no response arrived. */
  status: number;
  durationMs: number;
  firstByteMs?: number;
  servedModel?: string;
  /** Redacted. */
  error?: string;
}

/** `POST /providers/{id}/test`: one tiny request per declared endpoint. */
export interface ProviderTestReport {
  provider: string;
  model: string;
  wireModel: string;
  endpoints: EndpointTest[];
  modelCalls: number;
  costUsd: number;
  unpricedCalls: number;
}
