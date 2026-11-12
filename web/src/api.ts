import { consumeSessionEventStream, SessionStreamError } from "./session-stream.js";
import { readSseBlocks } from "./attention.js";
import { decodeProtocolTurn } from "./lib/protocol/decode.js";
import { createRelayApi, decodeRelayFrame, decodeRelayStreamEvent, decodeRunRelay, relayBody, type RelayApi, type RelayEvent, type RelayReply, type RelayRequest, type RelayTransport } from "./relay.js";
import type { ProviderProtocol, ProviderTarget, ProviderView, ProviderWriteInput } from "../../src/contracts/provider.js";
import type { AttentionFrame, AuthSession, HarnessReadinessView, HarnessView, InstallationLogPage, KeptProcessView, LoginShellView, MaintenanceView, NativeResumeView, NativeSessionListView, SessionSummary, SessionView, SessionStreamFrame, UninstallCheckView, InstallCheckView, InstallationUpgradeCheckView, WebState } from "../../src/contracts/web.js";
import { HARNESS_TIERS } from "../../src/contracts/web.js";
import type { HarnessManagementView, InstallationJobView, ManagementJobInput, RuntimeRequirement, UpgradeSequenceCheck } from "../../src/contracts/management.js";
import type { AttentionItem, HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunStatus, SelectionRequest } from "../../src/contracts/session.js";
import type { NativeExtensions, NativeInputs, NativeOption, NativeModelCatalog } from "../../src/contracts/control.js";
import { parseNativeOptions, commandId, messageId, runId, sessionId, switchId } from "../../src/contracts/session.js";
import { parseContentRef, type ContentRef } from "../../src/contracts/content.js";
import { RUN_STATUS_WORDS } from "../../src/contracts/protocol-words.js";
import type { NativeUsage } from "../../src/contracts/control.js";
import { CAPABILITY_CHANGE_KINDS, CAPABILITY_DRIFT_STATES, CAPABILITY_KINDS, CAPABILITY_MECHANISMS, CAPABILITY_OWNERS, CAPABILITY_STATUSES, CAPABILITY_WARNINGS, MAX_CAPABILITY_ENTRIES, type CapabilitiesView, type CapabilityChangeCheck, type CapabilityChangeView,
  type CapabilityEdge, type CapabilityFacts, type CapabilityHistory, type CapabilityLinkChange, type CapabilityRestoreCheck, type CapabilitySkillPlan, type McpDefinitionView, type McpInventoryView, MCP_TARGET_STATES,
  type SkillSourceListing, type SkillUpdateView, INSTRUCTION_CHECK_OPTIONS, INSTRUCTION_TARGET_STATES, type InstructionCheckOption, type InstructionsView, type SubagentDefinitionView,
  type SubagentInventoryView, type SkillTextView } from "../../src/contracts/capabilities.js";

