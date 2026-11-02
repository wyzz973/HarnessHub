// 原型，仅用于测量，不是实现。
// 类型摘自 docs/proposals/relay/round3/v1-architecture.md §4（基点 07a0825 上的草案）；与草案不同的字段在 README“简化与偏离”中逐条列出。
// 输入侧的 PublicRun / PublicTool / NativeToolDetail 只取 src/contracts/session.ts:58–126 与 src/contracts/control.ts:49–68 中接力会用到的字段。

declare const packetBrand: unique symbol;
declare const printBrand: unique symbol;
export type RelayPacketId = string & { readonly [packetBrand]: true };
export type Fingerprint = string & { readonly [printBrand]: true };
export type PolicyVersion = `relay/${number}`;
export type Tier = "goal" | "brief" | "standard" | "fidelity" | "full";
export const TIERS: readonly Tier[] = ["goal", "brief", "standard", "fidelity", "full"];
export type Language = "zh" | "en";
export type Family = "anthropic" | "openai" | "deepseek" | "unknown";
export type EvidenceClass = "E1" | "E2" | "E3" | "legacy" | "origin";
export type DataClass = "user_text" | "hub_text" | "harness_text" | "exec_output" | "external_output" | "file_diff" | "credential_path" | "thinking";
export type Author = "hub" | "user" | "harness_report" | "harness_note";
export type SectionId = "state" | "goals" | "record" | "failures" | "files" | "plan" | "approvals" | "note" | "away" | "omissions";
export type OmissionCategory = "user_message" | "reply" | "tool_call" | "tool_output" | "diff" | "external_output" | "thinking" | "attachment" | "origin_message" | "file_row" | "plan_entry" | "approval" | "redacted_secret";
export const OMISSION_CATEGORIES: readonly OmissionCategory[] = ["user_message", "reply", "tool_call", "tool_output", "diff", "external_output", "thinking", "attachment", "origin_message", "file_row", "plan_entry", "approval", "redacted_secret"];
export interface Omission { readonly category: OmissionCategory; readonly count: number; readonly chars: number; readonly runs: readonly [number, number] | null; readonly retrieval: "hub_detail_view" | "workspace" | "native_session" | "none" }
export interface SourceRange { readonly fromSeq: number; readonly throughSeq: number; readonly fromRun: number; readonly throughRun: number }
export type Grade = "verbatim" | "compact" | "line" | "range";
export type RunStatus = "queued" | "preparing" | "running" | "settling" | "completed" | "cancelled" | "failed" | "unknown";
/** est/1 的输入：ASCII 字符数、CJK 字符数、其余字符的 UTF-8 字节数（v1 §6.2）。可加，拼接后的尺寸等于各段之和。 */
export interface Size { readonly ascii: number; readonly cjk: number; readonly other: number }

// ---------- 输入侧（合成数据的形状，对应公共事实与内存中的工具详情） ----------
export interface PublicToolLite { readonly id: string; readonly title: string; readonly status: string; readonly kind?: string; readonly name?: string; readonly exitCode?: number }
/** src/contracts/control.ts:49 的 NativeToolDetail 子集：Runtime 在 execution.details 里持有（runtime.ts:1139–1140）。 */
export interface NativeToolDetailLite { readonly kind?: string; readonly name?: string; readonly input?: string; readonly output?: string; readonly diff?: string; readonly locations?: readonly string[]; readonly exitCode?: number; readonly truncated?: boolean }
export interface PlanEntry { readonly content: string; readonly status: "pending" | "in_progress" | "completed" }
export interface AttachmentLite { readonly name: string; readonly mediaType: string; readonly bytes: number }
export interface ActivityLite { readonly id: string; readonly kind: "subagent" | "task" | "compaction" | "retry" | "review"; readonly title: string; readonly status: string }
export interface OutputLite { readonly name: string; readonly mediaType: string; readonly bytes: number }
export interface ApprovalLite { readonly title: string; readonly outcome: "approved" | "denied" | "closed" | "expired"; readonly kind: "approval" | "question" }
export interface Selection { readonly harnessId: string; readonly controlId: string; readonly nativeModel?: string }
export interface PublicRunLite {
  readonly id: string; readonly index: number; readonly input: string; readonly selection: Selection; readonly status: RunStatus;
  readonly cancelRequested: boolean; readonly error: { readonly code: string; readonly message: string } | null;
  readonly thinking?: string; readonly tools?: readonly PublicToolLite[]; readonly plan?: { readonly entries: readonly PlanEntry[] };
  readonly activities?: readonly ActivityLite[]; readonly outputs?: readonly OutputLite[]; readonly attachments?: readonly AttachmentLite[];
  /** 用户消息的 seq 与 run.ended 的 seq（公共事件序号）。 */
  readonly userSeq: number; readonly endSeq: number;
}
export interface ExecutedOn { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }
/** 摘要抽取的全部输入：公共 Run、消息正文、内存中的工具详情与审批记录（permission.* 事件）。 */
export interface RunSource {
  readonly run: PublicRunLite; readonly userText: string; readonly replyText: string | null;
  readonly details: ReadonlyMap<string, NativeToolDetailLite>; readonly approvals: readonly ApprovalLite[];
  readonly executedOn: ExecutedOn | null; readonly dispatched: boolean; readonly sentSha256: string; readonly packetId: RelayPacketId | null;
  readonly model: string | null;
}

