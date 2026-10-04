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
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { libraryAgents } from "@/lib/library";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { Checkbox, ErrorCallout } from "./model-plane-ui";

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
                {agent.changed
                  ? t("library.sync.changed")
                  : t("library.sync.unchanged")}
              </span>
            </p>
            {agent.refused.length ? (
              <div role="alert" className="callout error">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <ul className="min-w-0 space-y-0.5">
                  {agent.refused.map((item) => (
                    <li key={`${item.kind}:${item.name}`}>
                      {tr("library.sync.refused", {
                        kind: t(`library.kind.${item.kind}`),
                        name: <span className="font-mono">{item.name}</span>,
                        reason: item.reason,
                      })}
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
                  {tr("library.sync.file", {
                    action: t(`library.sync.action.${file.action}`),
                    state: file.exists ? "" : t("library.sync.newFile"),
                    path: (
                      <span className="font-mono break-all">{file.path}</span>
                    ),
                  })}
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
                    {tr("library.sync.skill", {
                      action: t(`library.sync.skillAction.${skill.action}`),
                      name: <span className="font-mono">{skill.name}</span>,
                      path: (
                        <span className="font-mono break-all text-subtle">
                          {skill.path}
                        </span>
                      ),
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
            {!files.length && !skills.length && !agent.refused.length ? (
              <p className="text-[12.5px] text-muted-foreground">
                {t("library.sync.upToDate")}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** Which agents a sync wrote into, or that it had nothing to write. */
function writtenText(
  applied: LibraryPlan,
  names: ReadonlyMap<string, string>,
): string {
  const agents = applied.agents
    .filter((agent) => agent.changed)
    .map((agent) => names.get(agent.agent) ?? agent.name);
  return agents.length
    ? t("library.sync.written", {
        agents: agents.join(t("library.listSeparator")),
      })
    : t("library.sync.writtenNone");
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
              new Error(t("library.sync.refusedCount", { count: refused })),
              t("library.sync.partial"),
            );
          else notify.success(t("library.sync.done"));
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
        <legend className="field-label">{t("library.sync.to")}</legend>
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
                <span className="ml-1.5 text-[12px] text-subtle">
                  {t("library.sync.notInstalled")}
                </span>
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
          {t("library.sync.plaintext")}
        </Checkbox>
        <Checkbox
          checked={copy}
          onChange={(checked) => {
            setCopy(checked);
            changed();
          }}
        >
          {t("library.sync.copy")}
        </Checkbox>
      </div>
      {plaintext ? (
        <p className="callout warn">{t("library.sync.plaintextWarning")}</p>
      ) : null}
      <ErrorCallout failure={failure} />
      {plan ? <LibraryPlanView plan={plan} names={names} /> : null}
      {applied ? (
        <div className="space-y-2">
          <p className="callout good">{writtenText(applied, names)}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={busy !== null || !chosen.length}
          onClick={preview}
        >
          {busy === "plan" ? <Loader2 className="animate-spin" /> : <Eye />}
          {plan ? t("library.sync.previewAgain") : t("library.sync.preview")}
        </Button>
        <Button disabled={busy !== null || !plan?.changed} onClick={apply}>
          {busy === "apply" ? <Loader2 className="animate-spin" /> : null}
          {t("library.sync.write")}
        </Button>
      </div>
    </div>
  );
}
