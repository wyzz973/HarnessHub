import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionRuntime } from "../../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../../src/contexts/session/domain/relay/recover.js";
import { nativeConversationId, singleText, type BackendResult, type ControlEvent, type HarnessControl, type NativeConversationId } from "../../../src/contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration } from "../../../src/contracts/session.js";
import { LocalContentStore } from "../../../src/infrastructure/session/content-store.js";
import { SqliteSessionStore } from "../../../src/infrastructure/session/sqlite-store.js";
import { CLEAN, declared } from "../../fixtures/relay-fakes.js";
import { listFiles, runTests } from "./judge.js";
import { routeOf, type CellHub, type CellSpec } from "./run.js";
import { outcome, type CellRow } from "./table.js";
import { fixture, namesBookingCause, type Built, type TaskId } from "./tasks.js";

/*
 * The dry run of the relay ruler (HH_REAL_DRY=1): the same driver, judges and table, against two scripted Harnesses instead of
 * the user's. Nothing is started and no model is asked. A scripted Harness works the repo with the known-good patches of
 * the fixtures (tests/fixtures/ruler/<task>/step1, step2, fixed) and reports its tool calls as a real Driver does, but it is
 * only as informed as a real Harness would be: it does what the user's rules say only if those words reached its native
 * session (in its own earlier prompts, or in the relay packet), and otherwise does what a Harness unaware of them might (edits
 * the file it was told not to, patches the symptom, answers "I do not know"). So the dry run shows that the ruler can tell a
 * Harness that was told from one that was not, and that the relay does tell the next Harness; it says nothing of any model.
 */

export const DRY_HARNESSES = ["alpha", "bravo"] as const;
const exec = promisify(execFile);
const NAMES: Readonly<Record<string, string>> = { alpha: "Alpha Harness", bravo: "Bravo Harness" };

/** Which step of which task the scripted Harnesses play now (the driver tells them before each message). */
export interface Scene { readonly task: TaskId; readonly built: Built; readonly step: 1 | 2 }
/** What a scripted Harness can do to the repo and what it can remember. */
interface Hands {
  read(path: string): Promise<void>;
  run(command: string): Promise<string>;
  /** Writes the files of a fixture overlay into the repo, asking for the user's approval of each, and reports them as edits. */
  overlay(name: string, only?: readonly string[]): Promise<void>;
  /** Everything this native session has been told and has seen. */
  heard(): string;
}

async function behave(task: TaskId, scene: Scene, hands: Hands): Promise<string> {
  const { step } = scene;
  switch (task) {
    case "cart": {
      if (step === 1) {
        await hands.read("src/money.js"); await hands.read("test/money.test.js");
        await hands.run("node --test"); await hands.overlay("step1"); await hands.run("node --test");
        return "formatCents 现在会把小数部分补齐成两位（padStart），money 的两条测试通过了。";
      }
      // Told that src/rates.js is not to be edited, it works around the percent rates in tax.js; not told, it fixes the table where the bug is.
      const told = hands.heard().includes("不许改它");
      await hands.run("node --test");
      for (const path of ["src/tax.js", "src/rates.js", "src/cart.js"]) await hands.read(path);
      if (told) await hands.overlay("step2"); else { await hands.overlay("bad-rates"); await hands.overlay("step2", ["src/cart.js"]); }
      await hands.run("node --test");
      return "剩下的失败都修好了：" + (told ? "tax.js 把百分数换算成小数，cart.js 先扣折扣再算税。" : "把 rates.js 里的税率都改成了小数，cart.js 先扣折扣再算税。");
    }
    case "booking": {
      if (step === 1) {
        await hands.run("node --test");
        for (const path of ["test/report.test.js", "src/report.js", "src/calendar.js", "src/range.js"]) await hands.read(path);
        return "根因在 src/range.js 的 contains()：这里的区间是左闭右开的，它却用 <= 把 end 那个小时也算了进去，所以 [10,12) 的 12 点也被当成忙，busyHours 多数了一个小时，得到 4。";
      }
      // Told where the cause is, it goes to contains(); not told, it patches the one place the failing test shows.
      const told = namesBookingCause(hands.heard());
      if (told) await hands.read("src/range.js"); else { await hands.run("node --test"); await hands.read("test/report.test.js"); await hands.read("src/report.js"); await hands.read("src/calendar.js"); }
      await hands.overlay(told ? "fixed" : "decoy");
      await hands.run("node --test");
      return "已经修好，busyHours 现在是 3。";
    }
    case "worker": {
      if (step === 1) {
        const out = await hands.run("node scripts/worker.js"), done = /worker: done, (\d+) ok, (\d+) failed/u.exec(out);
        return "处理完了：" + (done?.[1] ?? "?") + " 个成功，" + (done?.[2] ?? "?") + " 个失败。";
      }
      // It can quote the line only if the output is in its native session.
      return new RegExp("ok\\s+" + scene.built.truth.job + "\\s.*?etag=([0-9a-f]{8})", "u").exec(hands.heard())?.[1] ?? "不知道";
    }
  }
}

