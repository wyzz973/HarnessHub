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
import { t } from "@/lib/i18n";
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
    [t("routing.syntax.useWord"), t("routing.syntax.use")],
    ["tokens=200k", t("routing.syntax.tokens")],
    ["images", t("routing.syntax.images")],
    ["effort[=high]", t("routing.syntax.effort")],
    ["agents=claude,codex", t("routing.syntax.agents")],
    ['intent="a quick question"', t("routing.syntax.intent")],
    ["compact", t("routing.syntax.compact")],
    ["time=09:00-18:00", t("routing.syntax.time")],
    ["days=mon-fri", t("routing.syntax.days")],
    ["classifier=<provider/model>", t("routing.syntax.classifier")],
    ["at=1", t("routing.syntax.at")],
  ];
  return (
    <details className="rounded-xl border px-3 py-2 text-[12.5px]">
      <summary className="cursor-pointer text-muted-foreground">
        {t("routing.syntax.summary")}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {words.map(([word, meaning]) => (
          <div key={word} className="contents">
            <dt className="font-mono text-[12px]">{word}</dt>
            <dd className="text-muted-foreground">{meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-muted-foreground">{t("routing.syntax.footer")}</p>
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
          <DialogTitle>
            {t("routing.groups.rulesOf", { group: `group/${group.id}` })}
          </DialogTitle>
          <DialogDescription>{t("routing.rules.lede")}</DialogDescription>
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
                      {ruleConditions(rule).join(
                        t("routing.conditionSeparator"),
                      )}{" "}
                      → {rule.use}
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
                    aria-label={t("routing.rules.edit", { n: index + 1 })}
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
                    aria-label={t("routing.rules.up", { n: index + 1 })}
                    disabled={index === 0}
                    onClick={() => setRules(moved(rules, index, index - 1))}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("routing.rules.down", { n: index + 1 })}
                    disabled={index === rules.length - 1}
                    onClick={() => setRules(moved(rules, index, index + 1))}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("routing.rules.delete", { n: index + 1 })}
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
            {t("routing.rules.none")}
          </p>
        )}
        <label className="field-label">
          {editing === null
            ? t("routing.rules.add")
            : t("routing.rules.edit", { n: editing + 1 })}
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
              {ruleConditions(read.rule).join(t("routing.conditionSeparator"))}{" "}
              → {read.rule.use}
              {read.at !== undefined
                ? t("routing.rules.placeAt", { n: read.at })
                : ""}
              {read.classifier
                ? t("routing.rules.setClassifier", { model: read.classifier })
                : ""}
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
              {t("routing.rules.cancelEdit")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={!read?.ok}
            onClick={apply}
          >
            {editing === null ? <Plus /> : <Pencil />}
            {editing === null
              ? t("routing.rules.insert")
              : t("routing.rules.replace")}
          </Button>
        </div>
        <SyntaxHelp />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            {t("routing.groups.classifier")}
            <select
              className="field"
              value={classifier}
              onChange={(event) => setClassifier(event.target.value)}
            >
              <option value="">{t("routing.none")}</option>
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
              {t("routing.rules.classifierHint")}
            </span>
            <FieldError failure={failure} pointer="/classifier" />
          </label>
          <label className="field-label">
            {t("routing.rules.effort")}
            <select
              className="field"
              value={effortAuto ? "auto" : ""}
              onChange={(event) => setEffortAuto(event.target.value === "auto")}
            >
              <option value="">{t("routing.rules.effortAgent")}</option>
              <option value="auto">{t("routing.rules.effortAuto")}</option>
            </select>
            <span className="field-hint">{t("routing.rules.effortHint")}</span>
            <FieldError failure={failure} pointer="/effort" />
          </label>
        </div>
        <ErrorCallout failure={failure} />
        <OtherFieldErrors failure={failure} shown={shownPointers} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || (effortAuto && !classifier)}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("routing.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
