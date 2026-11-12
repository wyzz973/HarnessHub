import type { HarnessFlavor, LevelPolicy } from "../../contracts/flavor.js";

/**
 * DeepSeek Harness (dsh 0.2.1-rc.5, `dsh --profile acp`). Its permission is a preset of a sandbox mode and an approval policy
 * (dsh-permission-presets): read-only (read-only sandbox, ask), workspace-write (the default, ask) and danger-full-access (no sandbox,
 * never); the sandbox is macOS's Seatbelt and confines file writes only (reads, network and processes are free). The preset of a process
 * is `DSH_PERMISSION_MODE` (dsh-base/cordis.patch.yml rows sandbox and approval), per process and nothing written. Its ACP has no modes and
 * no permission option (configOptions are model and reasoning_effort, dsh-acp).
 *
 * It asks only when a call the sandbox refused is retried with a wider sandbox (dsh-sandbox: bash, write and edit carry
 * `sandbox_permissions` and a justification), offering allow-once and reject-once; under "never" it refuses such a retry itself. So every
 * request it sends is a request to leave its sandbox, and the Hub's answers here are answers to that.
 *
 * A session keeps the preset it was created with (dsh-permission-presets `pinInitialPermission`): a level chosen later, which starts a new
 * process that resumes the session, changes only how the Hub answers its requests, not its sandbox.
 */
const ALL = (answer: LevelPolicy["edit"]): LevelPolicy => ({ read: "allow", edit: answer, execute: answer, network: answer, tool: answer, other: answer });
const PRESET = (mode: "read-only" | "workspace-write" | "danger-full-access") => ({ env: { DSH_PERMISSION_MODE: mode } });
const KEEPS = "会话建立后改档位只改 Hub 的答复，它的沙箱仍按建立时的档位";

export const dshFlavor: HarnessFlavor = {
  harnessId: "dsh",
  permission: {
    // The read-only sandbox refuses every write; the Hub refuses every way out of it and tells the model it is read only (no plan mode over ACP).
    plan: { session: PRESET("read-only"), policy: ALL("deny"), note: "只读沙箱拦下所有写文件；不写文件的命令（包括联网的）照样能跑。" + KEEPS },
    // The read-only sandbox makes each write ask (as a request to leave it), which the Hub hands to you.
    ask: { session: PRESET("read-only"), policy: ALL("ask"), note: "它要写文件时（只读沙箱拦下后申请越权）才来问；不写文件的命令（包括联网的）不问。" + KEEPS },
    auto_edit: { session: PRESET("read-only"), policy: { ...ALL("ask"), edit: "allow" },
      note: "编辑工具写文件由 Hub 自动允许，命令要写文件时交给你；不写文件的命令不问。" + KEEPS },
    // Its own workspace-write sandbox, nothing asked: a call that wants out of it is refused, as its "never" policy would.
    auto: { session: PRESET("workspace-write"), policy: ALL("deny"), note: "工作区内改文件、跑命令都不问；要越出工作区写文件时 Hub 替你拒绝。" + KEEPS },
    full: { session: PRESET("danger-full-access"), policy: ALL("allow"), note: KEEPS },
  },
  // dsh-llm-deepseek: reasoning_effort (category thought_level) is off, low, high, max for the whole provider (no medium); off disables thinking.
  effort: { option: { ids: ["reasoning_effort"], category: "thought_level" }, values: { off: ["off"], low: ["low"], high: ["high"], max: ["max"] } },
  asks: { read: false, edit: true, execute: true, note: "只在越出沙箱写文件时来问" },
  nativePlan: false,
  capabilities: { sessionMcp: "config", resume: "native", attachments: "native", usage: "context" },
};