/** Two scripted Harnesses behind the Hub's binding factory. `scene` is set by the driver before each message. */
export class ScriptedHarnesses implements SessionBindingFactory {
  scene: Scene | null = null;
  /** What reached each Harness, in order: the text handed to its native session, and the task and step it was for. */
  readonly prompts: { readonly harnessId: string; readonly task: TaskId; readonly step: number; readonly text: string }[] = [];
  /** The options the Hub chose for the Harnesses' approval requests. */
  readonly decisions: string[] = [];
  private readonly memory = new Map<string, string>();
  private sessions = 0;
  /**
   * `lazy`: the Harnesses say "ok" and touch nothing (a first step that never does what the second needs). `hang`: they never
   * answer, until they are stopped. `unavailable`: Harnesses the Hub is told are not installed.
   */
  constructor(private readonly behaviour: { readonly lazy?: boolean; readonly hang?: boolean; readonly unavailable?: readonly string[] } = {}) {}

  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (this.behaviour.unavailable?.includes(request.harnessId) === true) throw new SessionError("HARNESS_UNAVAILABLE", request.harnessId + " is not installed");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  relayCapabilities(): ReturnType<typeof declared> { return declared(); }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    // Whatever the Harnesses are called, one reads and edits the way Claude Code reports it and the other the way Codex does.
    const harnessId = selected.harnessId, shell = harnessId === "codex" || harnessId === DRY_HARNESSES[1], workspace = configuration.workspace;
    let session: string | null = null, permissions = 0;
    const waiting = new Map<string, (option: string) => void>();
    const control: HarnessControl = {
      relayCapabilities: declared(),
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "scripted", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint): Promise<NativeConversationId> => { session = checkpoint ?? "native-" + harnessId + "-" + ++this.sessions; return nativeConversationId(session); },
      checkpoint: async () => session, healthy: () => true,
      models: async () => ({ models: [{ id: "scripted", name: "Scripted" }], defaultModel: "scripted", authentication: "ready", canSelect: true, commands: [] }),
      enablePermissions: () => {},
      decidePermission: async (id, option) => { this.decisions.push(option); waiting.get(id)?.(option); waiting.delete(id); },
      startText: async (_id, turn, output) => {
        const scene = this.scene!, text = singleText(turn), key = session!;
        this.prompts.push({ harnessId, task: scene.task, step: scene.step, text });
        this.memory.set(key, (this.memory.get(key) ?? "") + "\n" + text);
        const remember = (more: string): void => { this.memory.set(key, (this.memory.get(key) ?? "") + "\n" + more); };
        let counter = 0, stopped = false, unhang = (): void => {};
        const tool = (spec: { kind: string; name: string; title: string; input?: string; output?: string; diff?: string; locations?: readonly string[]; exitCode?: number }): void => {
          const id = "tool-" + ++counter, { title, ...detail } = spec;
          output({ type: "tool", id, title, status: "in_progress", detail: { kind: spec.kind, name: spec.name } });
          output({ type: "tool", id, title, status: "completed", detail });
        };
        const ask = (title: string): Promise<string> => new Promise(resolve => {
          const id = "permission-" + ++permissions;
          waiting.set(id, resolve);
          // The option ids the installed Harnesses offer (Claude Code's, then Codex's), the standing rule first on purpose.
          output({ type: "permission_requested", id, title, options: shell ? [{ id: "accept", name: "Yes" }, { id: "decline", name: "No" }, { id: "cancel", name: "Cancel" }]
            : [{ id: "allow-with-updates", name: "Allow, and don't ask again" }, { id: "allow-once", name: "Allow" }, { id: "reject", name: "Reject" }] });
        });
        const hands: Hands = {
          async read(path) {
            const body = await readFile(join(workspace, path), "utf8"), absolute = join(workspace, path);
            remember(body);
            if (shell) tool({ kind: "execute", name: "shell", title: "sed -n '1,200p' " + path, input: "/bin/zsh -lc \"sed -n '1,200p' " + path + "\"", output: body, exitCode: 0 });
            else tool({ kind: "read", name: "Read", title: "Read " + path, input: JSON.stringify({ file_path: absolute }), output: body, locations: [absolute] });
          },
          async run(command) {
            let out: string, exitCode = 0;
            if (command === "node --test") { const run = await runTests(workspace); out = run.output.split("\n").filter(line => /^(not ok|ok|# (tests|pass|fail))/u.test(line)).join("\n"); exitCode = run.fail.length === 0 ? 0 : 1; }
            else { try { out = (await exec(process.execPath, command.split(" ").slice(1), { cwd: workspace })).stdout; } catch (error) { out = String((error as { stdout?: string }).stdout ?? error); exitCode = 1; } }
            remember(out);
            tool({ kind: "execute", name: shell ? "shell" : "Bash", title: command, input: shell ? "/bin/zsh -lc \"" + command + "\"" : command, output: out, exitCode });
            return out;
          },
          async overlay(name, only) {
            const from = fixture(scene.task, name);
            for (const path of (await listFiles(from)).filter(file => only === undefined || only.includes(file))) {
              const absolute = join(workspace, path);
              if (!["allow-once", "accept"].includes(await ask("Edit " + path))) throw new Error("the approval to edit " + path + " was not given once");
              const before = await readFile(absolute, "utf8").catch(() => ""), after = await readFile(join(from, path), "utf8");
              await writeFile(absolute, after);
              tool({ kind: "edit", name: shell ? "apply_patch" : "Edit", title: (shell ? "修改 " : "Edit ") + path, locations: [absolute],
                diff: "--- a/" + path + "\n+++ b/" + path + "\n" + before.split("\n").map(line => "-" + line).join("\n") + "\n" + after.split("\n").map(line => "+" + line).join("\n") + "\n" });
            }
          },
          heard: () => this.memory.get(key) ?? "",
        };
        const result = (async (): Promise<BackendResult> => {
          try {
            if (this.behaviour.hang === true) await new Promise<void>(resolve => { unhang = resolve; });
            const said = this.behaviour.lazy === true ? "好的。" : await behave(scene.task, scene, hands);
            remember(said);
            output({ type: "text", text: said });
            output({ type: "usage", usage: { turn: { input: 9_000 + 1_200 * counter, output: 200 + 40 * counter, total: 9_200 + 1_240 * counter } } } satisfies ControlEvent);
            return stopped ? { status: "cancelled", reason: "stopped" } : { status: "completed", reason: "scripted", input: "recorded" };
          } catch (error) {
            return { status: "failed", reason: "the scripted Harness failed", error: { code: "SCRIPTED_FAILURE", message: error instanceof Error ? error.message : String(error) }, input: "recorded" };
          }
        })();
        return { result, requestStop: async () => { stopped = true; unhang(); for (const resolve of waiting.values()) resolve("reject"); return { requested: true }; } };
      },
      close: async () => CLEAN,
    };
    return { control, workspace, assertOwned: () => {}, close: () => control.close() };
  }
}

/** A Hub of real parts (the Runtime, a SQLite store, the content store) in `data`, over the scripted Harnesses. */
export function dryHub(where: { readonly workspace: string; readonly data: string }, harnesses: ScriptedHarnesses): CellHub {
  const store = new SqliteSessionStore(where.data, { recoverRelay }), content = new LocalContentStore(where.data, () => store.assertOwner());
  let next = 0;
  const runtime = new SessionRuntime(store, harnesses, { id: () => "dry-" + ++next, now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content,
    harnessName: id => NAMES[id] ?? null });
  const configuration: SessionConfiguration = { workspace: where.workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  return { runtime, store, content, configuration, close: async () => { try { await runtime.close(); } finally { store.close(); } } };
}

/**
 * What the dry run must find, since a scripted Harness does what it was told: the baseline finishes every task as asked; the
 * relay does too wherever the user's words and the replies are what the second step needs (the cart's rules, the booking's
 * root cause) and either way for the worker's long output, which the packet does not carry; the floor (the packet switched
 * off) finishes none. Also the plumbing: the second step ran on the Harness the cell names, carried a packet exactly in the
 * relay, and was counted for its tools where it used some; every approval was answered with the one-time allow.
 * Returns what is wrong, nothing when all is as it should be.
 */
export function dryProblems(rows: readonly CellRow[], harnesses: ScriptedHarnesses, cells: readonly CellSpec[]): readonly string[] {
  const problems: string[] = [];
  if (rows.length !== cells.length) problems.push("ran " + rows.length + " of " + cells.length + " cells");
  for (const [index, row] of rows.entries()) {
    const name = row.task + " " + row.mode + " " + row.route + (row.repeat > 1 ? " #" + row.repeat : ""), spec = cells[index], got = outcome(row);
    const want = row.mode === "solo" ? "PASS" : row.mode === "floor" ? "FAIL" : row.task === "worker" ? got : "PASS";
    if (got !== want) problems.push(name + ": " + got + " (" + (row.error ?? row.invalid ?? row.problems.join(",")) + "), expected " + want);
    const [one, two] = row.steps;
    if (one === undefined || two === undefined) { problems.push(name + ": fewer than two steps"); continue; }
    if (spec !== undefined && (routeOf(spec) !== row.route || two.harness !== spec.second)) problems.push(name + ": the second step ran on " + two.harness);
    if ((two.handoff !== null) !== (row.mode === "relay")) problems.push(name + ": the second step " + (two.handoff === null ? "carried no packet" : "carried a packet"));
    if (one.tools.total === 0 || row.task !== "worker" && two.tools.total === 0) problems.push(name + ": no tool calls were counted");
  }
  // Only the tasks that edit ask for approvals: a run of the worker alone asks none.
  if (harnesses.decisions.length === 0 && rows.some(row => row.task !== "worker")) problems.push("no approval was asked");
  if (harnesses.decisions.some(option => option !== "allow-once" && option !== "accept")) problems.push("an approval was answered with something other than the one-time allow");
  return problems;
}
