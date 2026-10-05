// SPDX-License-Identifier: MIT
/**
 * Typed client of the daemon's `/api/v1` model-plane API (06-interfaces
 * section 4). It runs anywhere `fetch` exists; local token discovery is in
 * `@harnesshub/sdk/local`, which needs Node.
 */
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type {
  CatalogStatus,
  MetadataField,
  ModelOverride,
  OverrideValues,
  ResolvedField,
} from "@harnesshub/core/model-metadata";
import type { ProviderPreset } from "@harnesshub/core/provider-presets";
import type { AutoGroup } from "@harnesshub/core/auto-groups";
import type {
  CopilotAuth,
  SubscriptionBackend,
  SubscriptionNotice,
} from "@harnesshub/core/subscriptions";
import type {
  RedactionRule,
  RedactionSettings,
  SearchBackendKind,
} from "@harnesshub/core/gateway-features";
import type {
  ImportApp,
  ImportPreview,
  ImportResult,
} from "@harnesshub/core/import-links";
import type {
  DoctorPlan,
  DoctorReport,
  ProviderTestReport,
} from "@harnesshub/core/provider-doctor";
import type {
  AllowanceReading,
  BudgetPeriod,
  ConversationSummary,
  GatewayKeyQuota,
  GatewayKeyView,
  GroupRule,
  ModelCallEntry,
  ProviderConfig,
  ProviderCredential,
  ReasoningEffort,
  RetryPolicy,
  RouteDecisionPage,
  RouteDecisionQuery,
  RouteGroup,
  UsageGroupBy,
  WireProtocol,
  WiringChoice,
  WiringProfile,
  WiringTier,
} from "@harnesshub/core/model-plane";

/** Record types of the API, re-exported so clients need no other package. */
export type {
  AllowanceReading,
  BudgetPeriod,
  GatewayKeyBudget,
  GatewayKeyQuota,
  GatewayKeyScope,
  GatewayKeyView,
  GroupRule,
  ProviderConfig,
  ProviderCredential,
  ProviderKind,
  ProviderModel,
  ReasoningEffort,
  RouteDecision,
  RouteDecisionCandidate,
  RouteDecisionPage,
  RouteDecisionQuery,
  RouteDecisionRule,
  RouteGroup,
  RouteStrategy,
  RuleEffort,
  RuleTimeWindow,
  Weekday,
  Stickiness,
  UsageGroupBy,
  WireProtocol,
  WiringChoice,
  WiringProfile,
  WiringTier,
} from "@harnesshub/core/model-plane";
export type { SecretReference } from "@harnesshub/core/engine-configuration";
export type {
  PresetHeaderHint,
  PresetPlan,
  PresetRegion,
  ProviderPreset,
} from "@harnesshub/core/provider-presets";
export type {
  ImportApp,
  ImportItem,
  ImportPreview,
  ImportResult,
} from "@harnesshub/core/import-links";
export type {
  DoctorCheck,
  DoctorItem,
  DoctorPlan,
  DoctorReport,
  DoctorStatus,
  EndpointTest,
  ProviderTestReport,
} from "@harnesshub/core/provider-doctor";
export type { AutoGroup } from "@harnesshub/core/auto-groups";
export type {
  RedactionRule,
  RedactionSettings,
  SearchBackendKind,
} from "@harnesshub/core/gateway-features";
export type {
  CopilotAccount,
  CopilotAuth,
  SiwcAccount,
  SubscriptionAccount,
  SubscriptionBackend,
  SubscriptionNotice,
} from "@harnesshub/core/subscriptions";

/** `GET /subscriptions/notices`: the risk notice an account must accept, per backend. */
export interface SubscriptionNoticeView extends SubscriptionNotice {
  backend: SubscriptionBackend;
}

/** `/subscriptions/sign-in`: one sign-in attempt. */
export interface SignInView {
  id: string;
  backend: SubscriptionBackend;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  provider: string;
  /** ChatGPT: open in the system browser to continue with the vendor. */
  authorizeUrl?: string;
  /** ChatGPT: when the attempt stops waiting. */
  expiresAt?: string;
  credential?: string;
  email?: string;
  /** Copilot: the GitHub login. */
  login?: string;
  firstSignIn?: boolean;
  error?: string;
}

/** `GET /subscriptions/accounts`: one account, without its tokens. */
export interface SubscriptionAccountView {
  provider: string;
  credential: string;
  backend: SubscriptionBackend;
  email?: string;
  /** Copilot: the GitHub login and how the account signs in. */
  login?: string;
  auth?: CopilotAuth;
  enabled: boolean;
  signedIn: boolean;
  noticeAccepted: boolean;
  acceptedAt: string;
  usable: boolean;
}

/** `GET /subscriptions/copilot/setup`: the Copilot SDK add-on and CLI. */
export interface CopilotSetupView {
  sdkDirectory: string;
  /** Absent when the SDK is not installed. */
  sdkVersion?: string;
  supportedSdkVersion: string;
  /** Absent when no Copilot CLI was found. */
  cliPath?: string;
  /** Installs the supported SDK without its platform runtimes. */
  installCommand: string;
}
export type {
  CatalogMeta,
  CatalogStatus,
  MetadataField,
  MetadataSource,
  Modality,
  ModelOverride,
  OverrideValues,
  ResolvedField,
} from "@harnesshub/core/model-metadata";

/** One `errors[]` entry of a problem: a body member or a query parameter. */
export interface ProblemItem {
  pointer?: string;
  parameter?: string;
  detail: string;
}

/** RFC 9457 problem details as `/api/v1` sends them. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId: string;
  errors?: ProblemItem[];
  references?: Array<{ type: string; id: string }>;
}

/** The daemon answered with an error; `code` is stable within v1, unknown codes included. */
export class HarnessHubError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "HarnessHubError";
    this.status = problem.status;
    this.code = problem.code;
    this.requestId = problem.requestId;
    this.problem = problem;
  }
}

/** The daemon could not be reached (connection refused, reset or timed out). */
export class HarnessHubUnavailableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`The HarnessHub daemon at ${url} is not reachable`, { cause });
    this.name = "HarnessHubUnavailableError";
  }
}

export interface ClientOptions {
  /**
   * Daemon origin, e.g. `http://127.0.0.1:3180`, or a base whose path ends
   * with `/`, e.g. `http://127.0.0.1:3330/` of a development proxy: requests
   * go to `<base>api/v1/...`.
   */
  url: string | URL;
  /**
   * The local admin token (`<dataDir>/admin.token`), sent as
   * `Authorization: Bearer`. Omit it in a page served by the daemon, which
   * authenticates with its console session instead (`csrfToken`).
   */
  token?: string;
  /**
   * The token of a console session (`auth.createConsoleSession` returns
   * it, once), sent as `X-HH-CSRF` with every request. The daemon also
   * needs the browser's HttpOnly `hh_console` cookie, which a page served
   * by the daemon sends with every same-origin request; either part alone
   * is refused with 401 `CONSOLE_SESSION_INVALID`.
   */
  csrfToken?: string;
  /** Replaces the global `fetch`, e.g. in tests. */
  fetch?: typeof fetch;
}