export interface ToolDetailView { readonly kind?: string; readonly name?: string; readonly input?: string; readonly output?: string; readonly diff?: string; readonly parentId?: string; readonly locations?: readonly string[]; readonly exitCode?: number; readonly truncated?: boolean }
/** Same-origin URL of stored native content for img/download use; the page cookie authorizes it. */
export function contentUrl(content: ContentRef, download = false): string { return "/api/v1/content/" + encodeURIComponent(content.id) + (download ? "?download=1" : ""); }
export class ApiError extends Error {
  /** `status` is the HTTP status of a refusal; it is absent for a failure that never reached the Gateway. */
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = "ApiError"; }
}
function invalid(): never { throw new ApiError("INVALID_RESPONSE", "网关返回了无法识别的数据，请重新载入。"); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function number(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : invalid(); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function list<T>(value: unknown, decode: (row: unknown) => T, limit = 2048): readonly T[] {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  return value.map(decode);
}
function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) return invalid();
  return value as T[number];
}
const RUN_STATES = ["queued", "preparing", "running", "settling", "completed", "cancelled", "failed", "unknown"] as const;
const SESSION_STATES = ["open", "closed", "blocked"] as const;
export const PROVIDER_PROTOCOLS = ["openai-responses", "openai-chat-completions", "anthropic-messages", "gemini"] as const;
function nativeOption(value: unknown): NativeOption {
  const row = record(value), values = list(row.values,value => { const option = record(value); return { value: text(option.value), name: text(option.name) }; },4096);
  if (!values.length || new Set(values.map(option=>option.value)).size!==values.length) return invalid();
  return { id:text(row.id), name:text(row.name), category:text(row.category), currentValue:text(row.currentValue), values };
}
function target(value: unknown): ProviderTarget {
  const row = record(value);
  return { providerId: text(row.providerId), revision: number(row.revision), model: text(row.model) };
}
function selection(value: unknown): HarnessSelection {
  const row = record(value);
  if (row.provider !== undefined && row.nativeModel !== undefined) return invalid();
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), ...(row.provider === undefined ? {} : { provider: target(row.provider) }),
    ...(row.nativeModel === undefined ? {} : { nativeModel: text(row.nativeModel) }), ...(row.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(row.nativeOptions) }) };
}
function requestedSelection(value: unknown): SelectionRequest {
  const row = record(value);
  return { harnessId: text(row.harnessId), ...(row.controlId === undefined ? {} : { controlId: text(row.controlId) }),
    ...(row.provider === undefined ? {} : { provider: row.provider === null ? null : target(row.provider) }), ...(row.nativeModel === undefined ? {} : { nativeModel: text(row.nativeModel) }), ...(row.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(row.nativeOptions) }) };
}
function publicError(value: unknown): { code: string; message: string } | null {
  if (value === null) return null;
  const row = record(value); return { code: text(row.code), message: text(row.message) };
}
export function decodeProvider(value: unknown): ProviderView {
  const row = record(value);
  return { id: text(row.id), revision: number(row.revision), name: text(row.name), protocol: choice(row.protocol, PROVIDER_PROTOCOLS),
    baseUrl: text(row.baseUrl), models: list(row.models, text, 256), defaultModel: text(row.defaultModel), enabled: bool(row.enabled), hasCredential: bool(row.hasCredential) };
}
/** An ISO time as the Gateway writes it (`toISOString`); anything else is an invalid response. */
function isoTime(value: unknown): string {
  const time = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(time) && Number.isFinite(Date.parse(time)) ? time : invalid();
}
function decodeHarness(value: unknown): HarnessView {
  const row = record(value);
  const install = row.install === null ? null : record(row.install);
  return { id: text(row.id), name: text(row.name), tier: choice(row.tier, HARNESS_TIERS), installed: bool(row.installed), defaultControlId: nullableText(row.defaultControlId), providerProtocols: list(row.providerProtocols, text, 16), management: decodeManagement(row.management),
    controls: list(row.controls, value => { const control = record(value), entry = control.entry === null ? null : record(control.entry);
      return { id: text(control.id), protocol: text(control.protocol), available: bool(control.available), reason: nullableText(control.reason),
        entry: entry === null ? null : { source: choice(entry.source, ["path", "standard-directory", "custom-entry", "package-root", "managed"]) } }; }, 64),
    install: install === null ? null : { command: text(install.command), docs: text(install.docs), checkedAt: text(install.checkedAt), note: nullableText(install.note),
      method: choice(install.method, ["script", "npm", "terminal"]), available: bool(install.available) },
    installations: list(row.installations, value => { const item = record(value);
      return { ref: text(item.ref), channel: item.channel === null ? null : choice(item.channel, ["npm", "brew-formula", "brew-cask", "script", "uv", "pnpm", "bun"]), label: text(item.label), command: text(item.command),
        version: nullableText(item.version), role: choice(item.role, ["product", "adapter"]), active: bool(item.active), maintained: bool(item.maintained), canUninstall: bool(item.canUninstall),
        upgrade: item.upgrade === null ? null : choice(item.upgrade, ["version", "self-update", "rerun", "terminal", "maintenance"]),
        latest: item.latest === null ? null : (() => { const latest = record(item.latest); return { version: nullableText(latest.version), source: choice(latest.source, ["npm", "homebrew-local"]), checkedAt: text(latest.checkedAt), error: nullableText(latest.error) }; })() }; }, 64),
    unofficial: row.unofficial === null ? null : (() => { const item = record(row.unofficial); return { command: text(item.command), onPath: bool(item.onPath), pathDefault: bool(item.pathDefault) }; })() };
}
function decodeLoginShell(value: unknown): LoginShellView {
  const row = record(value);
  return { available: bool(row.available), ...(row.shell === undefined ? {} : { shell: text(row.shell) }), dirs: list(row.dirs, text).slice(0, 64), readAt: row.readAt === null ? null : number(row.readAt) };
}
function decodeManagement(value: unknown): HarnessManagementView {
  const row = record(value), recipe = row.recipe === null ? null : record(row.recipe);
  return { harnessId: text(row.harnessId), recipe: recipe === null ? null : { controlId: text(recipe.controlId), kind: choice(recipe.kind, ["npm", "python", "binary"]), sourceLabel: text(recipe.sourceLabel), packageName: nullableText(recipe.packageName), canInstall: bool(recipe.canInstall), reason: nullableText(recipe.reason) },
    source: choice(row.source, ["managed", "system", "missing"]), installedVersion: nullableText(row.installedVersion), programVersion: nullableText(row.programVersion), latestVersion: nullableText(row.latestVersion), updateStatus: choice(row.updateStatus, ["unchecked", "checking", "available", "current", "failed", "unsupported"]), checkedAt: nullableText(row.checkedAt), activeJobId: nullableText(row.activeJobId), installationId: nullableText(row.installationId), defaultRevision: number(row.defaultRevision), error: publicError(row.error),
    ...(row.native === undefined ? {} : { native: (() => { const native = record(row.native); return { channel: text(native.channel), location: text(native.location), fingerprint: text(native.fingerprint), canInstall: bool(native.canInstall), canUpgrade: bool(native.canUpgrade), reason: nullableText(native.reason) }; })() }) };
}
export function decodeInstallationJob(value: unknown): InstallationJobView {
  const row = record(value);
  return { id: text(row.id), harnessId: text(row.harnessId), controlId: text(row.controlId), action: choice(row.action, ["install", "upgrade", "uninstall"]), status: choice(row.status, ["queued", "resolving", "installing", "verifying", "activating", "completed", "cancelled", "failed", "unknown"]), phase: text(row.phase), cancelRequested: bool(row.cancelRequested), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt), resolvedVersion: nullableText(row.resolvedVersion), installationId: nullableText(row.installationId), error: publicError(row.error), logCursor: number(row.logCursor),
    ...(row.native === undefined ? {} : { native: (() => { const native = record(row.native); return { channel: text(native.channel), location: text(native.location), beforeVersion: nullableText(native.beforeVersion), actualVersion: nullableText(native.actualVersion), dispatched: bool(native.dispatched), configurationPreserved: native.configurationPreserved === null ? null : bool(native.configurationPreserved),
      ...(native.restartServices === undefined ? {} : { restartServices: list(native.restartServices, text, 16) }),
      ...(native.closedConversations === undefined ? {} : { closedConversations: number(native.closedConversations) }),
      ...(native.clearedRecords === undefined ? {} : { clearedRecords: number(native.clearedRecords) }),
      ...(native.services === undefined ? {} : { services: list(native.services, value => { const item = record(value); return { label: text(item.label), outcome: choice(item.outcome, ["restarted", "not_running", "not_recovered"]), pid: item.pid === null ? null : number(item.pid), ready: item.ready === null ? null : bool(item.ready) }; }, 16) }),
      ...(native.configurationChangedByService === undefined ? {} : { configurationChangedByService: bool(native.configurationChangedByService) }),
      ...(native.uninstall === undefined ? {} : { uninstall: (() => { const facts = record(native.uninstall); return { label: text(facts.label), role: choice(facts.role, ["product", "adapter"]),
        stopServices: list(facts.stopServices, text, 16), stoppedServices: list(facts.stoppedServices, text, 16), removed: bool(facts.removed) }; })() }),
      ...(native.official === undefined ? {} : { official: (() => { const facts = record(native.official); return { method: choice(facts.method, ["script", "npm"]), source: text(facts.source), sha256: nullableText(facts.sha256),
        shellChanges: list(facts.shellChanges, item => { const change = record(item); return { file: text(change.file), added: list(change.added, value => typeof value === "string" ? value : invalid(), 64), removed: list(change.removed, value => typeof value === "string" ? value : invalid(), 64) }; }, 4),
        configChanges: list(facts.configChanges, item => { const change = record(item); return { file: text(change.file), keys: list(change.keys, key => { const entry = record(key); return { path: text(entry.path), value: nullableText(entry.value) }; }, 64) }; }, 4),
        blocked: list(facts.blocked, text, 16), installed: bool(facts.installed) }; })() }),
      ...(native.installation === undefined ? {} : { installation: (() => { const facts = record(native.installation); return { label: text(facts.label), role: choice(facts.role, ["product", "adapter"]),
        kind: choice(facts.kind, ["version", "self-update", "rerun"]), command: text(facts.command), dependencies: list(facts.dependencies, text, 64), ...changes(facts), blocked: list(facts.blocked, text, 16) }; })() }),
      // A sequenced upgrade's hops, backup confirmation and the configuration its Doctor migrated (ADR-052).
      ...(native.hops === undefined ? {} : { hops: list(native.hops, value => { const hop = record(value); return { version: text(hop.version), installed: bool(hop.installed), doctor: choice(hop.doctor, ["ok", "failed", "skipped"]) }; }, 4) }),
      ...(native.backupConfirmed === undefined ? {} : { backupConfirmed: bool(native.backupConfirmed) }),
      ...(native.configurationMigrated === undefined ? {} : { configurationMigrated: list(native.configurationMigrated, text, 8) }) }; })() }) };
}
/** Lines an installer changed in a shell startup file and key paths it changed in a product configuration (ADR-044). */
function changes(facts: Record<string, unknown>): Pick<NonNullable<NonNullable<InstallationJobView["native"]>["installation"]>, "shellChanges" | "configChanges"> {
  return { shellChanges: list(facts.shellChanges, item => { const change = record(item); return { file: text(change.file), added: list(change.added, value => typeof value === "string" ? value : invalid(), 64), removed: list(change.removed, value => typeof value === "string" ? value : invalid(), 64) }; }, 4),
    configChanges: list(facts.configChanges, item => { const change = record(item); return { file: text(change.file), keys: list(change.keys, key => { const entry = record(key); return { path: text(entry.path), value: nullableText(entry.value) }; }, 64) }; }, 4) };
}
/** What upgrading one installation through its channel would run and change (ADR-044). */
export function decodeUpgradeCheck(value: unknown): InstallationUpgradeCheckView {
  const row = record(value), entry = (item: unknown) => { const program = record(item); return { pid: number(program.pid), name: text(program.name), ...(program.stop === undefined ? {} : { stop: text(program.stop) }) }; };
  const runtime = row.runtime === null ? null : record(row.runtime), terminal = row.terminal === null ? null : record(row.terminal), script = row.script === null ? null : record(row.script);
  return { harnessId: text(row.harnessId), ref: text(row.ref), checkedAt: text(row.checkedAt), fingerprint: text(row.fingerprint), expiresAt: text(row.expiresAt), label: text(row.label),
    role: choice(row.role, ["product", "adapter"]), channel: choice(row.channel, ["npm", "brew-formula", "brew-cask", "script", "uv"]), kind: choice(row.kind, ["version", "self-update", "rerun", "terminal"]),
    current: nullableText(row.current), target: nullableText(row.target), prerelease: bool(row.prerelease), runs: text(row.runs), writes: list(row.writes, text, 16),
    script: script === null ? null : { source: text(script.source), sha256: text(script.sha256) }, shellProfile: nullableText(row.shellProfile), configFiles: list(row.configFiles, text, 8),
    dependencies: list(row.dependencies, text, 64), sharedRuntimes: list(row.sharedRuntimes, text, 64),
    runtime: runtime === null ? null : { runtime: choice(runtime.runtime, ["Node.js"]), required: text(runtime.required), found: nullableText(runtime.found), path: text(runtime.path),
      satisfied: bool(runtime.satisfied), service: nullableText(runtime.service), restarted: bool(runtime.restarted), upgradeCommand: nullableText(runtime.upgradeCommand) },
    active: bool(row.active), conversations: list(row.conversations, item => { const conversation = record(item); return { sessionId: text(conversation.sessionId), title: text(conversation.title), busy: bool(conversation.busy) }; }, 256),
    otherUsers: list(row.otherUsers, item => ({ pid: number(record(item).pid) }), 256), processes: list(row.processes, entry, 128),
    terminal: terminal === null ? null : { command: text(terminal.command), explains: text(terminal.explains), localChanges: terminal.localChanges === null ? null : number(terminal.localChanges) },
    notes: list(row.notes, text, 16), blocked: nullableText(row.blocked) };
}
/** What installing a missing product the official way would run and change (ADR-044). */
export function decodeInstallCheck(value: unknown): InstallCheckView {
  const row = record(value), terminal = record(row.terminal), prefix = row.prefix === null ? null : record(row.prefix), runtime = row.runtime === null ? null : record(row.runtime);
  return { harnessId: text(row.harnessId), checkedAt: text(row.checkedAt), fingerprint: text(row.fingerprint), expiresAt: text(row.expiresAt), method: choice(row.method, ["script", "npm"]),
    officialCommand: text(row.officialCommand), docs: text(row.docs), source: text(row.source), sha256: nullableText(row.sha256), runs: text(row.runs), writes: list(row.writes, text, 16),
    shellProfile: nullableText(row.shellProfile), configFiles: list(row.configFiles, text, 8), version: nullableText(row.version),
    prefix: prefix === null ? null : { label: text(prefix.label), path: text(prefix.path) },
    runtime: runtime === null ? null : { runtime: choice(runtime.runtime, ["Node.js"]), required: text(runtime.required), found: nullableText(runtime.found), path: text(runtime.path),
      satisfied: bool(runtime.satisfied), service: nullableText(runtime.service), restarted: bool(runtime.restarted), upgradeCommand: nullableText(runtime.upgradeCommand) },
    terminal: { command: text(terminal.command), before: nullableText(terminal.before), after: choice(terminal.after, ["this", "unchanged", "not-on-path"]) },
    notes: list(row.notes, text, 16), blocked: nullableText(row.blocked) };
}
/** What uninstalling one installation would remove, stop and leave (ADR-044). */
export function decodeUninstallCheck(value: unknown): UninstallCheckView {
  const row = record(value), entry = (item: unknown) => { const program = record(item); return { pid: number(program.pid), name: text(program.name), ...(program.stop === undefined ? {} : { stop: text(program.stop) }) }; };
  const after = record(row.after), kind = choice(after.kind, ["next", "none", "unchanged"]);
  return { harnessId: text(row.harnessId), ref: text(row.ref), checkedAt: text(row.checkedAt), fingerprint: text(row.fingerprint), channel: choice(row.channel, ["npm", "brew-formula", "brew-cask", "script", "uv"]),
    label: text(row.label), role: choice(row.role, ["product", "adapter"]), version: nullableText(row.version), active: bool(row.active),
    commands: list(row.commands, text, 16), removes: list(row.removes, text, 32), skipped: list(row.skipped, item => { const skipped = record(item); return { path: text(skipped.path), reason: text(skipped.reason) }; }, 16),
    documented: bool(row.documented), kept: list(row.kept, text, 16),
    services: list(row.services, item => { const service = record(item); return { label: text(service.label), name: text(service.name), pid: number(service.pid), commands: list(service.commands, text, 8), interrupts: text(service.interrupts) }; }, 16),
    undeclaredServices: list(row.undeclaredServices, item => { const service = record(item); return { label: text(service.label), pid: number(service.pid) }; }, 64),
    resident: list(row.resident, entry, 64), processes: list(row.processes, entry, 64),
    conversations: list(row.conversations, item => { const conversation = record(item); return { sessionId: text(conversation.sessionId), title: text(conversation.title), busy: bool(conversation.busy) }; }, 256),
    otherUsers: list(row.otherUsers, item => ({ pid: number(record(item).pid) }), 256), localChanges: row.localChanges === null ? null : number(row.localChanges),
    after: kind === "next" ? { kind, label: text(after.label), version: nullableText(after.version) } : { kind } };
}
/** A release's Node.js range against one runtime that will run it (ADR-043). */
function decodeRuntime(value: unknown): RuntimeRequirement {
  const runtime = record(value);
  return { runtime: choice(runtime.runtime, ["Node.js"]), required: text(runtime.required), found: nullableText(runtime.found), path: text(runtime.path),
    satisfied: bool(runtime.satisfied), service: nullableText(runtime.service), restarted: bool(runtime.restarted), upgradeCommand: nullableText(runtime.upgradeCommand) };
}
/** A product's documented upgrade sequence as the confirmation shows it (ADR-052). */
function decodeSequence(value: unknown): UpgradeSequenceCheck {
  const row = record(value), gateway = row.gateway === null ? null : record(row.gateway), doctor = record(row.doctor);
  return { hops: list(row.hops, item => { const hop = record(item); return { version: text(hop.version), bridge: bool(hop.bridge), runtimes: list(hop.runtimes, decodeRuntime, 32) }; }, 4), commands: list(row.commands, text, 32),
    gateway: gateway === null ? null : { label: text(gateway.label), name: text(gateway.name), pid: number(gateway.pid) },
    restarts: list(row.restarts, item => { const service = record(item); return { label: text(service.label), name: text(service.name), pid: number(service.pid), command: text(service.command) }; }, 16),
    backupCommand: text(row.backupCommand), doctor: { command: text(doctor.command), rewrites: list(doctor.rewrites, text, 8), backups: text(doctor.backups) }, rollback: text(row.rollback) };
}
/** What upgrading a Harness would touch (ADR-043). */
export function decodeMaintenance(value: unknown): MaintenanceView {
  const row = record(value), entry = (item: unknown) => { const program = record(item); return { pid: number(program.pid), name: text(program.name) }; };
  return { harnessId: text(row.harnessId), checkedAt: text(row.checkedAt), fingerprint: text(row.fingerprint), channel: text(row.channel), location: text(row.location),
    currentVersion: nullableText(row.currentVersion), targetVersion: nullableText(row.targetVersion), servicesKnown: bool(row.servicesKnown),
    restart: list(row.restart, item => { const service = record(item); return { label: text(service.label), name: text(service.name), pid: number(service.pid), command: text(service.command), portKnown: bool(service.portKnown) }; }, 16),
    resident: list(row.resident, item => { const program = record(item); return { label: nullableText(program.label), name: text(program.name), pid: number(program.pid), restartCommand: nullableText(program.restartCommand) }; }, 96),
    processes: list(row.processes, entry, 64),
    conversations: list(row.conversations, item => { const conversation = record(item); return { sessionId: text(conversation.sessionId), title: text(conversation.title), busy: bool(conversation.busy) }; }, 256),
    otherUsers: list(row.otherUsers, item => ({ pid: number(record(item).pid) }), 256), staleRecords: number(row.staleRecords),
    plugins: list(row.plugins, text, 32), notes: list(row.notes, text, 16), rollback: nullableText(row.rollback),
    runtimes: list(row.runtimes, decodeRuntime, 32), ...(row.sequence === undefined ? {} : { sequence: decodeSequence(row.sequence) }) };
}
function decodeCapabilityFacts(value: unknown): CapabilityFacts {
  const row = record(value);
  switch (choice(row.kind, CAPABILITY_KINDS)) {
    case "skill": return { kind: "skill", files: number(row.files), bytes: number(row.bytes) };
    case "mcp": return { kind: "mcp", transport: choice(row.transport, ["stdio", "http", "sse", "unknown"]), program: nullableText(row.program), host: nullableText(row.host), variables: list(row.variables, text, 64),
      headers: list(row.headers, text, 64), references: number(row.references), literal: number(row.literal), enabled: bool(row.enabled) };
    case "instructions": return { kind: "instructions", bytes: number(row.bytes), managedBlocks: list(row.managedBlocks, text, 16) };
    case "subagent": return { kind: "subagent", format: choice(row.format, ["markdown", "toml"]) };
    case "command": return { kind: "command", format: choice(row.format, ["markdown", "toml"]) };
    case "hook": return { kind: "hook", event: text(row.event), matcher: nullableText(row.matcher), program: nullableText(row.program) };
    case "plugin": return { kind: "plugin", version: nullableText(row.version), enabled: row.enabled === null ? null : bool(row.enabled), switchable: bool(row.switchable) };
  }
}
function decodeCapabilityEdge(value: unknown): CapabilityEdge {
  const row = record(value);
  return { harnessId: text(row.harnessId), mechanism: choice(row.mechanism, CAPABILITY_MECHANISMS), status: choice(row.status, CAPABILITY_STATUSES), via: text(row.via), reason: nullableText(row.reason),
    ...(row.facts === undefined ? {} : { facts: decodeCapabilityFacts(row.facts) }) };
}
/** The capability view (ADR-045 step 1), validated field by field. */
export function decodeCapabilities(value: unknown): CapabilitiesView {
  const row = record(value), kindsOf = (item: unknown) => { const kinds = record(item); return Object.fromEntries(CAPABILITY_KINDS.map(kind => [kind, choice(kinds[kind], ["read", "unsupported", "invisible"])])) as CapabilitiesView["harnesses"][number]["kinds"]; };
  return { checkedAt: text(row.checkedAt), truncated: bool(row.truncated),
    harnesses: list(row.harnesses, item => { const harness = record(item); return { harnessId: text(harness.harnessId), name: text(harness.name), version: nullableText(harness.version),
      kinds: kindsOf(harness.kinds), skillSwitch: harness.skillSwitch === null ? null : choice(harness.skillSwitch, ["file", "command"]),
      pluginSwitch: harness.pluginSwitch === null ? null : choice(harness.pluginSwitch, ["file"]), pluginReason: nullableText(harness.pluginReason), shared: decodeSharedReads(harness.shared), notes: list(harness.notes, text, 64) }; }, 64),
    entries: list(row.entries, item => { const entry = record(item); return { kind: choice(entry.kind, CAPABILITY_KINDS), key: text(entry.key), name: text(entry.name), description: nullableText(entry.description),
      owner: choice(entry.owner, CAPABILITY_OWNERS), source: nullableText(entry.source), location: nullableText(entry.location), edges: list(entry.edges, decodeCapabilityEdge, 256),
      warnings: list(entry.warnings, warning => { const fields = record(warning); return { kind: choice(fields.kind, CAPABILITY_WARNINGS), harnessId: nullableText(fields.harnessId), text: text(fields.text) }; }, 256),
      ...(entry.facts === undefined ? {} : { facts: decodeCapabilityFacts(entry.facts) }),
      ...(entry.shared === undefined ? {} : { shared: (() => { const shared = record(entry.shared); return { folder: text(shared.folder), placed: list(shared.placed, text, 16) }; })() }) }; }, MAX_CAPABILITY_ENTRIES),
    unreadable: list(row.unreadable, item => { const fields = record(item); return { harnessId: nullableText(fields.harnessId), file: text(fields.file), reason: text(fields.reason) }; }, 1024) };
}
function decodeSharedReads(value: unknown): CapabilitiesView["harnesses"][number]["shared"] {
  const row = record(value);
  return { reads: choice(row.reads, ["native", "external-dir", "links", "no"]), links: number(row.links), redundant: number(row.redundant), placeable: row.placeable === null ? null : choice(row.placeable, ["shared-dir", "skill-link"]) };
}
function decodeLink(value: unknown): CapabilityLinkChange {
  const row = record(value);
  return { path: text(row.path), target: text(row.target), action: choice(row.action, ["create", "remove"]), ...(row.owner === undefined ? {} : { owner: choice(row.owner, ["harnesshub", "other"]) }) };
}
function decodeSkillPlan(value: unknown): CapabilitySkillPlan {
  const row = record(value);
  return { name: text(row.name), folder: text(row.folder), action: choice(row.action, ["add", "update", "delete", "restore"]), files: number(row.files), bytes: number(row.bytes), executables: number(row.executables), plugin: bool(row.plugin),
    changes: list(row.changes, item => { const change = record(item); return { path: text(change.path), action: choice(change.action, ["add", "change", "remove"]) }; }, 256), overwrites: number(row.overwrites) };
}
export function decodeChangeCheck(value: unknown): CapabilityChangeCheck {
  const row = record(value);
  const rewrite = row.rewrite === null ? null : record(row.rewrite);
  const source = row.source === undefined || row.source === null ? row.source : record(row.source), lock = row.lock === undefined || row.lock === null ? row.lock : record(row.lock);
  const proceed = row.proceed === undefined || row.proceed === null ? row.proceed : record(row.proceed);
  return { kind: choice(row.kind, ["skill-switch", "shared-dir", "skill-link", "link-cleanup", "link-undo", "skill-add", "skill-update", "skill-delete", "skill-undo", "mcp-sync", "mcp-remove", "instructions-sync", "instructions-remove",
    "subagent-sync", "subagent-remove", "skill-create", "skill-edit", "plugin-switch"]),
    harnessId: text(row.harnessId), name: text(row.name), enabled: bool(row.enabled), file: text(row.file),
    ...(proceed === undefined ? {} : { proceed: proceed === null ? null : { option: choice(proceed.option, INSTRUCTION_CHECK_OPTIONS), label: text(proceed.label) } }),
    ...(row.skills === undefined ? {} : { skills: list(row.skills, decodeSkillPlan, 64) }),
    ...(source === undefined ? {} : { source: source === null ? null : { repository: text(source.repository), ref: nullableText(source.ref), commit: text(source.commit) } }),
    ...(lock === undefined ? {} : { lock: lock === null ? null : { file: text(lock.file), diff: text(lock.diff) } }),
    ...(row.orphans === undefined ? {} : { orphans: list(row.orphans, item => { const orphan = record(item); return { harnessId: text(orphan.harnessId), file: text(orphan.file) }; }, 64) }),
    command: nullableText(row.command), diff: nullableText(row.diff), links: list(row.links, decodeLink, 4096),
    rewrite: rewrite === null ? null : { target: text(rewrite.target), before: nullableText(rewrite.before), after: nullableText(rewrite.after), added: list(rewrite.added, text, 32), removed: list(rewrite.removed, text, 32),
      changed: list(rewrite.changed, text, 32), commentLines: number(rewrite.commentLines) },
    current: choice(row.current, ["harnesshub", "other", "none"]), notes: list(row.notes, text, 32), blocked: nullableText(row.blocked), fingerprint: text(row.fingerprint), expiresAt: text(row.expiresAt) };
}
export function decodeChange(value: unknown): CapabilityChangeView {
  const row = record(value), error = row.error === null ? null : record(row.error);
  return { id: text(row.id), kind: choice(row.kind, CAPABILITY_CHANGE_KINDS), harnessId: nullableText(row.harnessId), subject: text(row.subject), file: text(row.file), status: choice(row.status, ["applied", "failed"]),
    diff: nullableText(row.diff), backupId: nullableText(row.backupId), error: error === null ? null : { code: text(error.code), message: text(error.message) }, notes: list(row.notes, text, 32),
    ...(row.links === undefined ? {} : { links: list(row.links, decodeLink, 4096) }),
    ...(row.skills === undefined ? {} : { skills: list(row.skills, item => { const skill = record(item); return { name: text(skill.name), folder: text(skill.folder), before: nullableText(skill.before), after: nullableText(skill.after) }; }, 64) }),
    at: text(row.at) };
}
function decodeHistory(value: unknown): CapabilityHistory {
  const row = record(value);
  return { changes: list(row.changes, decodeChange, 64), backups: list(row.backups, item => { const backup = record(item); return { id: text(backup.id), file: text(backup.file), createdAt: text(backup.createdAt), bytes: number(backup.bytes),
    changeId: text(backup.changeId), subject: text(backup.subject) }; }, 4096),
    drift: list(row.drift, item => { const drift = record(item); return { id: text(drift.id), kind: choice(drift.kind, ["skill-switch", "shared-dir", "skill-link", "mcp", "instructions", "subagent", "plugin"]), harnessId: text(drift.harnessId), subject: text(drift.subject),
      file: text(drift.file), state: choice(drift.state, CAPABILITY_DRIFT_STATES), changeId: text(drift.changeId), at: text(drift.at) }; }, 4096),
    orphans: list(row.orphans, item => { const orphan = record(item); return { id: text(orphan.id), kind: choice(orphan.kind, ["skill", "plugin"]), harnessId: text(orphan.harnessId), subject: text(orphan.subject), file: text(orphan.file) }; }, 4096),
    snapshots: (() => { const snapshots = record(row.snapshots); return { count: number(snapshots.count), bytes: number(snapshots.bytes), keep: number(snapshots.keep) }; })() };
}
function decodeSkillListing(value: unknown): SkillSourceListing {
  const row = record(value);
  return { id: text(row.id), repository: text(row.repository), ref: nullableText(row.ref), commit: text(row.commit), expiresAt: text(row.expiresAt), skills: list(row.skills, item => {
    const skill = record(item);
    return { name: text(skill.name), installName: nullableText(skill.installName), description: nullableText(skill.description), folder: text(skill.folder), files: number(skill.files), bytes: number(skill.bytes),
      executables: number(skill.executables), plugin: bool(skill.plugin), state: choice(skill.state, ["new", "installed", "conflict", "refused"]), reason: nullableText(skill.reason) };
  }, 512) };
}
export function decodeMcpDefinition(value: unknown): McpDefinitionView {
  const row = record(value);
  return { transport: choice(row.transport, ["stdio", "http", "sse"]), command: nullableText(row.command), args: list(row.args, text, 128), cwd: nullableText(row.cwd), url: nullableText(row.url),
    env: list(row.env, item => { const env = record(item); return typeof env.variable === "string" ? { key: text(env.key), variable: text(env.variable) } : { key: text(env.key), value: text(env.value) }; }, 64),
    headers: list(row.headers, item => { const header = record(item); return typeof header.variable === "string" ? { name: text(header.name), variable: text(header.variable), prefix: text(header.prefix) } : { name: text(header.name), value: text(header.value) }; }, 64) };
}
function decodeMcpInventory(value: unknown): McpInventoryView {
  const row = record(value);
  return {
    servers: list(row.servers, item => { const server = record(item); return { name: text(server.name), definition: decodeMcpDefinition(server.definition), command: nullableText(server.command),
      variables: list(server.variables, entry => { const variable = record(entry); return { name: text(variable.name), set: bool(variable.set) }; }, 64),
      targets: list(server.targets, entry => { const target = record(entry); return { harnessId: text(target.harnessId), state: choice(target.state, MCP_TARGET_STATES), reason: nullableText(target.reason), file: nullableText(target.file) }; }, 32),
      updatedAt: text(server.updatedAt) }; }, 512),
    candidates: list(row.candidates, item => { const candidate = record(item); return { id: text(candidate.id), name: text(candidate.name), definition: candidate.definition === null ? null : decodeMcpDefinition(candidate.definition),
      problem: nullableText(candidate.problem), foundIn: list(candidate.foundIn, entry => { const found = record(entry); return { harnessId: text(found.harnessId), file: text(found.file) }; }, 32),
      state: choice(candidate.state, ["new", "listed", "different"]) }; }, 512),
    harnesses: list(row.harnesses, item => { const harness = record(item); return { harnessId: text(harness.harnessId), name: text(harness.name), writable: bool(harness.writable), reason: nullableText(harness.reason) }; }, 32),
  };
}
function decodeSubagents(value: unknown): SubagentInventoryView {
  const row = record(value);
  return {
    subagents: list(row.subagents, item => { const agent = record(item), definition = record(agent.definition); return { name: text(agent.name), definition: { description: text(definition.description), prompt: text(definition.prompt) },
      targets: list(agent.targets, entry => { const target = record(entry); return { harnessId: text(target.harnessId), state: choice(target.state, MCP_TARGET_STATES), reason: nullableText(target.reason), file: nullableText(target.file) }; }, 32),
      updatedAt: text(agent.updatedAt) }; }, 512),
    harnesses: list(row.harnesses, item => { const harness = record(item); return { harnessId: text(harness.harnessId), name: text(harness.name), writable: bool(harness.writable), reason: nullableText(harness.reason) }; }, 32),
  };
}
function decodeInstructions(value: unknown): InstructionsView {
  const row = record(value), shared = record(row.shared);
  return { shared: { text: text(shared.text), updatedAt: nullableText(shared.updatedAt) }, limitBytes: number(row.limitBytes),
    additions: list(row.additions, item => { const addition = record(item); return { harnessId: text(addition.harnessId), text: text(addition.text), updatedAt: text(addition.updatedAt) }; }, 32),
    targets: list(row.targets, item => { const target = record(item); return { harnessId: text(target.harnessId), name: text(target.name), file: nullableText(target.file), state: choice(target.state, INSTRUCTION_TARGET_STATES),
      reason: nullableText(target.reason), effect: nullableText(target.effect), cautions: list(target.cautions, text, 8) }; }, 32) };
}
function decodeSkillUpdates(value: unknown): SkillUpdateView {
  const row = record(value);
  return { checkedAt: text(row.checkedAt), skills: list(row.skills, item => {
    const skill = record(item);
    return { name: text(skill.name), manager: choice(skill.manager, ["harnesshub", "skills-cli"]), repository: nullableText(skill.repository), state: choice(skill.state, ["current", "available", "gone", "unknown", "unsupported"]),
      modified: skill.modified === null ? null : bool(skill.modified), reason: nullableText(skill.reason) };
  }, 4096) };
}
function decodeRestoreCheck(value: unknown): CapabilityRestoreCheck {
  const row = record(value);
  return { backupId: text(row.backupId), file: text(row.file), diff: text(row.diff), changedSince: bool(row.changedSince), notes: list(row.notes, text, 32), fingerprint: text(row.fingerprint), expiresAt: text(row.expiresAt) };
}
function decodeLogPage(value: unknown): InstallationLogPage {
  const row = record(value);
  return { entries: list(row.entries, value => { const item = record(value); return { seq: number(item.seq), time: text(item.time), stream: choice(item.stream, ["stdout", "stderr", "system"]), text: text(item.text) }; }, 256), nextSeq: number(row.nextSeq), hasMore: bool(row.hasMore) };
}
function decodeSummary(value: unknown): SessionSummary {
  const row = record(value);
  return { id: text(row.id), title: text(row.title), status: choice(row.status, SESSION_STATES), workspace: text(row.workspace),
    selection: selection(row.selection), updatedSeq: number(row.updatedSeq), activeRunId: nullableText(row.activeRunId) };
}
function decodeMessage(value: unknown): PublicMessage {
  const row = record(value);
  return { id: messageId(row.id), runId: runId(row.runId), role: choice(row.role, ["user", "assistant"]), text: text(row.text), seq: number(row.seq), status: choice(row.status, RUN_STATES) };
}
function contentRef(value: unknown): ContentRef { try { return parseContentRef(value); } catch { return invalid(); } }
function nativeInputs(value: unknown): NativeInputs { const row = record(value); return { image: bool(row.image), audio: bool(row.audio), file: bool(row.file) }; }
/** Marks a request body that is sent as raw bytes with its own media type instead of JSON. */
class RawBody { constructor(readonly blob: Blob) {} }
function optionalNumber(value: unknown): number | undefined { return value === undefined ? undefined : number(value); }
/** When the Run reached its phases; each present phase is a finite number, as the Gateway recorded it. */
function decodeTiming(value: unknown): NonNullable<PublicRun["timing"]> {
  const row = record(value), at = (raw: unknown) => { const time = number(raw); return time; };
  return { acceptedAt: at(row.acceptedAt), ...(["preparingAt", "readyAt", "dispatchedAt", "firstOutputAt", "endedAt"] as const).reduce((phases, name) => row[name] === undefined ? phases : { ...phases, [name]: at(row[name]) }, {}) };
}
function decodeRun(value: unknown): PublicRun {
  const row = record(value);
  const backend = row.backend === null ? null : record(row.backend);
  const cleanup = row.cleanup === null ? null : record(row.cleanup);
  if (cleanup !== null && cleanup.closed !== true) return invalid();
  return { id: runId(row.id), commandId: commandId(row.commandId), input: text(row.input), userMessageId: messageId(row.userMessageId),
    assistantMessageId: messageId(row.assistantMessageId), selection: selection(row.selection), epoch: number(row.epoch),
    status: choice(row.status, RUN_STATES), cancelRequested: bool(row.cancelRequested), contextThroughSeq: number(row.contextThroughSeq),
    sourceRunIds: list(row.sourceRunIds, runId, 256), backend: backend === null ? null : { status: choice(backend.status, ["completed", "cancelled", "failed"]), reason: text(backend.reason),
      ...(backend.error === undefined ? {} : { error: publicError(backend.error) ?? invalid() }) },
    cleanup: cleanup === null ? null : { closed: true, exitCode: nullableNumber(cleanup.exitCode), signal: nullableText(cleanup.signal), protocolFailure: publicError(cleanup.protocolFailure) },
    error: publicError(row.error),
    ...(row.attachments === undefined ? {} : { attachments: list(row.attachments, contentRef, 8) }), ...(row.timing === undefined ? {} : { timing: decodeTiming(row.timing) }),
    ...(row.retained === undefined ? {} : { retained: row.retained === true ? true as const : invalid() }), ...(row.reused === undefined ? {} : { reused: row.reused === true ? true as const : invalid() }),
    ...relayField(row.relay), ...protocolField(row.protocol), stopRequested: bool(row.stopRequested), awaitingSwitchId: row.awaitingSwitchId === null ? null : switchId(row.awaitingSwitchId) };
}
/**
 * The relay facts a Turn carries (which packet, how its context continued, where it ran, and the delivery a newer Gateway
 * adds). They are read leniently: a Gateway without them, or with a member this page does not know, gives a Turn without
 * relay facts, never an invalid response (the page then shows no relay information for that Turn).
 */
