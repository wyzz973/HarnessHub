import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ConfigurationAdapter,
  EngineConfiguration,
  ModelCompatibility,
  ModelProviderConfiguration,
  SecretReference,
} from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import {
  HARNESS_MODEL_ALIAS,
  harnessModelEnvironment,
  type HarnessModel,
  type HarnessModelEngineStatus,
  type HarnessModelView,
} from "../domain/harness-model.js";
import {
  isTerminal,
  type EngineProfile,
  type PublicError,
  type RunId,
  type RunRecord,
  type RunStatus,
  type SessionId,
  type SessionRecord,
} from "../domain/types.js";

/**
 * Adapters that only work with their vendor account or native Provider, so the
 * Worker-owned model gateway cannot front them (ADR 0013). Engines using them are
 * disabled while a unified model is configured.
 */
export const unroutableAdapters: readonly ConfigurationAdapter[] = [
  "generic",
  "cursor",
  "antigravity",
  "kiro",
  "qoder",
];

export type HarnessModelSource = NonNullable<HarnessModelView["source"]>;

/** The unified model selected by source priority; `provider.modelAlias` is always set. */
export interface ActiveHarnessModel {
  source: HarnessModelSource;
  /** Real upstream model id written to every engine registration. */
  model: string;
  /** Model id engines see through the gateway. */
  alias: string;
  provider: ModelProviderConfiguration & { modelAlias: string };
}

/** Result of applying the unified model to one declared registration. */
export interface HarnessModelPlan {
  status: HarnessModelEngineStatus["status"];
  /** Why the engine is disabled, or which engine-owned settings were overridden. */
  reason?: string;
  /** Registration Runtime executes instead of the declared one. */
  registration: EngineRegistration;
}

/** Validated execution profile plus the public status for one declared engine. */
export interface HarnessModelEvaluation {
  status: HarnessModelEngineStatus["status"];
  reason?: string;
  profile: EngineProfile;
}

/** Engine-layer functions injected by the composition root. */
export interface HarnessModelPorts {
  /** Full registration validation; throws HubError for registrations Runtime cannot run. */
  normalize(registration: EngineRegistration): EngineProfile;
  /** Adapter implied by a reviewed built-in recipe id for registrations without one. */
  inferAdapter(engineId: string): ConfigurationAdapter | undefined;
}

/** Catalog operations the service needs; implemented by EngineManager. */
export interface HarnessModelCatalog {
  /** Current registrations as authored by files, API and overlays, before the policy. */
  declared(): EngineProfile[];
  /**
   * Runs `change` inside catalog serialization, then republishes every engine with the
   * current policy. A failure of `change` publishes nothing.
   */
  refresh(change: () => Promise<void>): Promise<void>;
}

/** Session operations used by the connectivity test; implemented by HubApplication. */
export interface HarnessModelSessions {
  defaultEngine(): string;
  createSessionAtDirectory(input: {
    directory: string;
    engineId?: string;
  }): Promise<SessionRecord>;
  submit(
    id: SessionId,
    input: { text: string; timeoutMs?: number },
  ): { run: RunRecord };
  getRun(id: RunId): RunRecord;
  cancel(id: RunId): Promise<RunRecord>;
  closeSession(id: SessionId): Promise<SessionRecord>;
}

/** Response of `POST /v1/harness/model/test`. */
export interface HarnessModelTestResult {
  /** True only when the Run completed and the engine returned a non-empty reply. */
  ok: boolean;
  status: RunStatus;
  durationMs: number;
  runId: string;
  error?: PublicError;
}

/** Response of `GET /v1/runtime/info`, fixed when the Gateway starts. */
export interface RuntimeInfo {
  competition: boolean;
  competitionEngine?: string;
  fullAccess: boolean;
  consoleUrl?: string;
}

/** HTTP-facing port implemented by {@link HarnessModelService}. */
export interface HarnessModelManagement {
  view(): HarnessModelView;
  set(input: unknown): Promise<HarnessModelView>;
  test(input: unknown): Promise<HarnessModelTestResult>;
}

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const environmentName = /^[A-Z][A-Z0-9_]*$/;
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const sensitiveHeader =
  /authorization|api[-_]?key|token|secret|password|cookie|credential/i;