/** `POST /auth/console-links`: a one-time console login code. */
export interface ConsoleLink {
  /** 128 random bits, base64url; valid once, until `expiresAt`. */
  code: string;
  expiresAt: string;
}

/** A console session's times (`GET /auth/console-sessions/current`). */
export interface ConsoleSessionStatus {
  /** The session ends at this time whatever its use (7 days after creation). */
  expiresAt: string;
  /** The session ends at this time unless it is used before (12 hours idle). */
  idleExpiresAt: string;
}

/**
 * A new console session for one tab (`POST /auth/console-sessions`). The
 * browser's part is the HttpOnly cookie and never appears here.
 */
export interface ConsoleSession extends ConsoleSessionStatus {
  /**
   * The tab's token, sent as `X-HH-CSRF` with every request (`csrfToken`
   * option); returned only by this call, so keep it with the tab.
   */
  csrfToken: string;
}

/** `POST /providers`; credentials are added with `credentials.add`. */
/** Provider fields a client may set; the daemon fills the rest. */
export interface ProviderFields {
  name?: string;
  /** models.dev provider ID for metadata, replacing the preset's. */
  catalog?: string;
  kind?: ProviderConfig["kind"];
  endpoints?: ProviderConfig["endpoints"];
  auth?: ProviderConfig["auth"];
  headers?: Record<string, string>;
  models?: ProviderConfig["models"];
  wire?: Record<string, string>;
  patches?: ProviderConfig["patches"];
  capabilities?: ProviderConfig["capabilities"];
  translateOnly?: boolean;
  /** Base URL of the provider's OpenAI-compatible Images API (`/v1/images/generations` goes there). */
  imageEndpoint?: string;
  /** This provider's own proxy: `direct`, or a proxy address without credentials; absent follows the daemon's. */
  proxy?: string;
  /** Requests out at once and waiting on each credential; absent follows the gateway's limits. */
  limits?: { concurrentPerCredential?: number; queuePerCredential?: number };
}

/** A value to store, or an `env` or `file` reference. */
export type CredentialSource =
  | { value: string; ref?: never }
  | { ref: SecretReference & { kind: "env" | "file" }; value?: never };

/** `POST /providers/{id}/credentials`. */
export type CredentialInput = {
  id?: string;
  name: string;
  protocols?: WireProtocol[];
  enabled?: boolean;
} & CredentialSource;

/**
 * `POST /providers`: from a preset (`id` defaults to the preset's; `region`
 * and `plan` default to its first; other fields override it, endpoints by
 * protocol) or from scratch (`id` and `endpoints`). `credential` adds the
 * first credential (name `default`).
 */
export type ProviderInput = ProviderFields & {
  credential?: Omit<CredentialInput, "name"> & { name?: string };
} & (
    | { preset: string; id?: string; region?: string; plan?: string }
    | {
        preset?: never;
        id: string;
        endpoints: ProviderConfig["endpoints"];
      }
  );

/** JSON Merge Patch of a provider: `null` removes an optional member. */
export type ProviderPatch = {
  [K in Exclude<keyof ProviderFields, "limits">]?: ProviderFields[K] | null;
} & {
  /** null removes both; a member set to null removes that one. */
  limits?: {
    concurrentPerCredential?: number | null;
    queuePerCredential?: number | null;
  } | null;
} & {
  /** null detaches the provider from its preset. */
  preset?: null;
};

export interface RouteGroupInput {
  id: string;
  members: string[];
  strategy?: RouteGroup["strategy"];
  stickiness?: RouteGroup["stickiness"];
  retry?: Partial<RetryPolicy>;
  /** Checked in order as a turn begins; the first that matches puts its member first. */
  rules?: GroupRule[];
  /** The model or group that tells which intent a message is. */
  classifier?: string;
  effort?: "auto";
}

/** Fields to change; null removes `retry`, `rules`, `classifier` or `effort`. */
export interface RouteGroupPatch {
  members?: string[];
  strategy?: RouteGroup["strategy"];
  stickiness?: RouteGroup["stickiness"];
  retry?: Partial<RetryPolicy> | null;
  rules?: GroupRule[] | null;
  classifier?: string | null;
  effort?: "auto" | null;
}

export interface GatewayKeyInput {
  name: string;
  /** Model Refs, `provider/*` and `group/<id>`; at least one. */
  modelAllow: string[];
  quota?: GatewayKeyQuota;
  /** Usable on the daemon's LAN sharing listener; such a key must expire. */
  allowLan?: boolean;
  /** Absent: 90 days from now; null: never expires. */
  expiresAt?: string | null;
}

/** One budget of a key as it stands (`GET /gateway-keys/{id}/limit`). */
export interface KeyBudgetStatus {
  period: BudgetPeriod;
  /** The calendar window's start and the next one's (ISO 8601), in the daemon's local time zone. */
  start: string;
  resetsAt: string;
  /** Answered calls in the window. */
  calls: number;
  /** Tokens as the budget counts them. */
  tokens: number;
  costUsd: number;
  tokenLimit?: number;
  costLimitUsd?: number;
  cacheReads: boolean;
  tokensLeft?: number;
  costLeftUsd?: number;
  /** Requests in flight and what they hold in reservations. */
  inFlight: number;
  reservedTokens: number;
  reservedCostUsd: number;
  /** A cap is reached: the key is refused until `resetsAt`. */
  spent: boolean;
}

/** `GET /gateway-keys/{id}/limit`: a key's limits and what it used of them. */
export interface GatewayKeyLimit {
  keyId: string;
  name: string;
  /** The IANA time zone the windows are in. */
  timeZone: string;
  requestsPerMinute?: number;
  budgets: KeyBudgetStatus[];
}

/** LAN sharing settings: the body of `PUT /gateway/share`. */
export interface GatewayShareSettings {
  lan: {
    enabled: boolean;
    /** IP address to bind; `0.0.0.0` or `::` for every address. Required while enabled. */
    host?: string;
    /** Absent: the daemon's port. */
    port?: number;
    /** Further Host names peers use. */
    names?: string[];
  };
  /** The address clients use behind a reverse proxy. */
  publicBaseUrl?: string;
}

/** `GET /gateway/share`: the settings and the LAN listener's state. */
export interface GatewayShareStatus {
  lan: GatewayShareSettings["lan"] & { names: string[] };
  publicBaseUrl?: string;
  listening: boolean;
  boundPort?: number;
  /** Base URLs a peer configures, e.g. for the `harnesshub-remote` preset. */
  urls: string[];
  /** Why the listener is not serving although sharing is enabled. */
  error?: string;
}

/** `GET /gateway/features`: redaction, the vision model and search backends, without keys. */
export interface GatewayFeaturesView {
  schemaVersion: 1;
  redaction: RedactionSettings;
  vision?: { model: string };
  search?: {
    backends: {
      id: string;
      kind: SearchBackendKind;
      baseUrl?: string;
      hasKey: boolean;
    }[];
  };
}