function relayField(value: unknown): Pick<PublicRun, "relay"> {
  const relay = value === undefined ? null : decodeRunRelay(value);
  return relay === null ? {} : { relay };
}
/**
 * The Run as the protocol (hh/1) tells it: the one record the page draws a Run from. A Gateway that gives none, or one whose Turn this
 * page cannot read (decodeProtocolTurn), gives a Run with the reason instead, which the page says where the Turn would be; an item
 * of a type the page does not know is kept as one line saying so, never an invalid response.
 */
function protocolField(value: unknown): Pick<PublicRun, "protocol" | "protocolProblem"> {
  const read = decodeProtocolTurn(value);
  return "turn" in read ? { protocol: read.turn } : { protocolProblem: read.problem };
}
function decodeSwitch(value: unknown): PublicSwitch {
  const row = record(value);
  return { id: switchId(row.id), commandId: commandId(row.commandId), requested: requestedSelection(row.requested), requestedSeq: number(row.requestedSeq),
    target: row.target === null ? null : selection(row.target), status: choice(row.status, ["requested", "validated", "effective", "failed"]),
    throughSeq: number(row.throughSeq), sourceRunIds: list(row.sourceRunIds, runId, 256), error: publicError(row.error) };
}
function decodeKeptProcess(value: unknown): KeptProcessView {
  const row = record(value);
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), since: number(row.since), lastUsedAt: number(row.lastUsedAt), idleEndsAt: number(row.idleEndsAt), backgroundUpdates: number(row.backgroundUpdates) };
}
/** One frame of waiting approvals and questions (ADR-035); at most 32 items, each checked field by field. */
export function decodeAttentionFrame(value: unknown): AttentionFrame {
  const row = record(value);
  return { revision: number(row.revision), items: list(row.items, value => {
    const item = record(value);
    const decoded: AttentionItem = { sessionId: sessionId(text(item.sessionId)), permissionId: text(item.permissionId), runId: text(item.runId), harnessId: text(item.harnessId),
      kind: choice(item.kind, ["approval", "question"]), requestedAt: number(item.requestedAt),
      ...(item.expiresAt === undefined ? {} : { expiresAt: number(item.expiresAt), expiresBy: choice(item.expiresBy, ["native", "turn"]) }) };
    return decoded;
  }, 32) };
}
export function decodeSession(value: unknown): SessionView {
  const row = record(value);
  return { id: text(row.id), version: number(row.version), lastSeq: number(row.lastSeq), epoch: number(row.epoch), status: choice(row.status, SESSION_STATES),
    workspace: text(row.workspace), selection: selection(row.selection), activeRunId: nullableText(row.activeRunId), pendingSwitchId: nullableText(row.pendingSwitchId),
    ...(row.retention === undefined ? {} : { retention: (() => { const retention = record(row.retention); return { enabled: bool(retention.enabled), process: retention.process === null ? null : decodeKeptProcess(retention.process),
      ...(retention.lost === undefined ? {} : { lost: (() => { const lost = record(retention.lost); return { outcome: choice(lost.outcome, ["terminated", "gone", "unconfirmed"]), leaseReleased: bool(lost.leaseReleased), at: number(lost.at) }; })() }),
      ...(retention.outside === undefined ? {} : { outside: (() => { const outside = record(retention.outside); return { count: number(outside.count), at: number(outside.at) }; })() }),
      ...(retention.upgraded === undefined ? {} : { upgraded: (() => { const upgraded = record(retention.upgraded); return { harnessId: text(upgraded.harnessId), at: number(upgraded.at) }; })() }) }; })() }),
    ...(row.queue === undefined ? {} : { queue: (() => { const queue = record(row.queue), kind = choice(queue.kind, ["slot"]);
      return { kind, runId: text(queue.runId), running: number(queue.running), limit: number(queue.limit), since: number(queue.since) }; })() }),
    ...(row.nativeStates === undefined ? {} : { nativeStates: list(row.nativeStates, value => { const state = record(value);
      return { harnessId: text(state.harnessId), controlId: text(state.controlId), status: choice(state.status, ["ready", "unconfirmed", "forking"]),
        ...(state.observed === undefined ? {} : { observed: (() => { const observed = record(state.observed); return { model: observed.model === null ? null : text(observed.model), options: parseNativeOptions(observed.options) }; })() }),
        ...(state.carried === undefined ? {} : { carried: (() => { const carried = record(state.carried);
          return { ...(carried.model === undefined ? {} : { model: text(carried.model) }), ...(carried.options === undefined ? {} : { options: parseNativeOptions(carried.options) }) }; })() }) }; }, 256) }),
    ...(row.origin === undefined ? {} : { origin: (() => { const origin = record(row.origin);
      const history = list(origin.history, value => { const message = record(value);
        return { role: choice(message.role, ["user", "assistant"]), text: text(message.text), status: choice(message.status, RUN_STATES), ...(message.harnessId === undefined ? {} : { harnessId: text(message.harnessId) }), ...(message.attachments === undefined ? {} : { attachments: list(message.attachments, contentRef, 8) }) }; }, 512);
      if (origin.kind === "import") return { kind: "import" as const, harnessId: text(origin.harnessId), title: nullableText(origin.title), omitted: number(origin.omitted), complete: bool(origin.complete), historyRead: bool(origin.historyRead), history };
      if (origin.kind !== "fork") return invalid();
      return { kind: "fork" as const, sessionId: sessionId(origin.sessionId), throughRunId: runId(origin.throughRunId), history }; })() }),
    ...(row.permissions===undefined?{}:{permissions:list(row.permissions, value => { const request=record(value);return {id:text(request.id),runId:text(request.runId),title:text(request.title),decided:bool(request.decided),requestedAt:number(request.requestedAt),
      ...(request.expiresAt===undefined?{}:{expiresAt:number(request.expiresAt),expiresBy:choice(request.expiresBy,["native","turn"])}),...(request.kind===undefined?{}:{kind:choice(request.kind,["question"])}), ...(request.detail===undefined?{}:{detail:text(request.detail)}),...(request.input===undefined?{}:{input:(()=>{const value=record(request.input);return {kind:choice(value.kind,["text","editor","secret"]),value:text(value.value)};})()}),options:list(request.options,value=>{const option=record(value);return {id:text(option.id),name:text(option.name)};},128)};},32)}), messages: list(row.messages, decodeMessage, 1024), runs: list(row.runs, decodeRun, 256), switches: list(row.switches, decodeSwitch, 1024) };
}
/** Decodes only canonical public facts; stream framing and projection validate their watermarks. */
export function decodeSessionStreamFrame(value: unknown): SessionStreamFrame {
  const row = record(value);
  const keys = row.type === "snapshot" ? ["type", "session"] : row.type === "run" ? ["type", "sessionId", "version", "lastSeq", "run"] : row.type === "relay" ? ["type", "sessionId", "version", "lastSeq", "event"] : ["type", "sessionId", "version", "lastSeq", "message"];
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) return invalid();
  if (row.type === "snapshot") return { type: "snapshot", session: decodeSession(row.session) };
  if (row.type === "relay") {
    // A notice of a relay event: the facts it follows are already here (same watermark), so it is read for its event and takes nothing.
    const version = number(row.version), lastSeq = number(row.lastSeq), event = decodeRelayStreamEvent(row.event);
    if (version < 1 || lastSeq < 0 || event === null) return invalid();
    return { type: "relay", sessionId: text(row.sessionId), version, lastSeq, event };
  }
  if (row.type === "run") { const version = number(row.version), lastSeq = number(row.lastSeq); if (version < 1 || lastSeq < 0) return invalid(); return { type: "run", sessionId: text(row.sessionId), version, lastSeq, run: decodeRun(row.run) }; }
  if (row.type !== "message") return invalid();
  const version = number(row.version), lastSeq = number(row.lastSeq), message = decodeMessage(row.message);
  if (version < 1 || lastSeq < 0 || message.role !== "assistant" || message.seq < 0 || message.seq > lastSeq) return invalid();
  return { type: "message", sessionId: text(row.sessionId), version, lastSeq, message };
}
function decodeReadiness(value: unknown): HarnessReadinessView {
  const row = record(value), state = choice(row.state, ["ready", "signed_out", "failed", "unchecked"]);
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), state, checkedAt: nullableNumber(row.checkedAt),
    ...(row.signedIn === undefined ? {} : { signedIn: row.signedIn === null ? null : bool(row.signedIn) }), ...(row.failureCode === undefined ? {} : { failureCode: text(row.failureCode) }),
    ...(row.startupMs === undefined ? {} : { startupMs: number(row.startupMs) }) };
}
function decodeState(value: unknown): WebState {
  const row = record(value);
  return { ...(row.providerManagement === undefined ? {} : { providerManagement: bool(row.providerManagement) }), workspace: text(row.workspace), providers: list(row.providers, decodeProvider, 256), harnesses: list(row.harnesses, decodeHarness, 256),
    harnessesScannedAt: isoTime(row.harnessesScannedAt), sessions: list(row.sessions, decodeSummary, 1000), jobs: list(row.jobs, decodeInstallationJob, 100),
    readiness: list(row.readiness, decodeReadiness, 512), installationPolicy: choice(row.installationPolicy, ["official", "any"]) };
}
function decodeAuth(value: unknown): AuthSession { return { csrfToken: text(record(value).csrfToken) }; }
function acknowledge(value: unknown, session: string, result: "runId" | "switchId" | "target"): void {
  const row = record(value);
  if (row.sessionId !== session || Object.keys(row).some(key => !["sessionId", result, "replayed"].includes(key))) return invalid();
  bool(row.replayed);
  try {
    if (result === "switchId") switchId(text(row.switchId));
    else if (result === "runId") runId(text(row.runId));
    else if (row.target !== null) runId(text(row.target));
  } catch { return invalid(); }
}

