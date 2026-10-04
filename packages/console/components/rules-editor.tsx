// SPDX-License-Identifier: MIT
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  GroupRule,
  ProviderConfig,
  RouteGroup,
} from "@harnesshub/sdk/client";
import { ruleConditions, ruleLine } from "@harnesshub/sdk/route-rules";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  failureOf,
  modelPlane,
  modelRefChoices,
  type Failure,
} from "@/lib/model-plane";
import { markedParts, moved, readTypedRule, ruleFailures } from "@/lib/routing";
import { ErrorCallout, FieldError, OtherFieldErrors } from "./model-plane-ui";

/** The words of a typed rule, as `hh group rule add` takes them. */
function SyntaxHelp() {
  const words: [string, string][] = [
    ["use=<成员>", "命中时先交给这个成员（全名、模型名或其最后一段）"],
    ["tokens=200k", "请求至少这么长（也写 200000、1.5m）"],
    ["images", "本轮或之前带图片"],
    ["effort[=high]", "Agent 要求的推理至少到这一档；只写 effort 为任意推理"],
    ["agents=claude,codex", "来自这些 Agent（账本中的 Agent ID）"],
    ['intent="a quick question"', "分类器判断本轮第一条消息属于这种意图"],
    ["compact", "Agent 在压缩会话"],
    [
      "time=09:00-18:00",
      "一轮开始时处于这段时间（守护进程本地时间，可跨午夜）",
    ],
    ["days=mon-fri", "只在这几天（mon … sun）"],
    ["classifier=<provider/model>", "同时设置组的分类器"],
    ["at=1", "放到第几条（从 1 起），默认最后"],
  ];
  return (
    <details className="rounded-xl border px-3 py-2 text-[12.5px]">
      <summary className="cursor-pointer text-muted-foreground">
        写法（与 hh group rule add 相同）
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {words.map(([word, meaning]) => (
          <div key={word} className="contents">
            <dt className="font-mono text-[12px]">{word}</dt>
            <dd className="text-muted-foreground">{meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground">
        一条规则的条件都满足才命中；多条规则按顺序，第一条命中的决定这一轮。
      </p>
    </details>
  );
}

/**
 * A group's rules, classifier and automatic effort (`PATCH
 * /route-groups/{id}`). Rules are typed as `hh group rule add` takes them
 * and read as the daemon reads them, so a word it would refuse is marked
 * before anything is sent.
 */
export function RulesDialog({
  group,
  groups,
  providers,
  onClose,
  onSaved,
}: {
  group: RouteGroup;
  groups: RouteGroup[];
  providers: ProviderConfig[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rules, setRules] = useState<GroupRule[]>(group.rules ?? []);
  const [classifier, setClassifier] = useState(group.classifier ?? "");
  const [effortAuto, setEffortAuto] = useState(group.effort === "auto");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const read = draft.trim()
    ? readTypedRule(draft, group.members, group.id, classifier !== "")
    : undefined;
  const failed = failure ? ruleFailures(failure.fields) : new Map();
  const classifierChoices = [
    ...modelRefChoices(providers).flatMap((choice) => choice.refs),
    ...groups
      .filter((item) => item.id !== group.id)
      .map((item) => `group/${item.id}`),
  ];
  const apply = () => {
    if (!read?.ok) return;
    if (editing !== null)
      setRules(rules.map((rule, at) => (at === editing ? read.rule : rule)));
    else {
      const place =
        read.at === undefined
          ? rules.length
          : Math.min(Math.max(read.at - 1, 0), rules.length);
      setRules([...rules.slice(0, place), read.rule, ...rules.slice(place)]);
    }
    if (read.classifier) setClassifier(read.classifier);
    setDraft("");
    setEditing(null);
  };
  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      await modelPlane().routeGroups.update(group.id, {
        rules: rules.length ? rules : null,
        classifier: classifier || null,
        effort: effortAuto ? "auto" : null,
      });
      onSaved();
    } catch (reason) {
      setFailure(failureOf(reason));
    } finally {
      setBusy(false);
    }
  }
  const shownPointers = [
    "/classifier",
    "/effort",
    ...Object.keys(failure?.fields ?? {}).filter((pointer) =>
      pointer.startsWith("/rules/"),
    ),
  ];
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>group/{group.id} 的规则</DialogTitle>
          <DialogDescription>
            一轮开始时，第一条命中的规则把它的成员放到最前，整轮沿用；之后命中的规则的成员排在其后，再是组的其他成员。会话超过当前模型窗口的
            95% 时，换到规则指向的更大窗口的成员。
          </DialogDescription>
        </DialogHeader>
        {rules.length ? (
          <ol className="space-y-1.5 rounded-xl border p-2">
            {rules.map((rule, index) => (
              <li
                key={`${ruleLine(rule)}-${index}`}
                className={`rounded-[10px] px-2 py-1.5 ${editing === index ? "bg-accent" : "hover:bg-accent"}`}
              >
                <div className="flex items-start gap-2">
                  <span className="w-5 pt-0.5 text-right text-[12px] text-subtle">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12.5px] break-all">
                      {ruleLine(rule)}
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {ruleConditions(rule).join("，")} → {rule.use}
                    </p>
                    {(failed.get(index) ?? []).map((detail: string) => (
                      <p
                        key={detail}
                        role="alert"
                        className="field-hint text-danger"
                      >
                        {detail}
                      </p>
                    ))}
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`修改规则 ${index + 1}`}
                    onClick={() => {
                      setEditing(index);
                      setDraft(ruleLine(rule));
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`上移规则 ${index + 1}`}
                    disabled={index === 0}
                    onClick={() => setRules(moved(rules, index, index - 1))}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`下移规则 ${index + 1}`}
                    disabled={index === rules.length - 1}
                    onClick={() => setRules(moved(rules, index, index + 1))}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`删除规则 ${index + 1}`}
                    onClick={() => {
                      setRules(rules.filter((_, at) => at !== index));
                      if (editing === index) {
                        setEditing(null);
                        setDraft("");
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-xl border px-3 py-3 text-[13px] text-muted-foreground">
            还没有规则：所有请求按组的策略排列。
          </p>
        )}
        <label className="field-label">
          {editing === null ? "添加规则" : `修改规则 ${editing + 1}`}
          <input
            className="field font-mono text-[13px]"
            value={draft}
            placeholder={`use=${group.members[0] ?? "provider/model"} tokens=200k`}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={read !== undefined && !read.ok}
            aria-describedby="rule-draft-state"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              }
            }}
          />
        </label>
        <div id="rule-draft-state" aria-live="polite">
          {read === undefined ? null : read.ok ? (
            <p className="field-hint">
              {ruleConditions(read.rule).join("，")} → {read.rule.use}
              {read.at !== undefined ? `，放到第 ${read.at} 条` : ""}
              {read.classifier ? `；分类器设为 ${read.classifier}` : ""}
            </p>
          ) : (
            <div role="alert" className="callout error items-start">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="font-mono text-[12.5px] break-all">
                  {markedParts(draft, read.spans).map((part, index) =>
                    part.marked ? (
                      <mark
                        key={index}
                        className="rounded bg-danger/15 px-0.5 text-danger underline decoration-wavy"
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )}
                </p>
                <p className="mt-1">{read.message}</p>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          {editing !== null ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
            >
              取消修改
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={!read?.ok}
            onClick={apply}
          >
            {editing === null ? <Plus /> : <Pencil />}
            {editing === null ? "加入规则" : "替换规则"}
          </Button>
        </div>
        <SyntaxHelp />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            分类器
            <select
              className="field"
              value={classifier}
              onChange={(event) => setClassifier(event.target.value)}
            >
              <option value="">无</option>
              {classifierChoices.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
              {classifier && !classifierChoices.includes(classifier) ? (
                <option value={classifier}>{classifier}</option>
              ) : null}
            </select>
            <span className="field-hint">
              判断本轮第一条消息属于哪种意图的模型，宜小而快；它的调用记在用量中（Agent
              为 harnesshub-classify）。
            </span>
            <FieldError failure={failure} pointer="/classifier" />
          </label>
          <label className="field-label">
            推理强度
            <select
              className="field"
              value={effortAuto ? "auto" : ""}
              onChange={(event) => setEffortAuto(event.target.value === "auto")}
            >
              <option value="">按 Agent 的要求</option>
              <option value="auto">自动：分类器为每一轮选择</option>
            </select>
            <span className="field-hint">
              自动时，Agent 要求了推理的一轮由分类器选 low 到
              xhigh，发给没有固定强度的成员；需要分类器。
            </span>
            <FieldError failure={failure} pointer="/effort" />
          </label>
        </div>
        <ErrorCallout failure={failure} />
        <OtherFieldErrors failure={failure} shown={shownPointers} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy || (effortAuto && !classifier)}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