/**
 * `GET /routing/state`: one credential's routing state as the gateway holds
 * it in memory (it starts empty after a daemon restart; readings persist).
 */
export interface CredentialRoutingState {
  provider: string;
  credential: string;
  credentialName: string;
  enabled: boolean;
  /** `open`: resting until `restingUntil`; `half-open`: the next request probes it. */
  state: "closed" | "open" | "half-open";
  restingUntil?: string;
  /** The last counted failure: its class (`rate_limited`, `quota_exhausted`, `auth_failed`, …), HTTP status and time. */
  lastFailure?: { kind: string; status: number; at: string };
  /** The latest reading of each allowance window (`smart` and `pace` use them). */
  readings: AllowanceReading[];
}

/** `POST /gateway-keys`: `key` is the key text, returned only by this call. */
export interface CreatedGatewayKey {
  key: string;
  gatewayKey: GatewayKeyView;
}

/** A USD amount as a decimal string. */
export interface Money {
  amount: string;
  currency: "USD";
}

/** A ledger entry as the API returns it: the cost as a decimal string. */
export type ApiModelCall = Omit<ModelCallEntry, "cost"> & {
  cost: (Money & { priceSource: string }) | null;
};

export interface CallFilter {
  /** Inclusive RFC 3339 time. */
  from?: string;
  /** Exclusive RFC 3339 time. */
  to?: string;
  keyId?: string;
  provider?: string;
  /** A Model Ref. */
  model?: string;
  sessionId?: string;
  /** `agent.id` of the call, established or inferred. */
  agent?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UsageBucketView {
  /** Empty for calls without the grouped attribute. */
  key: string;
  calls: number;
  failedCalls: number;
  usage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  };
  /** Sum of known costs; `unpricedCalls` had none. */
  cost: Money;
  unpricedCalls: number;
}

export interface UsageReport {
  groupBy: UsageGroupBy;
  items: UsageBucketView[];
}

/** One conversation's calls summed, as `GET /conversations` returns it. */
export type ConversationView = Omit<ConversationSummary, "costUsd"> & {
  /** Sum of known costs; `unpricedCalls` had none. */
  cost: Money;
};

export interface SystemInfo {
  apiVersion: "v1";
  version: string;
  commit: string;
  pid: number;
  startedAt: string;
  dataDir: string;
  secretBackend: "keychain" | "dpapi" | "file";
  /** The model gateway's base URLs for local clients; null before the daemon listens. */
  gateway: {
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    geminiBaseUrl: string;
  } | null;
  /**
   * The proxy of the daemon's own outbound requests, fixed when it started:
   * `proxy` with any password shown as `***` (null: direct), the hosts that
   * bypass it, and where `network.proxy` came from (null: not set).
   */
  network: {
    proxy: string | null;
    noProxy: string[];
    source: "flag" | "env" | "file" | null;
  };
}

/**
 * One model's metadata (03-model-plane section 7): each known field with its
 * value, source and time; fields no source knows are listed in `unknown` and
 * never defaulted.
 */
export interface ModelMetadataView {
  /** `provider/model`. */
  ref: string;
  /** Whether the provider's model list has this model. */
  listed: boolean;
  fields: Partial<Record<MetadataField, ResolvedField>>;
  unknown: MetadataField[];
  /** The stored `provider/*` override and this model's, if any. */
  overrides: ModelOverride[];
}

/** How an agent is detected: a command on PATH or only its configuration directory. */
export interface AgentInstallation {
  status: "installed" | "configured-only" | "not-found";
  executable?: string;
  configDirectories: string[];
}

/** File drift of a wired agent (04-agent-plane section 5). */
export type AgentDriftKind = "unwired" | "replaced" | "foreign-gateway";

export interface AgentDriftFinding {
  path: string;
  keyPath: string[];
  kind: AgentDriftKind;
  reason: "missing" | "changed" | "other-key" | "file-missing" | "unreadable";
}

export interface AgentWiring extends WiringChoice {
  /** The models the agent lists and its key may use; models added to the gateway later are included. */
  models: string[];
  /** Models hidden from the agent. */
  hidden: string[];
  /** Absent for an agent that signs in by itself (Codex with `codexAuth: chatgpt`). */
  keyId?: string;
  /** Why the last catalog sync left the agent's files as they were. */
  attention?: { code: string; message: string; at: string };
  keyState: "active" | "revoked" | "expired" | "missing" | "none";
  wiredAt: string;
  files: string[];
  drift: {
    drifted: boolean;
    kinds: AgentDriftKind[];
    findings: AgentDriftFinding[];
  } | null;
  driftError?: string;
}

/** `GET /agents` item. */
export interface Agent {
  id: string;
  name: string;
  protocol: WireProtocol;
  keyDelivery: "config-file" | "env-file";
  /** What wiring can set besides the model: tiers, start effort, and option values (default first). */
  capabilities: {
    tiers: WiringTier[];
    efforts: ReasoningEffort[];
    options: Record<string, string[]>;
    /**
     * The option values (one of every option) with which the agent keeps
     * its own model unless one is named (`model: null`), such as Codex with
     * `{codexAuth: "chatgpt"}`; empty when it always takes a model.
     */
    ownModel: Array<Record<string, string>>;
  };
  installation: AgentInstallation;
  wiring: AgentWiring | null;
}

/** One file of a wiring plan; Gateway Keys in `diff` and `changes` are masked. */
export interface AgentPlanFile {
  id: string;
  path: string;
  format: "json" | "toml" | "yaml" | "dotenv";
  exists: boolean;
  hash?: string;
  changes: Array<{
    keyPath: string[];
    op: "set" | "remove";
    before?: string;
    after?: string;
  }>;
  diff: string;
}

/** `POST /agents/{id}/wiring/plan`. Pass it back as `expect` to apply exactly what was shown. */
export interface AgentWiringPlan {
  adapterId: string;
  protocol: WireProtocol;
  keyDelivery: "config-file" | "env-file";
  /** Absent for an agent that keeps its own models. */
  model?: string;
  keyId?: string;
  changed: boolean;
  files: AgentPlanFile[];
}

/**
 * What to wire an agent to; an absent field keeps the current value. An
 * agent that signs in by itself (`options: {codexAuth: "chatgpt"}`) takes
 * no model, models, tiers or effort.
 */
export interface AgentWiringInput {
  /** null: none, for an agent that keeps its own model (Codex with `codexAuth: chatgpt`). */
  model?: string | null;
  /** Models the agent may list: `provider/model`, `provider/*`, `group/<id>` or `*`; default: the current list, else `*`. */
  models?: string[];
  /** A model per tier in `capabilities.tiers`; `{}` clears them. */
  tiers?: Partial<Record<WiringTier, string>>;
  /** One of `capabilities.efforts`; null clears it. */
  effort?: ReasoningEffort | null;
  /** Values from `capabilities.options`, such as `{codexAuth: "chatgpt"}`. */
  options?: Record<string, string>;
}