let pageBootstrapToken: string | null | undefined;
function bootstrapToken(): string | null {
  // React may invoke state initializers twice. Read and clear the URL exactly once for this page.
  if (pageBootstrapToken !== undefined) return pageBootstrapToken;
  pageBootstrapToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (pageBootstrapToken !== null) {
    const hash = new URLSearchParams(window.location.hash.slice(1)); hash.delete("token");
    window.history.replaceState(null, "", window.location.pathname + window.location.search + (hash.size ? "#" + hash.toString() : ""));
  }
  return pageBootstrapToken;
}
/** One browser tab owns authentication and requests. Credentials only travel to the same-origin local API. */
export class GatewayApi {
  private csrfToken: string | null = null;
  private bootstrapToken: string | null = null;
  private authentication: Promise<void> | null = null;
  /** The relay's data layer (web/src/relay.ts): what a conversation's relay is, the text of its packets, the relay preferences. */
  readonly relay: RelayApi;
  /** Whether the Gateway's last state said it has the relay API (`relay: true`, an optional member of its state; see lib/use-relay.ts). */
  relayAdvertised = false;
  constructor() {
    this.bootstrapToken = bootstrapToken();
    this.relay = createRelayApi(this.relayTransport());
  }
  /**
   * The relay data layer's one door to the Gateway: the page's credentials, the same deadline as every request, a bounded
   * body, and an answer for every HTTP status, since a missing relay endpoint is an answer the page copes with.
   */
  private relayTransport(): RelayTransport {
    return { send: async ({ method, path, body, as, signal }): Promise<RelayReply> => {
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError")), 15_000);
      const attempt = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      try {
        const response = await fetch("/api/v1" + path, { method, credentials: "same-origin", signal: attempt,
          headers: { Accept: as === "text" ? "text/plain" : "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(this.csrfToken === null || method === "GET" ? {} : { "X-CSRF-Token": this.csrfToken }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const read = await readBoundedText(response, as === "text" ? RELAY_TEXT_BYTES : 4 * 1024 * 1024);
        const etag = response.headers.get("ETag")?.replace(/^W\//u, "").replace(/^"|"$/gu, "") || null;
        // A packet's text is plain text: a page of any other type (an answer in place of a missing route) is not a packet.
        if (as === "text") return { status: response.status, body: response.headers.get("Content-Type")?.toLowerCase().startsWith("text/plain") ? read ?? undefined : undefined, etag };
        let parsed: unknown;
        try { parsed = read === null || read === "" ? undefined : JSON.parse(read); } catch { parsed = undefined; }
        return { status: response.status, body: parsed, etag };
      } catch (error: unknown) {
        if (signal?.aborted) throw error;
        if (deadline.signal.aborted) throw new ApiError("REQUEST_TIMEOUT", "请求响应超时，请确认已接收的结果后重试。");
        throw new ApiError("NETWORK_ERROR", "暂时无法连接本机网关。请确认服务仍在运行，再试一次。");
      } finally { clearTimeout(timeout); }
    } };
  }
  async authenticate(signal?: AbortSignal): Promise<void> {
    if (this.csrfToken !== null) return;
    if (this.authentication !== null) return this.authentication;
    this.authentication = this.authenticateOnce(signal);
    try { await this.authentication; } finally { this.authentication = null; }
  }
  private async authenticateOnce(signal?: AbortSignal): Promise<void> {
    let auth: AuthSession;
    if (this.bootstrapToken === null) auth = await this.request("/auth/session", "GET", undefined, decodeAuth, signal);
    else {
      try { auth = await this.request("/auth/bootstrap", "POST", { token: this.bootstrapToken }, decodeAuth, signal); }
      catch (error: unknown) {
        if (!(error instanceof ApiError) || error.code !== "AUTH_REQUIRED") throw error;
        // A reused launch URL cannot consume its token again; an existing authenticated cookie may still be valid.
        auth = await this.request("/auth/session", "GET", undefined, decodeAuth, signal);
      }
    }
    this.csrfToken = auth.csrfToken;
    this.bootstrapToken = null;
    pageBootstrapToken = null;
  }
  state(signal?: AbortSignal): Promise<WebState> {
    return this.request("/state", "GET", undefined, value => { this.relayAdvertised = typeof value === "object" && value !== null && (value as Record<string, unknown>).relay === true; return decodeState(value); }, signal);
  }
  /** What the latest catalog reads and Runs showed of each Harness entry; reading it starts nothing. */
  readiness(signal?: AbortSignal): Promise<readonly HarnessReadinessView[]> { return this.request("/harnesses/readiness", "GET", undefined, value => list(record(value).readiness, decodeReadiness, 512), signal); }
  nativeModels(harness: string, control: string, workspace: string, signal: AbortSignal, refresh = false, nativeModel?: string): Promise<NativeModelCatalog> {
    const query = new URLSearchParams({ controlId: control, workspace, ...(refresh ? { refresh: "1" } : {}), ...(nativeModel ? { nativeModel } : {}) });
    return this.request(`/harnesses/${encodeURIComponent(harness)}/models?${query}`, "GET", undefined, value => {
      const row = record(value), models = list(row.models, value => { const model = record(value); return { id: text(model.id), name: text(model.name), ...(model.options === undefined ? {} : { options: list(model.options,nativeOption,128) }), ...(model.inputs === undefined ? {} : { inputs: nativeInputs(model.inputs) }) }; }, 4096);
      if (new Set(models.map(model => model.id)).size !== models.length) return invalid();
      return { models, defaultModel: nullableText(row.defaultModel), authentication: choice(row.authentication, ["ready", "missing", "unknown"]), canSelect: bool(row.canSelect), ...(row.selectionError === undefined ? {} : {selectionError:publicError(row.selectionError)??invalid()}), ...(row.options === undefined ? {} : { options: list(row.options,nativeOption,128) }), ...(row.commands === undefined ? {} : { commands: list(row.commands,value => {const command=record(value);return { name:text(command.name),description:text(command.description) };},2048) }), ...(row.inputs === undefined ? {} : { inputs: nativeInputs(row.inputs) }) };
    }, signal);
  }
  /** The selected Harness's own sessions in this workspace, newest first; `sessions` is null when it cannot list them. */
  nativeSessions(harness: string, control: string, workspace: string, cursor?: string, signal?: AbortSignal, probes = false): Promise<NativeSessionListView> {
    return this.request(`/harnesses/${encodeURIComponent(harness)}/native-sessions?${new URLSearchParams({ controlId: control, workspace, ...(cursor === undefined ? {} : { cursor }), ...(probes ? { probes: "include" } : {}) })}`, "GET", undefined, value => {
      const row = record(value), next = row.nextCursor === null ? null : text(row.nextCursor);
      if (row.sessions === null) return { sessions: null, nextCursor: null };
      return { nextCursor: next, ...(row.hiddenProbes === undefined ? {} : { hiddenProbes: number(row.hiddenProbes) }), sessions: list(row.sessions, value => { const item = record(value);
        return { id: text(item.id), title: nullableText(item.title), updatedAt: item.updatedAt === null ? null : number(item.updatedAt), ...(item.source === undefined ? {} : { source: text(item.source) }), ...(item.conversationId === undefined ? {} : { conversationId: text(item.conversationId) }) }; }, 1000) };
    }, signal);
  }
  /** The login shell's directories added to discovery (G(ii)). */
  loginShell(signal?: AbortSignal): Promise<LoginShellView> { return this.request("/discovery/login-shell", "GET", undefined, decodeLoginShell, signal); }
  /** Runs the login shell once to read its PATH, then rediscovers; this runs the user's shell login configuration. */
  readLoginShell(key: string): Promise<LoginShellView> { return this.request("/discovery/login-shell", "POST", { commandId: key }, decodeLoginShell); }
  removeLoginShellDirectory(dir: string, key: string): Promise<LoginShellView> { return this.request("/discovery/login-shell/remove", "POST", { dir, commandId: key }, decodeLoginShell); }
  /** How to continue the conversation's native session in its own program (ADR-039); null when there is nothing to show. */
  nativeResume(id: string, signal?: AbortSignal): Promise<NativeResumeView | null> {
    return this.request(`/sessions/${encodeURIComponent(id)}/native-resume`, "GET", undefined, value => {
      const row = record(value); if (row.resume === null) return null;
      const resume = record(row.resume), optional = (key: "nativeId" | "interactive" | "once" | "onceNote" | "list") => resume[key] === undefined ? {} : { [key]: text(resume[key]) };
      return { harnessId: text(resume.harnessId), ...optional("nativeId"), ...optional("interactive"), ...optional("once"), ...optional("onceNote"), ...optional("list"),
        ...(resume.note === undefined ? {} : { note: choice(resume.note, ["no-command"]) }) };
    }, signal);
  }
  /** Continues one listed native session as a new conversation; nothing is sent until the next message. */
  importNativeSession(workspace: string, selection: SelectionRequest, nativeId: string, key: string): Promise<SessionView> {
    return this.request("/sessions/import", "POST", { workspace, selection, nativeId, commandId: key }, decodeSession);
  }
  /** What every installed Harness reads besides its model (ADR-045 step 1); read from the user's files, nothing is written. */
  capabilities(signal?: AbortSignal): Promise<CapabilitiesView> { return this.request("/capabilities", "GET", undefined, decodeCapabilities, signal); }
  /** Prepares turning one skill off or on in one Harness and shows the exact change; nothing is written (ADR-045 §4). */
  checkSkillSwitch(harnessId: string, name: string, enabled: boolean, via: string | null): Promise<CapabilityChangeCheck> {
    return this.request("/capabilities/skill-switch?" + new URLSearchParams({ harnessId, name, enabled: String(enabled), ...(via === null ? {} : { via }) }), "GET", undefined, decodeChangeCheck);
  }
  /** Prepares turning one plugin off or on in Claude Code or Codex and shows the exact change; nothing is written (ADR-045 step 6a). */
  checkPluginSwitch(harnessId: string, id: string, enabled: boolean): Promise<CapabilityChangeCheck> {
    return this.request("/capabilities/plugin-switch?" + new URLSearchParams({ harnessId, id, enabled: String(enabled) }), "GET", undefined, decodeChangeCheck);
  }
  /** Prepares making Hermes read the shared skills directory, or stop; nothing is written. */
  checkSharedDir(harnessId: string, present: boolean): Promise<CapabilityChangeCheck> { return this.request("/capabilities/shared-dir?" + new URLSearchParams({ harnessId, present: String(present) }), "GET", undefined, decodeChangeCheck); }
  /** Prepares placing a shared skill in Claude Code by a link, or removing one HarnessHub placed; nothing is written. */
  checkSkillLink(harnessId: string, name: string, present: boolean): Promise<CapabilityChangeCheck> {
    return this.request("/capabilities/skill-link?" + new URLSearchParams({ harnessId, name, present: String(present) }), "GET", undefined, decodeChangeCheck);
  }
  /** Prepares removing a Harness's links into the shared directory that it does not need; nothing is written. */
  checkLinkCleanup(harnessId: string): Promise<CapabilityChangeCheck> { return this.request("/capabilities/link-cleanup?" + new URLSearchParams({ harnessId }), "GET", undefined, decodeChangeCheck); }
  /** Prepares undoing a change of links; nothing is written. */
  checkUndo(changeId: string): Promise<CapabilityChangeCheck> { return this.request("/capabilities/changes/" + encodeURIComponent(changeId) + "/undo", "GET", undefined, decodeChangeCheck); }
  /** Applies a confirmed check once; the same key returns the first result. */
  applyCapabilityChange(fingerprint: string, key: string): Promise<CapabilityChangeView> { return this.request("/capabilities/changes", "POST", { fingerprint, commandId: key }, decodeChange); }
  capabilityHistory(signal?: AbortSignal): Promise<CapabilityHistory> { return this.request("/capabilities/history", "GET", undefined, decodeHistory, signal); }
  checkRestore(backupId: string): Promise<CapabilityRestoreCheck> { return this.request("/capabilities/backups/" + encodeURIComponent(backupId) + "/restore", "GET", undefined, decodeRestoreCheck); }
  restoreBackup(fingerprint: string, key: string): Promise<CapabilityChangeView> { return this.request("/capabilities/restores", "POST", { fingerprint, commandId: key }, decodeChange); }
  /** Prepares putting back what HarnessHub wrote that is no longer in place, through that change's usual check; nothing is written. */
  checkReapply(driftId: string): Promise<CapabilityChangeCheck> { return this.request("/capabilities/drift/" + encodeURIComponent(driftId) + "/reapply", "GET", undefined, decodeChangeCheck); }
  /** Stops tracking what HarnessHub wrote that is no longer in place; no file changes. */
  forgetDrift(driftId: string): Promise<boolean> { return this.request("/capabilities/forget", "POST", { id: driftId }, value => bool(record(value).forgotten)); }
  /** Downloads a GitHub repository version and lists its skills for adding; nothing is written. */
  listSkillSource(source: string): Promise<SkillSourceListing> { return this.request("/capabilities/skill-sources?" + new URLSearchParams({ source }), "GET", undefined, decodeSkillListing); }
  checkSkillAdd(listing: string, names: readonly string[]): Promise<CapabilityChangeCheck> { return this.request("/capabilities/skill-add?" + new URLSearchParams({ listing, names: names.join(",") }), "GET", undefined, decodeChangeCheck); }
  /** Whether the skills with a known source have newer versions; kept ten minutes by the Gateway unless `refresh`. */
  skillUpdates(refresh: boolean, signal?: AbortSignal): Promise<SkillUpdateView> { return this.request("/capabilities/skill-updates" + (refresh ? "?refresh=1" : ""), "GET", undefined, decodeSkillUpdates, signal); }
  checkSkillUpdate(name: string, overwrite: boolean): Promise<CapabilityChangeCheck> { return this.request("/capabilities/skill-update?" + new URLSearchParams({ name, overwrite: String(overwrite) }), "GET", undefined, decodeChangeCheck); }
  checkSkillDelete(name: string): Promise<CapabilityChangeCheck> { return this.request("/capabilities/skill-delete?" + new URLSearchParams({ name }), "GET", undefined, decodeChangeCheck); }
  /** Checks writing a new skill from these texts into the shared directory; nothing is written. */
  checkSkillCreate(name: string, text: SkillTextView): Promise<CapabilityChangeCheck> { return this.request("/capabilities/skill-create", "POST", { name, ...text }, decodeChangeCheck); }
  /** Checks changing a skill HarnessHub wrote; `overwrite` replaces a folder changed since. */
  checkSkillEdit(name: string, text: SkillTextView, overwrite: boolean): Promise<CapabilityChangeCheck> { return this.request("/capabilities/skill-edit", "POST", { name, ...text, overwrite }, decodeChangeCheck); }
  /** The texts of a skill HarnessHub wrote, as its SKILL.md holds them now; null when it does not read as one. */
  skillText(name: string): Promise<SkillTextView | null> {
    return this.request("/capabilities/skill-text?" + new URLSearchParams({ name }), "GET", undefined, value => { const row = record(value); if (row.text === null) return null; const item = record(row.text); return { description: text(item.description), body: text(item.body) }; });
  }
  /** HarnessHub's MCP list with each server's state per Harness, and the servers the Harnesses already have. */
  mcpInventory(signal?: AbortSignal): Promise<McpInventoryView> { return this.request("/capabilities/mcp", "GET", undefined, decodeMcpInventory, signal); }
  /** Keeps a server in the list; `replace` changes a listed one. No Harness file changes. */
  saveMcpServer(name: string, definition: McpDefinitionView, replace: boolean): Promise<string> { return this.request("/capabilities/mcp/servers", "POST", { name, definition, replace }, value => text(record(value).name)); }
  removeMcpServer(name: string): Promise<boolean> { return this.request("/capabilities/mcp/servers/delete", "POST", { name }, value => bool(record(value).removed)); }
  /** Lists a server the Harnesses already have and records the identical entries in `claim` as HarnessHub's; no Harness file changes. */
  importMcpServer(candidate: string, claim: readonly string[]): Promise<readonly CapabilityChangeView[]> { return this.request("/capabilities/mcp/import", "POST", { candidate, claim }, value => list(value, decodeChange, 32)); }
  claimMcpServer(name: string, harnessIds: readonly string[]): Promise<readonly CapabilityChangeView[]> { return this.request("/capabilities/mcp/claim", "POST", { name, harnessIds }, value => list(value, decodeChange, 32)); }
  checkMcpSync(name: string, harnessId: string, overwrite: boolean): Promise<CapabilityChangeCheck> {
    return this.request("/capabilities/mcp/sync?" + new URLSearchParams({ name, harnessId, ...(overwrite ? { overwrite: "true" } : {}) }), "GET", undefined, decodeChangeCheck);
  }
  checkMcpRemove(name: string, harnessId: string): Promise<CapabilityChangeCheck> { return this.request("/capabilities/mcp/remove?" + new URLSearchParams({ name, harnessId }), "GET", undefined, decodeChangeCheck); }
  /** HarnessHub's subagent list with each subagent's state per Harness. */
  subagents(signal?: AbortSignal): Promise<SubagentInventoryView> { return this.request("/capabilities/subagents", "GET", undefined, decodeSubagents, signal); }
  /** Keeps a subagent in the list; `replace` changes a listed one. No Harness file changes. */
  saveSubagent(name: string, definition: SubagentDefinitionView, replace: boolean): Promise<string> { return this.request("/capabilities/subagents/save", "POST", { name, definition, replace }, value => text(record(value).name)); }
  removeSubagent(name: string): Promise<boolean> { return this.request("/capabilities/subagents/delete", "POST", { name }, value => bool(record(value).removed)); }
  claimSubagent(name: string, harnessIds: readonly string[]): Promise<readonly CapabilityChangeView[]> { return this.request("/capabilities/subagents/claim", "POST", { name, harnessIds }, value => list(value, decodeChange, 32)); }
  checkSubagent(action: "sync" | "remove", name: string, harnessId: string, overwrite: boolean): Promise<CapabilityChangeCheck> {
    return this.request("/capabilities/subagents/" + action + "?" + new URLSearchParams({ name, harnessId, ...(overwrite ? { overwrite: "true" } : {}) }), "GET", undefined, decodeChangeCheck);
  }
  /** HarnessHub's instructions and where they stand in each Harness. */
  instructions(signal?: AbortSignal): Promise<InstructionsView> { return this.request("/capabilities/instructions", "GET", undefined, decodeInstructions, signal); }
  /** Saves the shared text and each Harness's addition in HarnessHub; no Harness file changes. */
  saveInstructions(shared: string, additions: Readonly<Record<string, string>>): Promise<InstructionsView> { return this.request("/capabilities/instructions", "POST", { shared, additions }, decodeInstructions); }
  claimInstructions(harnessId: string): Promise<CapabilityChangeView> { return this.request("/capabilities/instructions/claim", "POST", { harnessId }, decodeChange); }
  /** Checks writing (`sync`) or removing the block in one Harness, with what the user has said to a blocked check so far. */
  checkInstructions(action: "sync" | "remove", harnessId: string, options: readonly InstructionCheckOption[]): Promise<CapabilityChangeCheck> {
    return this.request("/capabilities/instructions/" + action + "?" + new URLSearchParams({ harnessId, ...(options.length ? { options: options.join(",") } : {}) }), "GET", undefined, decodeChangeCheck);
  }
  /** Clearing a switch setting HarnessHub wrote for a skill its Harness no longer has, through the usual switch check. */
  checkOrphanClear(id: string): Promise<CapabilityChangeCheck> { return this.request("/capabilities/orphans/" + encodeURIComponent(id) + "/clear", "GET", undefined, decodeChangeCheck); }
  /** Native skills, MCP servers and plugins of the selected Harness in this workspace; null when its interface has no such list. */
  nativeExtensions(harness: string, control: string, workspace: string, signal?: AbortSignal): Promise<NativeExtensions | null> {
    return this.request(`/harnesses/${encodeURIComponent(harness)}/extensions?${new URLSearchParams({ controlId: control, workspace })}`, "GET", undefined, value => {
      const row = record(value); if (row.extensions === null) return null;
      const extensions = record(row.extensions), optional = (item: Record<string, unknown>, key: string) => item[key] === undefined ? {} : { [key]: text(item[key]) };
      return {
        skills: list(extensions.skills, value => { const item = record(value); return { name: text(item.name), description: text(item.description), enabled: bool(item.enabled), ...optional(item, "scope"), ...optional(item, "command") }; }, 512),
        mcpServers: list(extensions.mcpServers, value => { const item = record(value); return { name: text(item.name), status: text(item.status), tools: number(item.tools), failed: bool(item.failed), ...optional(item, "auth") }; }, 512),
        plugins: list(extensions.plugins, value => { const item = record(value); return { name: text(item.name), enabled: bool(item.enabled), ...optional(item, "version"), ...optional(item, "source") }; }, 512),
        ...(extensions.truncated === undefined ? {} : { truncated: bool(extensions.truncated) }),
      };
    }, signal);
  }
  decidePermission(id: string, permission: string, optionId: string, key: string, input?: string): Promise<{ replayed: boolean }> { return this.request(`/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permission)}`, "POST", { optionId, commandId: key, ...(input===undefined?{}:{input}) }, value => { const row=record(value);return { replayed:bool(row.replayed) }; }); }
  session(id: string, signal?: AbortSignal): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}`, "GET", undefined, decodeSession, signal); }
  /** Stored native tool detail; the JSON shape is display data and is validated field by field. */
  toolDetail(content: ContentRef, signal?: AbortSignal): Promise<ToolDetailView> {
    return this.request(`/content/${encodeURIComponent(content.id)}`, "GET", undefined, value => {
      const row = record(value), optional = (key: string) => row[key] === undefined ? {} : { [key]: text(row[key]) };
      return { ...optional("kind"), ...optional("name"), ...optional("input"), ...optional("output"), ...optional("diff"), ...optional("parentId"),
        ...(row.locations === undefined ? {} : { locations: list(row.locations, text, 16) }), ...(row.exitCode === undefined ? {} : { exitCode: number(row.exitCode) }), ...(row.truncated === undefined ? {} : { truncated: bool(row.truncated) }) };
    }, signal);
  }
  /** Owns one cancellable fact stream; reconnecting never submits a conversation command. */
  async streamSession(id: string, afterSeq: number, signal: AbortSignal, onFrame: (frame: SessionStreamFrame) => void, onAttention?: (frame: AttentionFrame) => void, onRelay?: (event: RelayEvent) => void): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Session stream deadline exceeded", "TimeoutError")), 75_000);
    const attempt = AbortSignal.any([signal, deadline.signal]);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/v1/sessions/${encodeURIComponent(id)}/events/stream?afterSeq=${afterSeq}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: attempt, headers: { Accept: "text/event-stream" },
        });
      } catch (error: unknown) {
        if (attempt.aborted) throw error;
        throw new ApiError("NETWORK_ERROR", "实时回复连接中断，历史和草稿已保留。");
      }
      if (!response.ok) {
        const error = publicError(await readBoundedJson(response));
        throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "实时回复连接未能建立。");
      }
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || response.body === null) {
        await response.body?.cancel(); return invalid();
      }
      let opened = false;
      // Relay events say only that the relay changed; one that cannot be read is dropped, and never ends the stream.
      await consumeSessionEventStream(response.body, { signal: attempt, decode: decodeSessionStreamFrame, maxFrameBytes: 8 * 1024 * 1024,
        ...(onAttention === undefined ? {} : { onAttention: (value: unknown) => onAttention(decodeAttentionFrame(value)) }),
        ...(onRelay === undefined ? {} : { onRelay: (value: unknown) => { const event = decodeRelayFrame(value); if (event !== null) onRelay(event); } }), onFrame: frame => {
        if (!opened && frame.type !== "snapshot") throw new ApiError("STREAM_PROTOCOL", "实时连接缺少起始会话事实。");
        opened = true; onFrame(frame);
      } });
      if (!opened) throw new ApiError("STREAM_PROTOCOL", "实时连接没有返回会话事实。");
    } finally { clearTimeout(timeout); }
  }
  /** One Turn's diagnostics as the Gateway assembled and scrubbed them (ADR-037); conversation content only when asked for. */
  runDiagnostics(id: string, run: string, includeContent: boolean, signal?: AbortSignal): Promise<string> {
    return this.request(`/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}/diagnostics?content=${includeContent ? "1" : "0"}`, "GET", undefined, value => {
      const row = record(value), text = row.text;
      if (typeof text !== "string" || bool(row.includesContent) !== includeContent || !text.startsWith("HarnessHub 诊断 · ")) return invalid();
      return text;
    }, signal);
  }
  /** Waiting approvals and questions of every conversation, as they are now. */
  attention(signal?: AbortSignal): Promise<AttentionFrame> { return this.request("/attention", "GET", undefined, decodeAttentionFrame, signal); }
  /**
   * Live frames of waiting approvals and questions until the server ends the connection (its TTL) or the signal aborts;
   * the caller reconnects. Frames arrive whole, newest revision last.
   */
  async streamAttention(signal: AbortSignal, onFrame: (frame: AttentionFrame) => void): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Attention stream deadline exceeded", "TimeoutError")), 75_000);
    const attempt = AbortSignal.any([signal, deadline.signal]);
    try {
      let response: Response;
      try { response = await fetch("/api/v1/attention/stream", { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: attempt, headers: { Accept: "text/event-stream" } }); }
      catch (error: unknown) { if (attempt.aborted) throw error; throw new ApiError("NETWORK_ERROR", "待处理提醒的连接中断。"); }
      if (!response.ok) { const error = publicError(await readBoundedJson(response)); throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "待处理提醒的连接未能建立。"); }
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || response.body === null) { await response.body?.cancel(); return invalid(); }
      await readSseBlocks(response.body, attempt, block => {
        if (block.event !== "attention") return;
        let value: unknown; try { value = JSON.parse(block.data); } catch { return invalid(); }
        const frame = decodeAttentionFrame(value);
        if (block.id !== String(frame.revision)) return invalid();
        onFrame(frame);
      });
    } finally { clearTimeout(timeout); }
  }
  createSession(workspace: string, selection: SelectionRequest, key: string): Promise<SessionView> {
    return this.request("/sessions", "POST", { workspace, selection, commandId: key }, decodeSession);
  }
  /**
   * Sends one message. `relay` is what the user chose about the history for this message (stage3 §3); a message that
   * chose nothing sends nothing of it, so a Gateway without the relay API sees the body it always did.
   */
  async send(id: string, value: string, key: string, attachments: readonly string[] = [], relay?: RelayRequest): Promise<void> {
    const choices = relayBody(relay);
    await this.request(`/sessions/${encodeURIComponent(id)}/messages`, "POST", { text: value, commandId: key, ...(attachments.length ? { attachments } : {}), ...(choices === null ? {} : { relay: choices }) }, value => acknowledge(value, id, "runId"));
  }
  /** Branches a conversation after a finished reply; the server answers with the new conversation. */
  forkSession(id: string, key: string, throughRunId?: string): Promise<SessionView> {
    return this.request(`/sessions/${encodeURIComponent(id)}/fork`, "POST", { commandId: key, ...(throughRunId === undefined ? {} : { throughRunId }) }, decodeSession);
  }
  /** Sends one file as raw bytes; the server checks the declared type against the bytes and binds it to this workspace. */
  uploadAttachment(file: Blob, name: string, key: string, signal?: AbortSignal): Promise<ContentRef> {
    return this.request(`/attachments?${new URLSearchParams({ name, commandId: key })}`, "POST", new RawBody(file), contentRef, signal);
  }
  /** Withdraws a staged upload; content already sent with a message stays with that message. */
  async discardAttachment(id: string): Promise<void> { await this.request(`/attachments/${encodeURIComponent(id)}`, "DELETE", undefined, () => undefined); }
  async switchSelection(id: string, selection: SelectionRequest, key: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/switches`, "POST", { selection, commandId: key }, value => acknowledge(value, id, "switchId"));
  }
  async resumeSelection(id: string, selection: SelectionRequest, key: string, acknowledgeUnknown: boolean): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/resume`, "POST", { selection, commandId: key, acknowledgeUnknown }, value => acknowledge(value, id, "switchId"));
  }
  async cancel(id: string, key: string): Promise<void> { await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key }, value => acknowledge(value, id, "target")); }
  /** Cancels one named Turn, such as one still waiting for its workspace (ADR-036). */
  async cancelRun(id: string, run: string, key: string): Promise<void> { await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key, runId: run }, value => acknowledge(value, id, "target")); }
  closeSession(id: string, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/close`, "POST", { commandId: key }, decodeSession); }
  /** Keeps this conversation's native process between Turns, or stops keeping it (which closes a kept process). */
  setRetention(id: string, enabled: boolean, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/retention`, "POST", { enabled, commandId: key }, decodeSession); }
  /** Ends the conversation's kept native process; resolves once its close is recorded. */
  endKeptProcess(id: string, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/end-process`, "POST", { commandId: key }, decodeSession); }
  /** Conversations that keep a native process, with the workspace each holds. */
  keptProcesses(signal?: AbortSignal): Promise<readonly { readonly sessionId: string; readonly workspace: string; readonly harnessId: string }[]> {
    return this.request("/kept-processes", "GET", undefined, value => list(record(value).processes, value => { const row = record(value); return { sessionId: text(row.sessionId), workspace: text(row.workspace), harnessId: text(row.harnessId) }; }, 16), signal);
  }
  branchNative(id: string, epoch: number, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/native-branch`, "POST", { epoch, commandId: key }, decodeSession); }
  writeProvider(input: ProviderWriteInput, key: string, current?: ProviderView): Promise<ProviderView> {
    return this.request(current ? `/providers/${encodeURIComponent(current.id)}` : "/providers", current ? "PATCH" : "POST",
      { input, commandId: key, ...(current ? { expectedRevision: current.revision } : {}) }, decodeProvider);
  }
  async probeProvider(id: string): Promise<readonly string[]> {
    return this.request(`/providers/${encodeURIComponent(id)}/probe`, "POST", {}, value => {
      const row = record(value); if (row.status !== "models_reachable") return invalid(); return list(row.models, text, 1024);
    });
  }
  /**
   * Scans this computer's Harnesses again (ADR-050), joining a scan already running; with `after` (an ISO time of the
   * Gateway's clock, such as a task's end), answers once a scan that began then or later has ended.
   */
  async rescan(signal?: AbortSignal, after?: string): Promise<readonly HarnessView[]> {
    return this.request("/harnesses/rescan", "POST", after === undefined ? {} : { after }, value => list(value, decodeHarness, 256), signal);
  }
  checkUpdates(harnessIds?: readonly string[]): Promise<readonly HarnessView[]> {
    return this.request("/harnesses/check-updates", "POST", harnessIds ? { harnessIds } : {}, value => list(value, decodeHarness, 256));
  }
  submitInstallation(input: ManagementJobInput): Promise<InstallationJobView> { return this.request("/installation-jobs", "POST", input, decodeInstallationJob); }
  /** Prepares installing a missing product the official way and reads what it would run and change (ADR-044); changes nothing of the user's. */
  installCheck(harnessId: string, signal?: AbortSignal): Promise<InstallCheckView> { return this.request(`/harnesses/${encodeURIComponent(harnessId)}/install`, "GET", undefined, decodeInstallCheck, signal); }
  /** Reads what uninstalling one installation would remove, stop and leave, for the confirmation (ADR-044); changes nothing. */
  upgradeCheck(harnessId: string, ref: string, signal?: AbortSignal): Promise<InstallationUpgradeCheckView> {
    return this.request(`/harnesses/${encodeURIComponent(harnessId)}/installations/${encodeURIComponent(ref)}/upgrade`, "GET", undefined, decodeUpgradeCheck, signal);
  }
  uninstallCheck(harnessId: string, ref: string, signal?: AbortSignal): Promise<UninstallCheckView> {
    return this.request(`/harnesses/${encodeURIComponent(harnessId)}/installations/${encodeURIComponent(ref)}/uninstall`, "GET", undefined, decodeUninstallCheck, signal);
  }
  /** Reads what upgrading this Harness would touch, for the confirmation (ADR-043); changes nothing. */
  maintenance(harnessId: string, signal?: AbortSignal): Promise<MaintenanceView> { return this.request(`/harnesses/${encodeURIComponent(harnessId)}/maintenance`, "GET", undefined, decodeMaintenance, signal); }
  jobs(signal?: AbortSignal): Promise<readonly InstallationJobView[]> { return this.request("/installation-jobs?limit=50", "GET", undefined, value => list(value, decodeInstallationJob, 100), signal); }
  cancelInstallation(id: string, key: string): Promise<InstallationJobView> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key }, decodeInstallationJob); }
  inspectInstallation(id: string): Promise<InstallationJobView> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/inspect`, "POST", {}, decodeInstallationJob); }
  installationLogs(id: string, afterSeq: number, signal?: AbortSignal): Promise<InstallationLogPage> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/logs?afterSeq=${afterSeq}&limit=50`, "GET", undefined, decodeLogPage, signal); }
  private async request<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body: unknown, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError")), 15_000);
    const attempt = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const raw = body instanceof RawBody ? body.blob : null;
      const response = await fetch("/api/v1" + path, { method, credentials: "same-origin", signal: attempt,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": raw === null ? "application/json" : raw.type || "application/octet-stream" }),
          ...(this.csrfToken === null || method === "GET" ? {} : { "X-CSRF-Token": this.csrfToken }) },
        ...(body === undefined ? {} : { body: raw ?? JSON.stringify(body) }) });
      if (response.status === 204) { await response.body?.cancel(); return decode(undefined); }
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        const error = publicError(payload);
        throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "请求未能完成。", response.status);
      }
      return decode(payload);
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof ApiError) throw error;
      if (deadline.signal.aborted) throw new ApiError("REQUEST_TIMEOUT", "请求响应超时，请确认已接收的结果后重试。");
      throw new ApiError("NETWORK_ERROR", "暂时无法连接本机网关。请确认服务仍在运行，再试一次。");
    } finally { clearTimeout(timeout); }
  }
}
/** The most a packet's text read takes: the Gateway stores a packet in at most 256 KiB, and this leaves room for its escapes. */
const RELAY_TEXT_BYTES = 1024 * 1024;
/** The body as UTF-8 text; null when it is longer than `limit` or is not valid UTF-8, "" when there is none. */
async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 16 * 1024 * 1024) { await reader.cancel(); return invalid(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return value; }
  catch { return invalid(); }
}
export function requestKey(): string { return "web-" + crypto.randomUUID(); }
export function errorMessage(error: unknown): string {
  if (error instanceof SessionStreamError) return "实时回复状态暂时无法同步，历史和草稿已保留。";
  if (error instanceof DOMException && error.name === "TimeoutError") return "网关响应超时，请稍后重试。";
  return error instanceof ApiError ? failureMessage(error) : error instanceof Error ? error.message : "请求未能完成，请重试。";
}
/** Product copy for stable public failures; raw diagnostics never become recovery instructions. */
export function failureMessage(failure: { readonly code: string; readonly message: string }): string {
  const labels: Readonly<Record<string, string>> = {
    GATEWAY_AUTH_REQUIRED: "这个 Harness 尚未配置 Gateway 认证。请补充连接配置，或换一个 Harness 继续。",
    NATIVE_CONFIGURATION_INVALID: "这个 Harness 的本机配置无法使用（例如配置无效，或没有可用的默认代理）。请在原程序里修正，或运行它自带的修复命令（例如 doctor）后再试；也可以换一个 Harness 继续。",
    PROCESS_EXITED: "Harness 提前退出了。历史已保留，可以重试或换一个 Harness。",
    REMOTE_ERROR: "Harness 拒绝了这次请求。请检查连接配置，或换一个 Harness。",
    NATIVE_AUTH_REQUIRED: "这个 Harness 尚未登录。请在本机完成登录后再试，也可以换一个 Harness 继续。",
    NATIVE_GATEWAY_UNAVAILABLE: "Hermes 的网关当前不可用：没有在运行、正在启动，或运行的代码与已安装的 Hermes 不一致。HarnessHub 不会代为启动、停止或替换它；请在终端运行 hermes gateway status 查看，再按需 hermes gateway start 或 hermes gateway restart，之后重试。",
    NATIVE_QUOTA_EXCEEDED: "这个 Harness 的账号额度或余额不足。可等待额度恢复或充值，也可以换一个 Harness 继续。",
    NATIVE_CLIENT_UNSUPPORTED: "模型服务已停止支持这个本机客户端。原配置已保留，可以换一个 Harness 继续。",
    NATIVE_CONNECTION_FAILED: "这个 Harness 配置的模型服务无法连接。请检查它本机的模型配置，或选择其他模型继续。",
    NATIVE_DEPENDENCY_UNAVAILABLE: "这个接入口需要本机已安装的 Harness。请到 Harness 页检查原程序。",
    HARNESS_BUSY: "有 HarnessHub 对话或另一个 HarnessHub 进程正在使用这个程序，没有升级。等它们结束或停止后再升级。",
    SERVICE_CONSENT_REQUIRED: "升级需要重启这个程序的后台服务，这次请求没有同意。请重新打开升级确认后再升级。",
    SERVICE_NOT_RECOVERED: "新版本已安装，但后台服务重启后没有重新运行。",
    SERVICE_NOT_READY: "新版本已安装，后台服务也重新运行了，但没有在它的端口上监听。",
    SERVICE_RESTART_FAILED: "新版本已安装，但系统服务管理器拒绝重启后台服务。",
    NATIVE_CONFIGURATION_INCOMPATIBLE: "目标版本的配置校验没有通过，原安装保留，没有升级。",
    NO_UPDATE: "本机程序已经是这个渠道的最新版本，没有升级。",
    RUNTIME_INCOMPATIBLE: "新版本要求的 Node.js 版本和本机运行它的不一致。先升级 Node.js 再升级；没有升级。",
    UNSUPPORTED_NATIVE_MANAGEMENT: "HarnessHub 不能在这里升级这个程序，请用它自己的方式更新。",
    NATIVE_INSTALLATION_UNKNOWN: "这个 Harness 的本机安装结果尚待核实。请到 Harness 页核实结果，也可以换一个。",
    NATIVE_INSTALLATION_CHANGED: "本机程序已变化。请重新扫描后再操作。",
    CONFIGURATION_PROTECTION_UNAVAILABLE: "当前安装渠道无法保证保留原配置，暂不能在这里升级。",
    SWITCH_NOT_EFFECTIVE: "这条消息尚未执行，因为选择切换失败。重新选择后，可明确重发这条消息。",
    HARNESS_UNAVAILABLE: "这个 Harness 当前不可用。请换一个，或到 Harness 页检查安装。",
    PROVIDER_DISABLED: "所选 Provider 已停用。请选择其他连接，或到模型连接页启用它。",
    NATIVE_INITIALIZE_TIMEOUT: "这个 Harness 启动后一直没有完成握手（initialize）。它可能在启动插件或 MCP 服务，也可能卡住了。这条消息没有发出；可以稍后重试，或先在终端里单独运行它看看卡在哪里。",
    NATIVE_SESSION_TIMEOUT: "这个 Harness 已经启动，但打开对话会话（创建、恢复或载入）一直没有完成。它可能在载入很长的历史，也可能卡住了。这条消息没有发出；可以稍后重试，或换一个 Harness 继续。",
    WORKSPACE_BUSY: "工作区正被另一项任务使用，这条消息没有发出。可以等它结束后重新发送，或为新对话选择其他工作区。",
    WAIT_EXPIRED: "等待你的决定超过了设置的等待期限，原程序没有收到决定；它没有在停止宽限内结束，已被强制结束。结果尚待核实，不会自动重新执行。",
    WORKSPACE_QUARANTINED: "工作区仍有未核实的执行资源。请先核实并停止相关进程；历史和草稿已保留。",
    NATIVE_COMMAND_REJECTED: "原程序没有执行这个命令，原因见上方的活动记录。",
    NATIVE_EXPORT_UNAVAILABLE: "原程序暂时没有可导出的会话记录。",
    ATTACHMENT_UNAVAILABLE: "附件已失效或已移除，请重新添加后再发送。",
    NATIVE_RATE_LIMITED: "模型服务暂时限流或过载。请稍后再试，或换一个模型。",
    MODEL_RATE_LIMIT: "模型服务暂时限流或过载。请稍后再试，或换一个模型。",
    NATIVE_CONTEXT_EXCEEDED: "对话超出了模型的上下文长度。可以先用这个 Harness 的压缩命令（如 /compact），或开始新对话。",
    NATIVE_MODEL_UNAVAILABLE: "所选模型在这个 Harness 的模型服务中不可用，请换一个模型。",
    MODEL_REQUEST_FAILED: "这个 Harness 向模型服务发出的请求失败了。请检查它本机的模型配置，或换一个模型再试。",
    NATIVE_CATALOG_TIMEOUT: "这个 Harness 在 2 分钟内没有给出模型列表，可能卡在启动上。可以稍后刷新本机模型重试。",
    WORKSPACE_KEPT: "这个工作区正被另一个对话保留的原生进程使用。可以结束那个对话的后台进程后重试，也可以稍后再试。",
    MODEL_POLICY_REFUSED: "模型服务按自身的内容策略拒绝了这次请求。",
    MODEL_UNAVAILABLE: "所选模型当前不在这个 Harness 的本机模型目录中，请重新选择模型。",
    MODEL_MISMATCH: "Harness 没有切换到所选模型，这条消息没有发出。可以重新选择模型后重发。",
    NATIVE_OPTION_UNAVAILABLE: "所选设置当前不在这个 Harness 的可选范围内，请在输入框重新选择。",
    NATIVE_OPTION_MISMATCH: "Harness 没有应用所选设置，这条消息没有发出。可以重新选择后重发。",
    NATIVE_SESSION_NOT_FOUND: "原程序里找不到这段对话的原生会话（可能已在原程序中删除）。公共历史已保留；可以换一个 Harness，或明确建立新的原生会话后继续。",
    NATIVE_RESUME_UNAVAILABLE: "原程序无法确认恢复后的原生会话，没有另建新会话。公共历史已保留，可以换一个 Harness 继续。",
    NATIVE_STATE_UNCONFIRMED: "原生会话的状态尚未确认。可以换一个 Harness，或明确建立新的原生分支；公共历史会保留。",
    SESSION_BLOCKED: "这段对话还有执行结果尚未核实，已暂停接收新消息。请在对话顶部核实后恢复；不会自动重新执行。",
    RUN_TIMEOUT: "本回合超过了设置的执行期限（不含等待你的时间），原程序没有按时结束，已被强制结束。结果尚待核实，不会自动重新执行。",
    RELAY_INPUT_LIMIT: "这条消息和交接单合起来超过了这个 Harness 能收的大小，这条消息没有发出。可以只发这条消息，或把消息拆短。",
    RELAY_PREPARE_FAILED: "你选了附上交接单，但它没有准备好，这条消息没有发出，草稿已保留。可以重试，或选“只发这条消息”。",
    LOGIN_SHELL_UNAVAILABLE: "HarnessHub 没有运行你的登录 shell：它必须是列在 /etc/shells 中的绝对路径。用 Homebrew 等方式安装、没有加入这个文件的 shell 常见这种情况。搜索目录没有变化。",
    LOGIN_SHELL_FAILED: "没有读到登录 shell 的 PATH：登录配置超过 3 秒、输出超过 64 KiB、以错误退出，或没有打印 PATH。搜索目录没有变化。",
  };
  return labels[failure.code] ?? failure.message;
}
export function protocolLabel(protocol: ProviderProtocol | string): string {
  const labels: Record<string, string> = { "openai-responses": "OpenAI Responses", "openai-chat-completions": "OpenAI Chat", "anthropic-messages": "Anthropic Messages", gemini: "Gemini", "acp-v1": "ACP", "codex-app-server": "Codex 原生", "pi-rpc": "Pi RPC" };
  return labels[protocol] ?? protocol;
}
/** A Run's state in words, for what is read aloud and shown where nothing else says it: the one table of state words (protocol-words.ts). */
export function runStatusLabel(status: RunStatus): string { return RUN_STATUS_WORDS[status]; }