const inlineCredential = /\b(?:sk-|ghp_|Bearer )[A-Za-z0-9_-]{12,}/;
const controlCharacter = /[\u0000-\u001f\u007f]/;
const providerFields = [
  "protocol",
  "baseUrl",
  "apiKey",
  "headers",
  "secretHeaders",
  "contextWindow",
  "maxOutputTokens",
  "modelAlias",
  "compatibility",
];

function invalid(message: string): never {
  throw new HubError("INVALID_HARNESS_MODEL", message, 400);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${field} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  field: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const result = object(value, field);
  const unknownField = Object.keys(result).find(
    (name) => !allowed.includes(name),
  );
  if (unknownField !== undefined)
    invalid(`${field} 含未知字段：${unknownField}`);
  return result;
}
function text(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    value !== value.trim() ||
    controlCharacter.test(value)
  )
    invalid(`${field} 必须是非空字符串，不含首尾空白或控制字符，最长 ${max}`);
  return value;
}
function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    invalid(`${field} 必须是 ${minimum}–${maximum} 的整数`);
  return value as number;
}
function alias(value: unknown, field: string): string {
  if (typeof value !== "string" || !aliasPattern.test(value))
    invalid(`${field} 只能包含字母、数字和 ._:/-，以字母或数字开头，最长 128`);
  return value;
}
function baseUrl(value: unknown): string {
  const raw = text(value, "provider.baseUrl", 8192);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalid("provider.baseUrl 必须是绝对 HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    invalid("provider.baseUrl 必须使用 HTTP(S)，且不含账号、查询参数或片段");
  return raw;
}
/** Same reference rules as engine registrations: names and locations only, never values. */
function secretReference(value: unknown, field: string): SecretReference {
  if (typeof value === "string")
    invalid(`${field} 只接受秘密引用 {kind,value}，不能直接填写密钥`);
  const reference = fields(value, field, ["kind", "value"]);
  const location = text(reference.value, `${field}.value`, 8192);
  switch (reference.kind) {
    case "env":
      if (!environmentName.test(location))
        invalid(`${field} 的 env 引用必须是环境变量名`);
      return { kind: "env", value: location };
    case "file":
      if (!path.isAbsolute(location))
        invalid(`${field} 的 file 引用必须是绝对路径`);
      return { kind: "file", value: location };
    case "keychain":
      if (!/^[a-f0-9-]{36}$/.test(location))
        invalid(`${field} 的 keychain 引用必须是 HarnessHub 凭据 ID`);
      return { kind: "keychain", value: location };
    default:
      return invalid(`${field}.kind 必须是 env、file 或 keychain`);
  }
}
function entries(value: unknown, field: string): [string, unknown][] {
  const list = Object.entries(object(value, field));
  if (list.length > 32) invalid(`${field} 最多 32 项`);
  for (const [name] of list)
    if (!headerName.test(name)) invalid(`${field} 含无效的请求头名称：${name}`);
  return list;
}
function compatibility(value: unknown): ModelCompatibility {
  const raw = fields(value, "provider.compatibility", [
    "includeUsage",
    "dropParameters",
    "maxTokensField",
    "reasoning",
  ]);
  const result: ModelCompatibility = {};
  if (raw.includeUsage !== undefined) {
    if (typeof raw.includeUsage !== "boolean")
      invalid("provider.compatibility.includeUsage 必须是布尔值");
    result.includeUsage = raw.includeUsage;
  }
  if (raw.dropParameters !== undefined) {
    if (
      !Array.isArray(raw.dropParameters) ||
      raw.dropParameters.length > 64 ||
      !raw.dropParameters.every(
        (name: unknown) =>
          typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name),
      )
    )
      invalid(
        "provider.compatibility.dropParameters 必须是最多 64 个小写参数名",
      );
    result.dropParameters = [...(raw.dropParameters as string[])];
  }
  if (raw.maxTokensField !== undefined) {
    if (
      raw.maxTokensField !== "max_tokens" &&
      raw.maxTokensField !== "max_completion_tokens"
    )
      invalid(
        "provider.compatibility.maxTokensField 必须是 max_tokens 或 max_completion_tokens",
      );
    result.maxTokensField = raw.maxTokensField;
  }
  if (raw.reasoning !== undefined) {
    if (raw.reasoning !== "passthrough" && raw.reasoning !== "strip")
      invalid("provider.compatibility.reasoning 必须是 passthrough 或 strip");
    result.reasoning = raw.reasoning;
  }
  return result;
}
function provider(value: unknown): ModelProviderConfiguration {
  const raw = fields(value, "provider", providerFields);
  if (raw.protocol !== "openai-completions") {
    if (
      raw.protocol === "openai-responses" ||
      raw.protocol === "anthropic" ||
      raw.protocol === "google"
    )
      throw new HubError(
        "HARNESS_MODEL_PROTOCOL_UNSUPPORTED",
        "统一模型的上游协议当前只支持 openai-completions（流式 Chat Completions）",
        400,
      );
    invalid("provider.protocol 必须是 openai-completions");
  }
  const result: ModelProviderConfiguration = {
    protocol: "openai-completions",
    baseUrl: baseUrl(raw.baseUrl),
  };
  if (raw.apiKey !== undefined)
    result.apiKey = secretReference(raw.apiKey, "provider.apiKey");
  const names = new Set<string>();
  const claim = (name: string) => {
    if (names.has(name.toLowerCase())) invalid(`请求头 ${name} 重复`);
    names.add(name.toLowerCase());
  };
  if (raw.headers !== undefined) {
    const headers: Record<string, string> = {};
    for (const [name, header] of entries(raw.headers, "provider.headers")) {
      const value = text(header, `provider.headers.${name}`, 8192);
      if (sensitiveHeader.test(name) || inlineCredential.test(value))
        invalid(`敏感请求头 ${name} 必须写入 provider.secretHeaders 秘密引用`);
      claim(name);
      headers[name] = value;
    }
    result.headers = headers;
  }
  if (raw.secretHeaders !== undefined) {
    const secretHeaders: Record<string, SecretReference> = {};
    for (const [name, reference] of entries(
      raw.secretHeaders,
      "provider.secretHeaders",
    )) {
      claim(name);
      secretHeaders[name] = secretReference(
        reference,
        `provider.secretHeaders.${name}`,
      );
    }
    result.secretHeaders = secretHeaders;
  }
  if (raw.contextWindow !== undefined)
    result.contextWindow = integer(
      raw.contextWindow,
      "provider.contextWindow",
      1024,
      16_777_216,
    );
  if (raw.maxOutputTokens !== undefined)
    result.maxOutputTokens = integer(
      raw.maxOutputTokens,
      "provider.maxOutputTokens",
      16,
      4_194_304,
    );
  if (
    result.contextWindow !== undefined &&
    result.maxOutputTokens !== undefined &&
    result.maxOutputTokens > result.contextWindow
  )
    invalid("provider.maxOutputTokens 不能大于 provider.contextWindow");
  if (raw.modelAlias !== undefined)
    result.modelAlias = alias(raw.modelAlias, "provider.modelAlias");
  if (raw.compatibility !== undefined)
    result.compatibility = compatibility(raw.compatibility);
  return result;
}