/** `POST /profiles/{name}/plan`. */
export interface ProfilePlan {
  profile: WiringProfile;
  /** Agents whose choices differ have a plan; pass the plans back as `expect`. */
  agents: Array<{
    adapterId: string;
    changed: boolean;
    plan: AgentWiringPlan | null;
  }>;
}

/** `POST /profiles/{name}/apply`. */
export interface ProfileApplied {
  profile: WiringProfile;
  agents: Array<{
    adapterId: string;
    outcome: "applied" | "unchanged";
    agent: Agent;
  }>;
}

/** `DELETE /agents/{id}/wiring`. */
export interface AgentUnwired {
  agent: Agent;
  files: Array<{
    path: string;
    action: "restored" | "deleted" | "reverse-patched" | "unchanged" | "absent";
  }>;
}

/** `POST /backup`: the sealed file as JSON; write it out as it is. */
export interface BackupEnvelope {
  format: "harnesshub-backup";
  version: number;
  kdf: string;
  iterations: number;
  salt: string;
  nonce: string;
  data: string;
}

/** `POST /restore`: what the restore does (`dryRun`) or did. */
export interface RestoreSummary {
  createdAt: string;
  app: string;
  /** The backup carries credential values. */
  keys: boolean;
  providers: {
    added: string[];
    replaced: string[];
    needKey: string[];
    /** Subscription providers of an older backup: not restored; sign in again on this machine. */
    signInAgain: string[];
    /** The backup's providers whose ID is a subscription provider here, which is kept. */
    signedInHere: string[];
  };
  groups: { added: string[]; replaced: string[]; skipped: string[] };
  overrides: number;
  profiles: { added: string[]; replaced: string[] };
  /** The Library's items brought in; null when the backup has none or `library` is false. */
  library: {
    instructions: { added: string[]; replaced: string[]; removed: string[] };
    mcp: {
      added: string[];
      replaced: string[];
      removed: string[];
      /** `server: NAME`: stored secrets with no value in the backup or here; left out. */
      needSecret: string[];
    };
    skills: {
      added: string[];
      replaced: string[];
      removed: string[];
      /** Brought in without files left out of the backup (over 2 MiB). */
      incomplete: string[];
    };
    refused: Array<{
      kind: "instructions" | "mcp" | "skills";
      name: string;
      reason: string;
    }>;
  } | null;
  /** Redaction, the vision model and the search backends; null when the backup has none. */
  gatewayFeatures: {
    redaction: {
      /** Outbound redaction after the restore. */
      enabled: boolean;
      /** On here and the backup turns it off: a security change to show. */
      turnsOff: boolean;
      turnsOn: boolean;
    };
    /** Redaction rules by name. */
    rules: { added: string[]; replaced: string[]; removed: string[] };
    vision: {
      model: string;
      changed: boolean;
      /** Why the model or group is not here after the restore; it is set all the same. */
      unresolved?: string;
    } | null;
    /** Search backends as `kind` or `kind baseUrl`. */
    search: {
      added: string[];
      replaced: string[];
      removed: string[];
      /** No key in the backup or here: not brought in. */
      needKey: string[];
    };
  } | null;
  gatewayShare: {
    action: "apply" | "unchanged" | "absent" | "unavailable";
    settings?: GatewayShareSettings;
    error?: string;
  };
  catalog: {
    backup: { autoRefresh: boolean; url: string };
    current: { autoRefresh: boolean; url: string };
    differs: boolean;
  } | null;
  agents: Array<{
    agent: string;
    /** Absent for an agent that signs in by itself (Codex with ChatGPT). */
    model?: string;
    /** The models it may list (`*` for every model). */
    models: string[];
    /** The models hidden from it. */
    deny?: string[];
    tiers?: Record<string, string>;
    effort?: string;
    options?: Record<string, string>;
    action:
      | "wire"
      | "unchanged"
      | "skip-disabled"
      | "skip-not-installed"
      | "skip-unknown"
      | "skip-unavailable";
    outcome?: "wired" | "failed";
    error?: string;
  }>;
  /** Client keys to issue again: key text is never in a backup. */
  clientKeys: Array<{
    name: string;
    modelAllow: string[];
    allowLan: boolean;
    quota?: GatewayKeyQuota;
    expiresAt?: string;
  }>;
}

/** The body of `PUT /sync`. */
export interface SyncSettings {
  kind: "webdav" | "s3";
  /** `https://…` for WebDAV; `s3://bucket` or `s3://bucket/prefix` for S3. */
  url: string;
  /** The WebDAV user, or the S3 access key ID. */
  user?: string;
  /** The WebDAV password or the S3 secret access key; omitted keeps the stored one for the same target. */
  secret?: string;
  /** Seals the server copy; omitted keeps the stored one. */
  passphrase?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  keys?: boolean;
  agents?: boolean;
}

/** `GET /sync`. */
export interface SyncStatus {
  enabled: boolean;
  kind?: "webdav" | "s3";
  url?: string;
  user?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  keys?: boolean;
  agents?: boolean;
  intervalMs: number;
  lastSyncAt?: string;
  lastError?: string;
  nextSyncAt?: string;
  notice?: {
    at: string;
    here: Array<"providers" | "agents" | "profiles" | "library" | "features">;
    there: Array<"providers" | "agents" | "profiles" | "library" | "features">;
    saved?: string;
    kept?: string[];
    /** The server's gateway features turned outbound redaction off here. */
    redactionOff?: true;
    /** Search backends the server carries without a key and this machine has none for. */
    needKey?: string[];
  };
  secretBackend: "keychain" | "dpapi" | "file";
  warnings?: string[];
}

/** The agents the Library writes into. */
export type LibraryAgent =
  | "claude"
  | "codex"
  | "gemini"
  | "qwen"
  | "opencode"
  | "pi"
  | "crush"
  | "kimi"
  | "hermes";