// ---------- RunDigest（v1 §4，含原型的增补字段，见 README） ----------
/**
 * 叙述化动作行。v1 是已渲染的 string[]；原型改为与语言无关的结构（值已规范化、已脱敏、已截断，但未转义），
 * 因为框架语言要到交接时按当前输入才定（v1 §5.4），而转义的行首前缀也随语言变。execute 行用 command 指向 commands[]。
 */
export type EditOp = "edit" | "create" | "delete" | "move" | "unknown";
export type NarratedItem =
  | { readonly kind: "read" | "subagent" | "other"; readonly items: readonly string[]; readonly more: number }
  | { readonly kind: "search"; readonly items: readonly string[]; readonly more: number; readonly matches: number | null }
  | { readonly kind: "edit"; readonly items: readonly { readonly op: EditOp; readonly path: string; readonly added: number | null; readonly removed: number | null }[]; readonly more: number }
  | { readonly kind: "execute"; readonly command: number }
  | { readonly kind: "fetch"; readonly items: readonly { readonly name: string; readonly bytes: number }[]; readonly more: number };
export interface DigestCommand { readonly text: string; readonly exitCode: number | null; readonly verification: boolean; readonly irreversible: boolean; readonly failed: boolean; readonly tail: string | null }
export interface DigestFailure { readonly title: string; readonly command: string | null; readonly exitCode: number | null; readonly tail: string }
export interface DigestFile { readonly path: string; readonly op: EditOp; readonly added: number | null; readonly removed: number | null; readonly credentialPath: boolean }
export interface Cumulative {
  readonly runs: number; readonly toolCalls: number; readonly replyChars: number; readonly userChars: number; readonly failures: number;
  // 原型增补：省略账目要 O(1) 取得这些类别的区间总数，v1 的前缀和只有上面五项。
  readonly toolOutputs: number; readonly diffs: number; readonly externalOutputs: number; readonly thinking: number; readonly attachments: number; readonly approvals: number; readonly replies: number;
}
export interface RunDigest {
  readonly runId: string; readonly index: number; readonly seq: number; readonly userSeq: number; readonly policyVersion: PolicyVersion;
  readonly executedOn: ExecutedOn | null;
  readonly by: { readonly harnessId: string; readonly model: string | null }; readonly status: RunStatus; readonly dispatched: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly sent: { readonly sha256: string; readonly packetId: RelayPacketId | null };
  readonly user: { readonly chars: number; readonly sha256: string; readonly attachments: readonly AttachmentLite[]; /** 前 120 字（已规范化、已脱敏），G3 单行用。 */ readonly head: string };
  readonly reply: { readonly chars: number; readonly tail: string; readonly present: boolean };
  readonly tools: { readonly total: number; readonly failed: number; readonly byKind: Readonly<Record<string, number>>; readonly capped: boolean; readonly withOutput: number; readonly withDiff: number; readonly external: number; readonly execTotal: number; readonly execFailed: number; readonly listed: number };
  readonly narrated: readonly NarratedItem[];
  readonly commands: readonly DigestCommand[];
  readonly failures: readonly DigestFailure[];
  readonly files: readonly DigestFile[];
  readonly plan: { readonly completed: number; readonly open: number; readonly openItems: readonly string[] } | null;
  readonly approvals: readonly ApprovalLite[];
  readonly activities: { readonly compaction: number; readonly subagents: number; readonly background: number };
  readonly outputs: readonly OutputLite[];
  readonly thinking: boolean;
  /**
   * 各等级的渲染尺寸（不含用户原话），供两遍定档。原型按两种框架语言各存一份（v1 只有一份，但语言在交接时才定）；
   * untrusted 是其中模型与工具写的部分（回复、命令、输出尾部、计划条目），与语言无关。range 不按单元计。
   */
  readonly size: Readonly<Record<Language, Readonly<Record<"verbatim" | "compact" | "line", Size>>>>;
  readonly untrusted: Readonly<Record<"verbatim" | "compact" | "line", Size>>;
  /** 用户原话的两种块尺寸：§2/G1 规则（≤4,000 字，头 3,000 + 尾 800）与 G2 规则（≤4,000 字逐字，否则头 2,500 + 尾 1,000）。 */
  readonly userSize: { readonly block: Size; readonly compactBlock: Size };
  /** 尺寸是按未脱敏的回复算的；verbatimSized=false 表示回复超过尺寸计算上限，G1 整份不可能放下。 */
  readonly verbatimSized: boolean;
  readonly detailsMissing: boolean;
  readonly cumulative: Cumulative;
  readonly redactions: number;
}