/**
 * Validate an untrusted unified model. Only the streaming Chat Completions upstream is
 * accepted; `apiKey` and `secretHeaders` accept secret references only. Returns a new
 * object without defaults filled in, suitable for persistence.
 *
 * @throws HubError `INVALID_HARNESS_MODEL` or `HARNESS_MODEL_PROTOCOL_UNSUPPORTED` (400).
 */
export function parseHarnessModel(input: unknown): HarnessModel {
  const raw = fields(input, "统一模型", ["model", "alias", "provider"]);
  const model = text(raw.model, "model", 256);
  const upstream = provider(raw.provider);
  const shown = raw.alias === undefined ? undefined : alias(raw.alias, "alias");
  if (
    shown !== undefined &&
    upstream.modelAlias !== undefined &&
    shown !== upstream.modelAlias
  )
    invalid("alias 与 provider.modelAlias 不一致");
  return {
    model,
    ...(shown !== undefined ? { alias: shown } : {}),
    provider: upstream,
  };
}

/**
 * Read the unattended-startup variables in {@link harnessModelEnvironment}. The source
 * is active only when `HARNESSHUB_MODEL` is set. The key variable is referenced by name
 * and never copied into configuration.
 *
 * @returns undefined when the environment does not select a unified model.
 * @throws HubError when the variables are incomplete or invalid.
 */
