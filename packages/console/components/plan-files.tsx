// SPDX-License-Identifier: MIT
import type { AgentPlanFile } from "@harnesshub/sdk/client";
import { t } from "@/lib/i18n";

/**
 * The files a wiring plan writes, each with its unified diff (Gateway Keys
 * masked as `hhk_a_xxxx…`). Long paths and lines scroll inside the block,
 * never widening the dialog around it.
 */
export function PlanFiles({
  files,
  keyNote = true,
}: {
  files: readonly AgentPlanFile[];
  /** Explain the masked keys under the files; a page showing several plans says it once. */
  keyNote?: boolean;
}) {
  // A file the plan only reads (an unchanged catalog) has nothing to show.
  const changed = files.filter((file) => file.diff || file.changes.length);
  if (!changed.length)
    return (
      <p className="text-[13px] text-muted-foreground">
        {t("agents.plan.noChanges")}
      </p>
    );
  return (
    <div className="min-w-0 space-y-3">
      {changed.map((file) => (
        <section key={file.path} className="min-w-0 space-y-1">
          <p className="text-[13px] font-medium">
            {file.exists ? t("agents.plan.modify") : t("agents.plan.create")}{" "}
            <span className="font-mono text-[12.5px] break-all">
              {file.path}
            </span>
          </p>
          <pre className="max-h-[40vh] overflow-auto rounded-xl border bg-muted p-3 font-mono text-[12px] leading-5">
            {file.diff || t("agents.plan.noDiff")}
          </pre>
        </section>
      ))}
      {keyNote ? (
        <p className="text-[12.5px] text-muted-foreground">
          {t("agents.plan.keyNote")}
        </p>
      ) : null}
    </div>
  );
}