// ---------- 交接单（v1 §4 RelayPacket 的清单部分） ----------
export type FoldEntry =
  | { readonly kind: "unit"; readonly runIndex: number; readonly grade: "verbatim" | "compact" | "line"; readonly why: "tail" | "head" | "anchor" | "user" | "middle" | "whole" }
  | { readonly kind: "range"; readonly fromRun: number; readonly throughRun: number; readonly units: number }
  | { readonly kind: "excluded"; readonly runIndex: number };
export interface RelayPacket {
  readonly id: RelayPacketId; readonly kind: "packet" | "delta" | "reanchor" | "resend"; readonly tier: Tier; readonly complete: boolean;
  readonly target: { readonly harnessId: string; readonly controlId: string; readonly model: string | null; readonly vendor: string; readonly nativeEpoch: number };
  readonly range: SourceRange; readonly basePacketId: RelayPacketId | null; readonly supersedes: RelayPacketId | null;
  readonly policyVersion: PolicyVersion; readonly language: Language; readonly factsFingerprint: Fingerprint; readonly workspaceObservationSeq: number | null;
  readonly body: { readonly sha256: Fingerprint; readonly bytes: number; readonly estTokens: number; readonly estimator: "est/1"; readonly untrustedTokens: number };
  readonly budget: { readonly capTokens: number; readonly window: number; readonly windowSource: string; readonly cliffGuard: boolean; readonly clampedBy: readonly string[] };
  readonly sections: readonly { readonly id: SectionId; readonly author: Author; readonly items: number; readonly estTokens: number; readonly dataClasses: readonly DataClass[] }[];
  readonly fold: readonly FoldEntry[];
  readonly omissions: readonly Omission[];
  readonly rendered: Readonly<Record<OmissionCategory, number>>;
  readonly totals: Readonly<Record<OmissionCategory, number>>;
  readonly redactions: { readonly count: number };
  readonly userEdits: readonly { readonly kind: string; readonly ref: string }[];
  readonly consentKey: string | null;
}
export type TurnText = string | { readonly user: string; readonly relay: { readonly packetId: RelayPacketId; readonly body: string } };

// ---------- 绑定状态（v1 §4，只取原型用到的部分） ----------
export interface DeliveredMark { readonly throughSeq: number; readonly chain: Fingerprint; readonly lastPacketId: RelayPacketId | null; readonly evidence: EvidenceClass; readonly basis: "evidence" | "origin" | "legacy" | "own_run" }
export type BindingSync =
  | { readonly kind: "fresh"; readonly basis: "new" | "user_cleared" | "reset" }
  | { readonly kind: "synced"; readonly mark: DeliveredMark }
  | { readonly kind: "pending"; readonly mark: DeliveredMark | null; readonly packetId: RelayPacketId; readonly range: SourceRange; readonly bodySha256: Fingerprint; readonly attempts: 1 | 2 }
  | { readonly kind: "suspect"; readonly mark: DeliveredMark | null; readonly cause: string };
export interface BindingRelayState { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number; readonly sync: BindingSync; readonly reanchor: boolean }

// ---------- 工作区观测（v1 §4 的 git 分支） ----------
export interface ObservedFile { readonly path: string; readonly change: "modified" | "added" | "deleted" | "renamed" | "untracked"; readonly added: number | null; readonly removed: number | null; readonly credentialPath: boolean }
export type WorkspaceObservation =
  | { readonly kind: "git"; readonly status: "complete" | "partial"; readonly branch: string | null; readonly head: string | null; readonly fingerprint: string; readonly durationMs: number; readonly files: readonly ObservedFile[] }
  | { readonly kind: "unavailable"; readonly reason: "timeout" | "error" | "no_workspace" | "lease_not_held" };