export function harnessModelFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): HarnessModel | undefined {
  const names = harnessModelEnvironment;
  const read = (name: string) => {
    const value = environment[name]?.trim();
    return value ? value : undefined;
  };
  const model = read(names.model);
  if (!model) {
    const partial = [
      names.baseUrl,
      names.protocol,
      names.contextWindow,
      names.maxOutputTokens,
    ].filter((name) => read(name) !== undefined);
    if (partial.length)
      invalid(`设置 ${partial.join("、")} 时必须同时设置 ${names.model}`);
    return undefined;
  }
  const url = read(names.baseUrl);
  if (!url) invalid(`设置 ${names.model} 时必须同时设置 ${names.baseUrl}`);
  const number = (name: string) => {
    const value = read(name);
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]{0,15}$/.test(value)) invalid(`${name} 必须是正整数`);
    return Number(value);
  };
  const contextWindow = number(names.contextWindow);
  const maxOutputTokens = number(names.maxOutputTokens);
  return parseHarnessModel({
    model,
    provider: {
      protocol: read(names.protocol) ?? "openai-completions",
      baseUrl: url,
      ...(read(names.apiKey) !== undefined
        ? { apiKey: { kind: "env", value: names.apiKey } }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    },
  });
}

/**
 * Read a persisted unified model file.
 *
 * @returns undefined when the file does not exist.
 * @throws HubError for invalid JSON or an invalid model; other I/O errors propagate.
 */
export async function readHarnessModelFile(
  file: string,
): Promise<HarnessModel | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    invalid(`统一模型文件不是有效 JSON：${file}`);
  }
  return parseHarnessModel(value);
}

/**
 * Validate, then atomically replace `file` with mode 0600. The previous file stays
 * intact when validation, the temporary write or the rename fails.
 */