/** `GET /library/instructions/{id}`: a Markdown instruction set; an agent gets one. */
export interface LibraryInstructionSet {
  id: string;
  name: string;
  sha256: string;
  size: number;
  agents: LibraryAgent[];
  /** On single-item responses. */
  text?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryInstructionInput {
  name?: string;
  text: string;
  agents?: LibraryAgent[];
}

/** A secret of an MCP server as stored: a reference, never a value. */
export interface LibrarySecretRef {
  kind: "env" | "file" | "store";
  value: string;
}

/**
 * A secret as given: a reference (`store` only for one the server already
 * holds), or `{secret}`, a value the daemon puts in its secret store.
 */
export type LibrarySecretInput = LibrarySecretRef | { secret: string };

/** `GET /library/mcp/{name}`. */
export interface LibraryMcpServer {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, LibrarySecretRef>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, LibrarySecretRef>;
  agents: LibraryAgent[];
  createdAt: string;
  updatedAt: string;
}

export interface LibraryMcpInput {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  secretEnv?: Record<string, LibrarySecretInput>;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, LibrarySecretInput>;
  agents?: LibraryAgent[];
}

/** `GET /library/skills/{name}`: an Agent Skill, kept by content. */
export interface LibrarySkill {
  name: string;
  description: string;
  /** The stored version. */
  sha256: string;
  files: number;
  size: number;
  agents: LibraryAgent[];
  createdAt: string;
  updatedAt: string;
}

/** What to sync; `agents` default to every Library agent. */
export interface LibrarySyncInput {
  agents?: LibraryAgent[];
  /** Write values of secrets an agent cannot reference into its file. */
  allowPlaintextSecret?: boolean;
  /** `copy` copies skills instead of linking them. */
  placement?: "auto" | "copy";
}

/** `POST /library/sync/plan`. Pass it back as `expect` to apply exactly what was shown. */
export interface LibraryPlan {
  changed: boolean;
  agents: Array<{
    agent: LibraryAgent;
    name: string;
    changed: boolean;
    files: Array<{
      kind: "instructions" | "mcp";
      path: string;
      exists: boolean;
      hash?: string;
      action: "write" | "restore" | "delete" | "unchanged";
      /** Secret values written as plain text show as `<secret>`. */
      diff: string;
    }>;
    skills: Array<{
      name: string;
      path: string;
      action: "place" | "replace" | "remove" | "unchanged";
    }>;
    /** Items assigned to the agent that are not written, and why. */
    refused: Array<{
      kind: "instructions" | "mcp" | "skills";
      name: string;
      reason: string;
    }>;
    warnings: string[];
  }>;
}

type Query = Record<string, string | number | undefined>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProblem(value: unknown): value is Problem {
  return (
    object(value) &&
    typeof value.status === "number" &&
    typeof value.code === "string" &&
    typeof value.title === "string"
  );
}

const segment = (value: string) => encodeURIComponent(value);

/**
 * Client of one daemon. Every method sends one request and resolves to the
 * decoded response; it rejects with `HarnessHubError` for an error response
 * and `HarnessHubUnavailableError` when the daemon cannot be reached. It never
 * retries: none of these operations carries an idempotency key yet.
 */
export class HarnessHubClient {
  private readonly base: URL;
  private readonly token: string | undefined;
  private readonly csrfToken: string | undefined;
  private readonly send: typeof fetch;

