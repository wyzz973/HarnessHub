// SPDX-License-Identifier: MIT
import { useState } from "react";
import { CircleAlert, Eye, Loader2, TriangleAlert } from "lucide-react";
import type {
  Agent,
  LibraryAgent,
  LibraryPlan,
  LibrarySyncInput,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { libraryAgents } from "@/lib/library";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { Checkbox, ErrorCallout } from "./model-plane-ui";

const fileActions: Record<
  LibraryPlan["agents"][number]["files"][number]["action"],
  string
> = {
  write: "写入",
  restore: "还原",
  delete: "删除",
  unchanged: "不变",
};
const skillActions: Record<
  LibraryPlan["agents"][number]["skills"][number]["action"],
  string
> = {
  place: "放置",
  replace: "替换",
  remove: "移除",
  unchanged: "不变",
};
const kindNames = { instructions: "指令集", mcp: "MCP 服务", skills: "Skill" };

/**
 * One Library plan: per agent, each file's unified diff (secret values
 * written as plain text show as `<secret>`), the skills placed or removed,
 * the items refused and why, and warnings.
 */
export function LibraryPlanView({
  plan,
  names,
}: {
  plan: LibraryPlan;
  names: ReadonlyMap<string, string>;
}) {
  return (
    <div className="min-w-0 space-y-4">
      {plan.agents.map((agent) => {
        const files = agent.files.filter((file) => file.action !== "unchanged");
        const skills = agent.skills.filter(
          (skill) => skill.action !== "unchanged",
        );
        return (
          <section
            key={agent.agent}
            className="min-w-0 space-y-2 rounded-xl border p-3"
            aria-label={names.get(agent.agent) ?? agent.name}
          >
            <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
              {names.get(agent.agent) ?? agent.name}
              <span className="font-mono text-[12px] font-normal text-subtle">
                {agent.agent}
              </span>
              <span className={`tag ${agent.changed ? "brand" : ""}`}>
                {agent.changed ? "有改动" : "没有改动"}
              </span>
            </p>
            {agent.refused.length ? (
              <div role="alert" className="callout error">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <ul className="min-w-0 space-y-0.5">
                  {agent.refused.map((item) => (
                    <li key={`${item.kind}:${item.name}`}>
                      不写入 {kindNames[item.kind]}{" "}
                      <span className="font-mono">{item.name}</span>：
                      {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {agent.warnings.length ? (
              <div className="callout warn">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <ul className="min-w-0 space-y-0.5">
                  {agent.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {files.map((file) => (
              <div key={file.path} className="min-w-0 space-y-1">
                <p className="text-[12.5px]">
                  {fileActions[file.action]}
                  {file.exists ? "" : "（新文件）"}{" "}
                  <span className="font-mono break-all">{file.path}</span>
                </p>
                {file.diff ? (
                  <pre className="max-h-[36vh] overflow-auto rounded-lg border bg-muted p-3 font-mono text-[12px] leading-5">
                    {file.diff}
                  </pre>
                ) : null}
              </div>
            ))}
            {skills.length ? (
              <ul className="space-y-0.5 text-[12.5px]">
                {skills.map((skill) => (
                  <li key={skill.name}>
                    {skillActions[skill.action]} Skill{" "}
                    <span className="font-mono">{skill.name}</span>{" "}
                    <span className="font-mono break-all text-subtle">
                      {skill.path}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {!files.length && !skills.length && !agent.refused.length ? (
              <p className="text-[12.5px] text-muted-foreground">
                文件已经是 Library 的样子。
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Sync the Library into agents: choose them and the options, preview the
 * plan, then apply exactly that plan (sent back as `expect`; a file changed
 * since the preview is refused and that agent writes nothing). Changing an
 * option drops the preview.
 */
export function LibrarySync({
  agents,
  initial,
  onApplied,
}: {
  /** The daemon's agents, for names and what is installed. */
  agents: readonly Agent[];
  /** The agents chosen at first; every installed Library agent by default. */
  initial: readonly LibraryAgent[];
  onApplied?: (plan: LibraryPlan) => void;
}) {
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  const installed = new Set(
    agents
      .filter((agent) => agent.installation.status !== "not-found")
      .map((agent) => agent.id),
  );
  const [chosen, setChosen] = useState<LibraryAgent[]>([...initial]);
  const [plaintext, setPlaintext] = useState(false);
  const [copy, setCopy] = useState(false);
  const [plan, setPlan] = useState<LibraryPlan | null>(null);
  const [applied, setApplied] = useState<LibraryPlan | null>(null);
  const [busy, setBusy] = useState<"plan" | "apply" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const input = (): LibrarySyncInput => ({
    agents: libraryAgents.filter((agent) => chosen.includes(agent)),
    ...(plaintext ? { allowPlaintextSecret: true } : {}),
    ...(copy ? { placement: "copy" as const } : {}),
  });
  const changed = () => {
    setPlan(null);
    setApplied(null);
    setFailure(null);
  };
  const preview = () => {
    setBusy("plan");
    setFailure(null);
    setApplied(null);
    modelPlane()
      .library.sync.plan(input())
      .then(
        (value) => {
          setBusy(null);
          setPlan(value);
        },
        (reason: unknown) => {
          setBusy(null);
          setFailure(failureOf(reason));
        },
      );
  };
  const apply = () => {
    if (!plan) return;
    setBusy("apply");
    setFailure(null);
    modelPlane()
      .library.sync.apply({ ...input(), expect: plan })
      .then(
        (result) => {
          setBusy(null);
          setPlan(null);
          setApplied(result);
          const refused = result.agents.reduce(
            (count, agent) => count + agent.refused.length,
            0,
          );
          if (refused)
            notify.error(
              new Error(`${refused} 个条目被拒绝，其余已写入`),
              "部分条目没有写入",
            );
          else notify.success("Library 已同步到 Agent");
          onApplied?.(result);
        },
        (reason: unknown) => {
          setBusy(null);
          setFailure(failureOf(reason));
        },
      );
  };
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="field-label">同步到</legend>
        <div className="mt-1.5 grid gap-x-2 sm:grid-cols-3">
          {libraryAgents.map((agent) => (
            <Checkbox
              key={agent}
              checked={chosen.includes(agent)}
              onChange={(checked) => {
                setChosen((current) =>
                  checked
                    ? [...current, agent]
                    : current.filter((item) => item !== agent),
                );
                changed();
              }}
            >
              {names.get(agent) ?? agent}
              {installed.has(agent) ? null : (
                <span className="ml-1.5 text-[12px] text-subtle">未安装</span>
              )}
            </Checkbox>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-x-2 sm:grid-cols-2">
        <Checkbox
          checked={plaintext}
          onChange={(checked) => {
            setPlaintext(checked);
            changed();
          }}
        >
          允许把秘密值写入不支持变量引用的 Agent 文件
        </Checkbox>
        <Checkbox
          checked={copy}
          onChange={(checked) => {
            setCopy(checked);
            changed();
          }}
        >
          复制 Skill，而不是建立链接
        </Checkbox>
      </div>
      {plaintext ? (
        <p className="callout warn">
          支持环境变量引用的 Agent 仍然只写引用；其余 Agent
          的文件会含有秘密的明文值（预览中显示为 &lt;secret&gt;）。
        </p>
      ) : null}
      <ErrorCallout failure={failure} />
      {plan ? <LibraryPlanView plan={plan} names={names} /> : null}
      {applied ? (
        <div className="space-y-2">
          <p className="callout good">
            已写入
            {applied.agents
              .filter((agent) => agent.changed)
              .map((agent) => names.get(agent.agent) ?? agent.name)
              .join("、") || "（没有改动）"}
            。正在运行的 Agent 重新启动后读到新的内容。
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={busy !== null || !chosen.length}
          onClick={preview}
        >
          {busy === "plan" ? <Loader2 className="animate-spin" /> : <Eye />}
          {plan ? "重新预览" : "预览改动"}
        </Button>
        <Button disabled={busy !== null || !plan?.changed} onClick={apply}>
          {busy === "apply" ? <Loader2 className="animate-spin" /> : null}
          写入 Agent
        </Button>
      </div>
    </div>
  );
}