export async function writeHarnessModelFile(
  file: string,
  model: HarnessModel,
): Promise<void> {
  const validated = parseHarnessModel(model);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    // The write/rename error is the result; a leftover private temporary file is harmless.
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Select the highest-priority configured source: environment > file > settings. */
export function activeHarnessModel(sources: {
  environment?: HarnessModel | undefined;
  file?: HarnessModel | undefined;
  settings?: HarnessModel | undefined;
}): ActiveHarnessModel | undefined {
  const selected: [HarnessModelSource, HarnessModel] | undefined =
    sources.environment
      ? ["environment", sources.environment]
      : sources.file
        ? ["file", sources.file]
        : sources.settings
          ? ["settings", sources.settings]
          : undefined;
  if (!selected) return undefined;
  const [source, model] = selected;
  const shown = model.alias ?? model.provider.modelAlias ?? HARNESS_MODEL_ALIAS;
  return {
    source,
    model: model.model,
    alias: shown,
    provider: { ...model.provider, modelAlias: shown },
  };
}

function describeProvider(provider: ModelProviderConfiguration): string {
  return provider.baseUrl
    ? `${provider.protocol} ${provider.baseUrl}`
    : provider.protocol;
}
function withoutCredentials(
  registration: EngineRegistration,
): EngineRegistration {
  const { credentialEnv: _credentialEnv, ...rest } = registration;
  if (!rest.configuration?.secretEnv) return rest;
  const { secretEnv: _secretEnv, ...configuration } = rest.configuration;
  return { ...rest, configuration };
}
function removedCredentials(registration: EngineRegistration): string[] {
  const notes: string[] = [];
  if (registration.credentialEnv?.length)
    notes.push(
      `移除引擎自带凭据透传 credentialEnv：${registration.credentialEnv.join(", ")}`,
    );
  const secretEnv = Object.keys(registration.configuration?.secretEnv ?? {});
  if (secretEnv.length)
    notes.push(`移除引擎进程秘密环境 secretEnv：${secretEnv.join(", ")}`);
  return notes;
}

/**
 * Pure unified-model transform for one declared registration. Supported engines get the
 * upstream `model`, the unified `provider` with `modelAlias`, and lose `credentialEnv`
 * and engine-level `secretEnv`; adapter, env, skills, MCP servers, command and limits
 * are kept. Adapters listed in {@link unroutableAdapters}, and registrations whose
 * adapter is neither declared nor implied by `inferredAdapter`, are disabled.
 * The result is not validated; see {@link evaluateHarnessModel}.
 */
export function applyHarnessModel(
  registration: EngineRegistration,
  active: ActiveHarnessModel,
  inferredAdapter?: ConfigurationAdapter,
): HarnessModelPlan {
  const removed = removedCredentials(registration);
  const stripped = withoutCredentials(registration);
  const adapter = registration.configuration?.adapter ?? inferredAdapter;
  const disabled = (reason: string): HarnessModelPlan => ({
    status: "unsupported",
    reason: [reason, ...removed].join("；"),
    registration: { ...stripped, enabled: false },
  });
  if (!adapter)
    return disabled(
      "登记未声明 configuration.adapter，且引擎 id 不是内置引擎，无法确认能经统一模型网关接入；已停用",
    );
  if (unroutableAdapters.includes(adapter))
    return disabled(
      `适配器 ${adapter} 只能使用引擎自带的账号或 Provider，无法经统一模型网关接入；已停用`,
    );
  const notes = [...removed];
  if (registration.model !== undefined && registration.model !== active.model)
    notes.unshift(`覆盖登记模型 ${registration.model}`);
  const declaredProvider = registration.configuration?.provider;
  if (
    declaredProvider &&
    JSON.stringify(declaredProvider) !== JSON.stringify(active.provider)
  )
    notes.unshift(`覆盖登记 Provider（${describeProvider(declaredProvider)}）`);
  const current: EngineConfiguration = stripped.configuration ?? { adapter };
  const { provider: _provider, adapter: _adapter, ...rest } = current;
  const configuration: EngineConfiguration = {
    adapter,
    ...rest,
    provider: active.provider,
  };
  const { model: _model, ...base } = stripped;
  const planned: EngineRegistration = {
    ...base,
    model: active.model,
    configuration,
  };
  if (registration.enabled === false)
    return {
      status: "disabled",
      reason: ["引擎登记为停用（enabled:false）", ...notes].join("；"),
      registration: planned,
    };
  return {
    status: "applied",
    ...(notes.length ? { reason: notes.join("；") } : {}),
    registration: planned,
  };
}

function registrationOf(profile: EngineProfile): EngineRegistration {
  if (profile.driver === "fake" || !profile.command)
    throw new HubError(
      "HARNESS_MODEL_INTERNAL",
      "Demo engines are exempt from the unified model",
      500,
    );
  const {
    revision: _revision,
    capabilities: _capabilities,
    driver,
    command,
    ...rest
  } = profile;
  return { ...rest, driver, command };
}

/**
 * Apply the unified model to a declared real-engine profile and validate the result with
 * `ports.normalize`. A registration the engine layer rejects (for example an adapter that
 * cannot accept the upstream protocol) is published disabled with the validation reason,
 * so one incompatible engine never blocks the catalog. Deterministic for equal inputs.
 */
export function evaluateHarnessModel(
  declared: EngineProfile,
  active: ActiveHarnessModel,
  ports: HarnessModelPorts,
): HarnessModelEvaluation {
  const registration = registrationOf(declared);
  const plan = applyHarnessModel(
    registration,
    active,
    ports.inferAdapter(declared.id),
  );
  try {
    return {
      status: plan.status,
      ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
      profile: ports.normalize(plan.registration),
    };
  } catch (error) {
    if (!(error instanceof HubError)) throw error;
    return {
      status: "unsupported",
      reason: [
        `统一模型无法用于该引擎登记：${error.message}；已停用`,
        ...removedCredentials(registration),
      ].join("；"),
      profile: ports.normalize({
        ...withoutCredentials(registration),
        enabled: false,
      }),
    };
  }
}

const testPrompt =
  "这是 HarnessHub 统一模型连通性测试。不要调用任何工具，只回复 OK。";
const testTimeoutMs = 90_000;

/**
 * Owns the unified model sources (environment > file > settings) and applies the
 * selected model to every engine through the catalog policy. Environment and settings
 * sources are fixed for the process; only the file source changes, through {@link set}.
 */
export class HarnessModelService implements HarnessModelManagement {
  private catalog: HarnessModelCatalog | undefined;
  private sessions: HarnessModelSessions | undefined;
  private scratch: string | undefined;
  private testing:
    { abort: AbortController; task: Promise<unknown> } | undefined;
  private closed = false;

  private constructor(
    private readonly ports: HarnessModelPorts,
    private readonly file: string | undefined,
    private readonly environmentModel: HarnessModel | undefined,
    private fileModel: HarnessModel | undefined,
    private readonly settingsModel: HarnessModel | undefined,
  ) {}

  /**
   * Read and validate every provided source once. Any invalid source fails startup,
   * including sources shadowed by a higher priority. A missing file is not configured.
   */
  static async load(options: {
    environment: Readonly<NodeJS.ProcessEnv>;
    file?: string;
    settings?: unknown;
    ports: HarnessModelPorts;
  }): Promise<HarnessModelService> {
    const environment = harnessModelFromEnvironment(options.environment);
    const file = options.file
      ? await readHarnessModelFile(options.file)
      : undefined;
    const settings =
      options.settings === undefined
        ? undefined
        : parseHarnessModel(options.settings);
    return new HarnessModelService(
      options.ports,
      options.file,
      environment,
      file,
      settings,
    );
  }

  /** Connect the catalog and session ports; call once before serving requests. */
  bind(options: {
    catalog: HarnessModelCatalog;
    sessions: HarnessModelSessions;
    scratchDirectory: string;
  }): void {
    if (this.catalog)
      throw new HubError(
        "HARNESS_MODEL_INTERNAL",
        "Unified model service is already bound",
        500,
      );
    this.catalog = options.catalog;
    this.sessions = options.sessions;
    this.scratch = options.scratchDirectory;
  }

  active(): ActiveHarnessModel | undefined {
    return activeHarnessModel({
      environment: this.environmentModel,
      file: this.fileModel,
      settings: this.settingsModel,
    });
  }

  /** Evaluate one declared real engine with the current model; undefined when exempt. */
  evaluate(declared: EngineProfile): HarnessModelEvaluation | undefined {
    const active = this.active();
    if (!active || declared.driver === "fake" || !declared.command)
      return undefined;
    return evaluateHarnessModel(declared, active, this.ports);
  }

  /** Catalog policy: reads the current model on every publication. */
  policy(): {
    apply(declared: EngineProfile): {
      profile: EngineProfile;
      unavailableReason?: string;
    };
  } {
    return {
      apply: (declared) => {
        const evaluation = this.evaluate(declared);
        if (!evaluation) return { profile: declared };
        return {
          profile: evaluation.profile,
          ...(evaluation.status === "unsupported" &&
          evaluation.reason !== undefined
            ? { unavailableReason: evaluation.reason }
            : {}),
        };
      },
    };
  }

  view(): HarnessModelView {
    const active = this.active();
    if (!active)
      return { configured: false, alias: HARNESS_MODEL_ALIAS, engines: [] };
    return {
      configured: true,
      source: active.source,
      model: active.model,
      alias: active.alias,
      provider: active.provider,
      engines: this.bound()
        .catalog.declared()
        .flatMap((declared) => {
          const evaluation = this.evaluate(declared);
          return evaluation
            ? [
                {
                  engineId: declared.id,
                  status: evaluation.status,
                  ...(evaluation.reason !== undefined
                    ? { reason: evaluation.reason }
                    : {}),
                },
              ]
            : [];
        }),
    };
  }

  /**
   * Validate, atomically persist the file source, then republish every engine so new
   * Sessions use new revisions; existing Sessions keep their pinned revisions.
   *
   * @throws 409 while the environment source is active or no file is configured.
   */
  async set(input: unknown): Promise<HarnessModelView> {
    if (this.environmentModel)
      throw new HubError(
        "HARNESS_MODEL_ENVIRONMENT_OVERRIDE",
        "统一模型由 HARNESSHUB_MODEL* 环境变量提供；请修改环境变量并重启服务",
        409,
      );
    const file = this.file;
    if (!file)
      throw new HubError(
        "HARNESS_MODEL_FILE_UNAVAILABLE",
        "服务未配置统一模型文件，无法保存",
        409,
      );
    const model = parseHarnessModel(input);
    await this.bound().catalog.refresh(async () => {
      await writeHarnessModelFile(file, model);
      this.fileModel = model;
    });
    return this.view();
  }

  /**
   * Run one short task on the default or requested engine in a private temporary
   * directory, wait at most 90 s, then close the Session. This calls the configured model
   * through the engine's Worker; the Gateway never resolves the model secret. At most one
   * test runs at a time.
   */
  async test(input: unknown): Promise<HarnessModelTestResult> {
    const body = input === undefined || input === null ? {} : input;
    const request = fields(body, "请求", ["engineId"]);
    const { sessions, catalog, scratch } = this.bound();
    const active = this.active();
    if (!active)
      throw new HubError(
        "HARNESS_MODEL_NOT_CONFIGURED",
        "尚未配置统一模型",
        409,
      );
    const engineId =
      request.engineId === undefined
        ? sessions.defaultEngine()
        : text(request.engineId, "engineId", 100);
    const declared = catalog.declared().find((p) => p.id === engineId);
    if (!declared)
      throw new HubError(
        "ENGINE_UNAVAILABLE",
        engineId ? `引擎 ${engineId} 未登记` : "没有可用的默认引擎",
        404,
      );
    const evaluation = this.evaluate(declared);
    if (!evaluation)
      throw new HubError(
        "HARNESS_MODEL_TEST_UNSUPPORTED",
        "演示引擎不调用模型，不能用于统一模型测试",
        409,
      );
    if (evaluation.status !== "applied")
      throw new HubError(
        "ENGINE_UNAVAILABLE",
        `引擎 ${engineId} 未使用统一模型：${evaluation.reason ?? evaluation.status}`,
        409,
      );
    if (this.closed)
      throw new HubError("HARNESS_MODEL_CLOSED", "服务正在关闭", 503);
    if (this.testing)
      throw new HubError(
        "HARNESS_MODEL_TEST_BUSY",
        "已有统一模型测试正在运行",
        429,
      );
    const abort = new AbortController();
    const task = this.runTest(engineId, scratch, sessions, abort.signal);
    this.testing = { abort, task };
    try {
      return await task;
    } finally {
      this.testing = undefined;
    }
  }

  private async runTest(
    engineId: string,
    scratch: string,
    sessions: HarnessModelSessions,
    signal: AbortSignal,
  ): Promise<HarnessModelTestResult> {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(scratch, "harness-model-test-"));
    try {
      const session = await sessions.createSessionAtDirectory({
        directory,
        engineId,
      });
      try {
        const started = Date.now();
        const { run } = sessions.submit(session.id, {
          text: testPrompt,
          timeoutMs: testTimeoutMs,
        });
        let current = run;
        const until = started + testTimeoutMs + 5_000;
        while (!isTerminal(current.status)) {
          if (signal.aborted || Date.now() > until) {
            current = await sessions.cancel(run.id);
            break;
          }
          await delay(100);
          current = sessions.getRun(run.id);
        }
        const durationMs = Date.now() - started;
        const replied = Boolean(current.output?.trim());
        const ok = current.status === "completed" && replied;
        const error: PublicError | undefined = ok
          ? undefined
          : (current.error ??
            (current.status === "completed"
              ? {
                  code: "MODEL_EMPTY_REPLY",
                  message: "引擎正常结束但没有返回内容，模型调用可能失败",
                }
              : {
                  code: "MODEL_TEST_FAILED",
                  message: `测试任务以 ${current.status} 结束`,
                }));
        return {
          ok,
          status: current.status,
          durationMs,
          runId: run.id,
          ...(error ? { error } : {}),
        };
      } finally {
        await sessions.closeSession(session.id);
      }
    } finally {
      // Best effort: the directory is private to this test; a leftover copy does not
      // change the reported result and is removed with the data directory.
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  /** Stop accepting tests, cancel a running one and wait for its cleanup. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    const running = this.testing;
    if (!running) return;
    running.abort.abort();
    await Promise.allSettled([running.task]);
  }

  private bound(): {
    catalog: HarnessModelCatalog;
    sessions: HarnessModelSessions;
    scratch: string;
  } {
    if (!this.catalog || !this.sessions || this.scratch === undefined)
      throw new HubError(
        "HARNESS_MODEL_INTERNAL",
        "Unified model service is not bound to the engine catalog",
        500,
      );
    return {
      catalog: this.catalog,
      sessions: this.sessions,
      scratch: this.scratch,
    };
  }
}