  constructor(options: ClientOptions) {
    const base = new URL(options.url);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new TypeError(
        "The daemon URL must be HTTP(S) without embedded credentials",
      );
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    base.search = "";
    base.hash = "";
    this.base = new URL("api/v1/", base);
    this.token = options.token;
    this.csrfToken = options.csrfToken;
    // Called unbound: browsers reject a `fetch` invoked with another `this`.
    this.send =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * One request. The response body is decoded as JSON and trusted to match
   * the documented shape of the operation, which the daemon serializes from
   * the same schemas that its OpenAPI document publishes.
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      query?: Query;
      contentType?: string;
      /** Ends the request; it then rejects with the signal's reason. */
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = new URL(path, this.base);
    for (const [name, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(name, String(value));
    let response: Response;
    try {
      response = await this.send(url, {
        method,
        headers: {
          accept: "application/json",
          ...(this.token !== undefined
            ? { authorization: `Bearer ${this.token}` }
            : {}),
          ...(this.csrfToken !== undefined
            ? { "x-hh-csrf": this.csrfToken }
            : {}),
          ...(options.body !== undefined
            ? { "content-type": options.contentType ?? "application/json" }
            : {}),
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new HarnessHubUnavailableError(this.base.origin, error);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok)
      throw new HarnessHubError(
        isProblem(body)
          ? body
          : {
              type: "about:blank",
              title: response.statusText || "Error",
              status: response.status,
              code: "UNEXPECTED_RESPONSE",
              requestId: "",
            },
      );
    if (body === undefined)
      throw new HarnessHubError({
        type: "about:blank",
        title: "Invalid response",
        status: response.status,
        code: "UNEXPECTED_RESPONSE",
        requestId: "",
        detail: "The daemon answered without a JSON body",
      });
    return body as T;
  }

  readonly system = {
    info: () => this.request<SystemInfo>("GET", "system/info"),
  };

  /**
   * Console sign-in (07-data-security section 5.2). `createConsoleLink`
   * needs the admin token; the page opened with `/#login=<code>` exchanges
   * the code once with `createConsoleSession`, which sets the session cookie.
   * An unknown, used or expired code is 401 `CONSOLE_LINK_INVALID`; an ended
   * or signed-out session is 401 `CONSOLE_SESSION_INVALID`, and a request
   * without any credential 401 `ADMIN_TOKEN_REQUIRED`.
   */
  readonly auth = {
    createConsoleLink: () =>
      this.request<ConsoleLink>("POST", "auth/console-links", { body: {} }),
    createConsoleSession: (code: string) =>
      this.request<ConsoleSession>("POST", "auth/console-sessions", {
        body: { code },
      }),
    /** The session of this client's token and cookie; it never returns the token. */
    currentConsoleSession: () =>
      this.request<ConsoleSessionStatus>(
        "GET",
        "auth/console-sessions/current",
      ),
    /** Signs this tab out: its session ends at once; the cookie is cleared when no other tab's session uses it. */
    deleteConsoleSession: () =>
      this.request<void>("DELETE", "auth/console-sessions/current"),
  };

  readonly providers = {
    list: () => this.request<Page<ProviderConfig>>("GET", "providers"),
    get: (id: string) =>
      this.request<ProviderConfig>("GET", `providers/${segment(id)}`),
    create: (input: ProviderInput) =>
      this.request<ProviderConfig>("POST", "providers", { body: input }),
    update: (id: string, patch: ProviderPatch) =>
      this.request<ProviderConfig>("PATCH", `providers/${segment(id)}`, {
        body: patch,
        contentType: "application/merge-patch+json",
      }),
    remove: (id: string) =>
      this.request<void>("DELETE", `providers/${segment(id)}`),
    /**
     * List the provider's models from its upstream with its first enabled
     * credential and store them. On failure the daemon keeps the previous
     * list, marks it stale and rejects (`MODELS_REFRESH_FAILED`, 502, or
     * `CREDENTIAL_UNAVAILABLE`, 409).
     */
    refreshModels: (id: string) =>
      this.request<ProviderConfig>(
        "POST",
        `providers/${segment(id)}/models/refresh`,
        { body: {} },
      ),
    /**
     * One minimal request per declared endpoint, recorded in the ledger
     * under `client:doctor`: status, latency and served model of each.
     */
    test: (id: string, options: { model?: string } = {}) =>
      this.request<ProviderTestReport>(
        "POST",
        `providers/${segment(id)}/test`,
        { body: options },
      ),
    /**
     * The checks of 03 section 9 against the provider's upstream (real,
     * billed requests under `client:doctor`); `dryRun` returns only the plan
     * (model calls and estimated cost) and sends nothing. The report's
     * `patch` is a proposal for `update`; the doctor changes nothing.
     */
    doctor: (
      id: string,
      options: {
        model?: string;
        deep?: boolean;
        slowMs?: number;
        dryRun?: boolean;
      } = {},
    ) =>
      this.request<Partial<DoctorReport> & { plan: DoctorPlan }>(
        "POST",
        `providers/${segment(id)}/doctor`,
        { body: options },
      ),
    /** The metadata of every listed model, with sources. */
    models: (id: string) =>
      this.request<Page<ModelMetadataView>>(
        "GET",
        `providers/${segment(id)}/models`,
      ),
  };

  /** Model metadata and user overrides, by Model Ref (`provider/model`, or `provider/*` for overrides). */
  readonly models = {
    get: (ref: string) =>
      this.request<ModelMetadataView>("GET", `models/${segment(ref)}`),
    /** The stored override of `ref`; `MODEL_OVERRIDE_NOT_FOUND` (404) when there is none. */
    getOverride: (ref: string) =>
      this.request<ModelOverride>("GET", `models/${segment(ref)}/overrides`),
    /**
     * Replace the override of `ref` as a whole; the daemon resolves the
     * provider's models again, so the gateway uses the new values (prices
     * for costs) from the next call.
     */
    setOverride: (ref: string, values: OverrideValues) =>
      this.request<ModelOverride>("PUT", `models/${segment(ref)}/overrides`, {
        body: values,
      }),
    /** Remove the override; its values fall back to the next source. */
    removeOverride: (ref: string) =>
      this.request<void>("DELETE", `models/${segment(ref)}/overrides`),
  };

  readonly catalog = {
    /** The catalog in use (bundled snapshot or refreshed copy) and its refresh. */
    status: () => this.request<CatalogStatus>("GET", "catalog"),
    /**
     * Fetch the catalog now, even with background refresh off; providers'
     * metadata is updated when it changed. A failure
     * (`CATALOG_REFRESH_FAILED`, 502) keeps the catalog in use.
     */
    refresh: () =>
      this.request<CatalogStatus>("POST", "catalog/refresh", { body: {} }),
  };

  readonly presets = {
    list: () => this.request<Page<ProviderPreset>>("GET", "presets"),
  };

  /** Import providers from a link or from another app's configuration (06 section 8). */
  readonly imports = {
    /**
     * Read an import link (`harnesshub://import?…`, `magpie://import?…` or
     * their web forms) or an app's configuration and describe the providers
     * it would create. Nothing is written; the daemon keeps the result for
     * 10 minutes under `previewId`, for one `apply`. Rejects with
     * `IMPORT_LINK_INVALID` (400) for a bad link, `IMPORT_SOURCE_UNAVAILABLE`
     * (409) when the daemon reads no home.
     */
    preview: (input: { link: string } | { app: ImportApp }) =>
      this.request<ImportPreview>("POST", "import/preview", { body: input }),
    /**
     * Create the preview's `new` providers (or those of `refs`), each as
     * `POST /providers` would; the preview cannot be used again.
     * `IMPORT_PREVIEW_NOT_FOUND` (404) once used or expired.
     */
    apply: (previewId: string, refs?: string[]) =>
      this.request<ImportResult>("POST", "import/apply", {
        body: { previewId, ...(refs ? { refs } : {}) },
      }),
  };

  readonly credentials = {
    list: (providerId: string) =>
      this.request<Page<ProviderCredential>>(
        "GET",
        `providers/${segment(providerId)}/credentials`,
      ),
    /** Stores `input.value` in the daemon's secret store; the result holds only the reference. */
    add: (providerId: string, input: CredentialInput) =>
      this.request<ProviderCredential>(
        "POST",
        `providers/${segment(providerId)}/credentials`,
        { body: input },
      ),
    /** Replaces the stored value; the reference stays the same. */
    rotate: (providerId: string, credentialId: string, value: string) =>
      this.request<ProviderCredential>(
        "PUT",
        `providers/${segment(providerId)}/credentials/${segment(credentialId)}/secret`,
        { body: { value } },
      ),
    remove: (providerId: string, credentialId: string) =>
      this.request<void>(
        "DELETE",
        `providers/${segment(providerId)}/credentials/${segment(credentialId)}`,
      ),
  };

  readonly routeGroups = {
    list: () => this.request<Page<RouteGroup>>("GET", "route-groups"),
    get: (id: string) =>
      this.request<RouteGroup>("GET", `route-groups/${segment(id)}`),
    create: (input: RouteGroupInput) =>
      this.request<RouteGroup>("POST", "route-groups", { body: input }),
    update: (id: string, patch: RouteGroupPatch) =>
      this.request<RouteGroup>("PATCH", `route-groups/${segment(id)}`, {
        body: patch,
        contentType: "application/merge-patch+json",
      }),
    remove: (id: string) =>
      this.request<void>("DELETE", `route-groups/${segment(id)}`),
  };

  readonly gatewayKeys = {
    list: () => this.request<Page<GatewayKeyView>>("GET", "gateway-keys"),
    get: (keyId: string) =>
      this.request<GatewayKeyView>("GET", `gateway-keys/${segment(keyId)}`),
    /** Creates a `client:` key; the key text is in this response only. */
    create: (input: GatewayKeyInput) =>
      this.request<CreatedGatewayKey>("POST", "gateway-keys", { body: input }),
    revoke: (keyId: string) =>
      this.request<GatewayKeyView>(
        "POST",
        `gateway-keys/${segment(keyId)}/revoke`,
        { body: {} },
      ),
    /** Replaces the key's quota; `{}` removes it. Budgets apply from the key's next request. */
    setQuota: (keyId: string, quota: GatewayKeyQuota) =>
      this.request<GatewayKeyView>(
        "PUT",
        `gateway-keys/${segment(keyId)}/quota`,
        { body: quota },
      ),
    /** What the key used of each budget now, with its requests in flight. */
    limit: (keyId: string) =>
      this.request<GatewayKeyLimit>(
        "GET",
        `gateway-keys/${segment(keyId)}/limit`,
      ),
  };

  readonly agents = {
    list: () => this.request<Page<Agent>>("GET", "agents"),
    get: (id: string) => this.request<Agent>("GET", `agents/${segment(id)}`),
    /** The file edits wiring would make; nothing is written and no key is issued. */
    plan: (id: string, input: AgentWiringInput) =>
      this.request<AgentWiringPlan>(
        "POST",
        `agents/${segment(id)}/wiring/plan`,
        { body: input },
      ),
    /**
     * Wires the agent with a new `agent:` key after checking that its files
     * are as in `expect` (409 WIRING_CONCURRENT_MODIFICATION otherwise); the
     * previous key is revoked. The key text never leaves the agent's files.
     */
    wire: (
      id: string,
      input: AgentWiringInput & {
        expect: Pick<AgentWiringPlan, "files">;
      },
    ) =>
      this.request<Agent>("POST", `agents/${segment(id)}/wiring`, {
        body: {
          ...input,
          expect: {
            files: input.expect.files.map((file) => ({
              path: file.path,
              exists: file.exists,
              ...(file.hash !== undefined ? { hash: file.hash } : {}),
            })),
          },
        },
      }),
    /** Re-wires with the same models and a new key; the old key stops working. */
    rotate: (id: string) =>
      this.request<Agent>("POST", `agents/${segment(id)}/wiring/rotate`, {
        body: {},
      }),
    /** Restores the agent's files and revokes its key. */
    unwire: (id: string) =>
      this.request<AgentUnwired>("DELETE", `agents/${segment(id)}/wiring`),
    /**
     * Hides these models from the agent and shows every other one, including
     * models added later: its key's deny list changes in place and the model
     * list in its files is rewritten with the same key.
     */
    setHidden: (id: string, hidden: string[]) =>
      this.request<Agent>("PUT", `agents/${segment(id)}/models`, {
        body: { hidden },
      }),
  };

  readonly profiles = {
    list: () => this.request<Page<WiringProfile>>("GET", "profiles"),
    get: (name: string) =>
      this.request<WiringProfile>("GET", `profiles/${segment(name)}`),
    /** Saves every wired agent's model choices under `name`, replacing a profile of that name. */
    save: (name: string) =>
      this.request<WiringProfile>("PUT", `profiles/${segment(name)}`, {
        body: {},
      }),
    remove: (name: string) =>
      this.request<void>("DELETE", `profiles/${segment(name)}`),
    /** What applying the profile would change; nothing is written. */
    plan: (name: string) =>
      this.request<ProfilePlan>("POST", `profiles/${segment(name)}/plan`, {
        body: {},
      }),
    /** Switches every changed agent as its confirmed plan in `plan` shows it. */
    apply: (name: string, plan: Pick<ProfilePlan, "agents">) =>
      this.request<ProfileApplied>("POST", `profiles/${segment(name)}/apply`, {
        body: {
          expect: Object.fromEntries(
            plan.agents
              .filter((agent) => agent.plan !== null)
              .map((agent) => [
                agent.adapterId,
                {
                  files: agent.plan!.files.map((file) => ({
                    path: file.path,
                    exists: file.exists,
                    ...(file.hash !== undefined ? { hash: file.hash } : {}),
                  })),
                },
              ]),
          ),
        },
      }),
  };

  /**
   * The Library (04 section 8): items are stored by the daemon and reach
   * agents only through `sync.apply`. A secret reference to one of
   * HarnessHub's own credentials is 400 `SECRET_REF_FORBIDDEN`.
   */
  readonly library = {
    instructions: {
      list: () =>
        this.request<Page<LibraryInstructionSet>>(
          "GET",
          "library/instructions",
        ),
      get: (id: string) =>
        this.request<LibraryInstructionSet>(
          "GET",
          `library/instructions/${segment(id)}`,
        ),
      /** 409 `LIBRARY_EXISTS` when the id is taken. */
      create: (id: string, input: LibraryInstructionInput) =>
        this.request<LibraryInstructionSet>("POST", "library/instructions", {
          body: { id, ...input },
        }),
      replace: (id: string, input: LibraryInstructionInput) =>
        this.request<LibraryInstructionSet>(
          "PUT",
          `library/instructions/${segment(id)}`,
          { body: input },
        ),
      remove: (id: string) =>
        this.request<void>("DELETE", `library/instructions/${segment(id)}`),
    },
    mcp: {
      list: () => this.request<Page<LibraryMcpServer>>("GET", "library/mcp"),
      get: (name: string) =>
        this.request<LibraryMcpServer>("GET", `library/mcp/${segment(name)}`),
      /** 409 `LIBRARY_EXISTS` when the name is taken. */
      create: (name: string, input: LibraryMcpInput) =>
        this.request<LibraryMcpServer>("POST", "library/mcp", {
          body: { name, ...input },
        }),
      replace: (name: string, input: LibraryMcpInput) =>
        this.request<LibraryMcpServer>("PUT", `library/mcp/${segment(name)}`, {
          body: input,
        }),
      /** Its store secrets are deleted with it. */
      remove: (name: string) =>
        this.request<void>("DELETE", `library/mcp/${segment(name)}`),
    },
    skills: {
      list: () => this.request<Page<LibrarySkill>>("GET", "library/skills"),
      get: (name: string) =>
        this.request<LibrarySkill>("GET", `library/skills/${segment(name)}`),
      /** Imports a skill directory on the daemon's machine (an absolute path). */
      import: (source: string, agents?: LibraryAgent[]) =>
        this.request<LibrarySkill>("POST", "library/skills", {
          body: { source, ...(agents ? { agents } : {}) },
        }),
      /**
       * Uploads a skill's files: `files` maps each path with `/` below the
       * skill directory (named `name`) to its base64 content, `exec` lists
       * the executable ones. Validated like a directory import (at most 500
       * files and 20 MiB, no path out of the directory);
       * `LIBRARY_SKILL_INVALID` (400) otherwise.
       */
      upload: (input: {
        name: string;
        files: Record<string, string>;
        exec?: string[];
        agents?: LibraryAgent[];
      }) =>
        this.request<LibrarySkill>("POST", "library/skills", { body: input }),
      setAgents: (name: string, agents: LibraryAgent[]) =>
        this.request<LibrarySkill>("PATCH", `library/skills/${segment(name)}`, {
          body: { agents },
        }),
      remove: (name: string) =>
        this.request<void>("DELETE", `library/skills/${segment(name)}`),
    },
    sync: {
      /** What syncing would change in agents' files; nothing is written. */
      plan: (input: LibrarySyncInput = {}) =>
        this.request<LibraryPlan>("POST", "library/sync/plan", {
          body: input,
        }),
      /**
       * Syncs after checking that each changed file is as in `expect`
       * (409 `LIBRARY_CONCURRENT_MODIFICATION` otherwise).
       */
      apply: (
        input: LibrarySyncInput & { expect: Pick<LibraryPlan, "agents"> },
      ) =>
        this.request<LibraryPlan>("POST", "library/sync/apply", {
          body: {
            ...input,
            expect: {
              agents: input.expect.agents.map((agent) => ({
                agent: agent.agent,
                files: agent.files.map((file) => ({
                  path: file.path,
                  exists: file.exists,
                  ...(file.hash !== undefined ? { hash: file.hash } : {}),
                })),
              })),
            },
          },
        }),
    },
  };

  readonly gatewayShare = {
    status: () => this.request<GatewayShareStatus>("GET", "gateway/share"),
    /**
     * Replace the sharing settings. Rejects with `GATEWAY_SHARE_INVALID`
     * (400) or `GATEWAY_SHARE_LISTEN_FAILED` (409); nothing changes then.
     */
    update: (settings: GatewayShareSettings) =>
      this.request<GatewayShareStatus>("PUT", "gateway/share", {
        body: settings,
      }),
  };

  readonly routing = {
    /** Every credential's breaker state, rest, last failure class and allowance readings. */
    state: () =>
      this.request<Page<CredentialRoutingState>>("GET", "routing/state"),
    /**
     * The gateway's latest routing decisions after `after` (oldest first),
     * of one conversation or Session with `session`; with `wait` (seconds,
     * at most 60) the request waits for one when there is none yet. Pass the
     * page's `seq` back as `after` to follow. `signal` ends a wait early;
     * the call then rejects with the signal's reason.
     */
    decisions: (
      query: RouteDecisionQuery = {},
      options: { signal?: AbortSignal } = {},
    ) =>
      this.request<RouteDecisionPage>("GET", "routing/decisions", {
        query: { ...query },
        ...(options.signal ? { signal: options.signal } : {}),
      }),
  };

  readonly gatewayFeatures = {
    get: () => this.request<GatewayFeaturesView>("GET", "gateway/features"),
    /** Turn outbound redaction on or off and replace the user's rules. */
    setRedaction: (input: { enabled?: boolean; rules?: RedactionRule[] }) =>
      this.request<GatewayFeaturesView>("PUT", "gateway/features/redaction", {
        body: input,
      }),
    /** The model (Model Ref or `group/<id>`) that describes images for models without image input. */
    setVision: (model: string) =>
      this.request<GatewayFeaturesView>("PUT", "gateway/features/vision", {
        body: { model },
      }),
    clearVision: () =>
      this.request<GatewayFeaturesView>("DELETE", "gateway/features/vision"),
    /** Add a web search backend; `key` goes to the daemon's secret store. */
    addSearch: (input: {
      kind: SearchBackendKind;
      key?: string;
      baseUrl?: string;
    }) =>
      this.request<GatewayFeaturesView>("POST", "gateway/features/search", {
        body: input,
      }),
    removeSearch: (id: string) =>
      this.request<GatewayFeaturesView>(
        "DELETE",
        `gateway/features/search/${segment(id)}`,
      ),
  };

  readonly backup = {
    /** Seals a backup; with `keys: false` it carries no credential values. */
    create: (input: { passphrase: string; keys?: boolean }) =>
      this.request<BackupEnvelope>("POST", "backup", { body: input }),
    /**
     * Opens `backup` and restores it, or with `dryRun` only says what it
     * would do. Rejects with `BACKUP_PASSPHRASE` (400) for a wrong passphrase
     * or a changed file.
     */
    restore: (input: {
      backup: BackupEnvelope;
      passphrase: string;
      agents?: boolean;
      /** Bring the Library's items in (default true); agents' files are synced with `library.sync`. */
      library?: boolean;
      dryRun?: boolean;
    }) => this.request<RestoreSummary>("POST", "restore", { body: input }),
  };

  readonly sync = {
    status: () => this.request<SyncStatus>("GET", "sync"),
    /** Turns sync on or changes it; does not sync. */
    configure: (settings: SyncSettings) =>
      this.request<SyncStatus>("PUT", "sync", { body: settings }),
    /** Turns sync off and forgets its secrets. */
    disable: () => this.request<SyncStatus>("DELETE", "sync"),
    /** Syncs once; rejects with the sync's failure. */
    now: () => this.request<SyncStatus>("POST", "sync/now", { body: {} }),
  };

  readonly modelCalls = {
    /** Newest first; pass `nextCursor` back to continue. `limit` is 1 to 200 (default 50). */
    list: (query: CallFilter & { limit?: number; cursor?: string } = {}) =>
      this.request<Page<ApiModelCall>>("GET", "model-calls", {
        query: { ...query },
      }),
  };

  readonly usage = {
    aggregate: (query: CallFilter & { groupBy?: UsageGroupBy } = {}) =>
      this.request<UsageReport>("GET", "usage", { query: { ...query } }),
  };

  readonly conversations = {
    /** Conversations active last first; the filter applies to their calls. `limit` is 1 to 200 (default 50). */
    list: (query: CallFilter & { limit?: number; cursor?: string } = {}) =>
      this.request<Page<ConversationView>>("GET", "conversations", {
        query: { ...query },
      }),
    /** One conversation's calls, newest first; 404 CONVERSATION_NOT_FOUND when it has none. */
    get: (key: string, page: { limit?: number; cursor?: string } = {}) =>
      this.request<Page<ApiModelCall>>("GET", `conversations/${segment(key)}`, {
        query: { ...page },
      }),
  };

  readonly autoGroups = {
    /** Groups of models that several providers serve under one name, hidden ones included. */
    list: () => this.request<Page<AutoGroup>>("GET", "auto-groups"),
    /** The gateway stops listing and routing `group/<id>` until it is restored. */
    hide: (id: string) =>
      this.request<void>("POST", `auto-groups/${segment(id)}/hide`, {
        body: {},
      }),
    restore: (id: string) =>
      this.request<void>("POST", `auto-groups/${segment(id)}/restore`, {
        body: {},
      }),
  };

  readonly subscriptions = {
    /** The current risk notice of each backend; an account must accept it to be used. */
    notices: () =>
      this.request<Page<SubscriptionNoticeView>>(
        "GET",
        "subscriptions/notices",
      ),
    /** Every subscription account, usable or not. */
    accounts: () =>
      this.request<Page<SubscriptionAccountView>>(
        "GET",
        "subscriptions/accounts",
      ),
    /**
     * Start a sign-in. ChatGPT: open `authorizeUrl` in the browser and poll
     * {@link signIn} until it is no longer pending. Copilot: finished when
     * it returns; `auth` is the Copilot CLI's own login (default) or `token`
     * with a fine-grained personal access token. `acceptNotice` is the
     * notice version the user accepted; `credential` signs an account in again.
     */
    startSignIn: (input: {
      backend: SubscriptionBackend;
      acceptNotice: string;
      provider?: string;
      credential?: string;
      auth?: CopilotAuth;
      token?: string;
    }) =>
      this.request<SignInView>("POST", "subscriptions/sign-in", {
        body: input,
      }),
    signIn: (id: string) =>
      this.request<SignInView>("GET", `subscriptions/sign-in/${segment(id)}`),
    /**
     * Cancel a pending ChatGPT sign-in: the daemon closes its loopback
     * callback listener and the attempt reads `cancelled`. 409
     * `SIGN_IN_NOT_PENDING` once it ended, `SIGN_IN_COMPLETING` while the
     * browser's callback is being completed; 404 for an unknown ID.
     */
    cancelSignIn: (id: string) =>
      this.request<SignInView>(
        "DELETE",
        `subscriptions/sign-in/${segment(id)}`,
      ),
    /** Whether the Copilot SDK add-on and the Copilot CLI are installed, and how to install the SDK. */
    copilotSetup: () =>
      this.request<CopilotSetupView>("GET", "subscriptions/copilot/setup"),
    /** Install the supported Copilot SDK with the user's npm (may take minutes), then report the setup. */
    installCopilot: () =>
      this.request<CopilotSetupView>("POST", "subscriptions/copilot/setup", {
        body: {},
      }),
    /** End the account's session with the vendor and clear its tokens; the registration stays. */
    signOut: (provider: string, credential: string) =>
      this.request<{ revoked: boolean }>(
        "POST",
        `providers/${segment(provider)}/credentials/${segment(credential)}/sign-out`,
        { body: {} },
      ),
  };
}
