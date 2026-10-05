// SPDX-License-Identifier: MIT
import { Info, TriangleAlert } from "lucide-react";
import type { AgentManagedOverride } from "@harnesshub/sdk/client";
import { managedLines } from "@/lib/agents";
import { t } from "@/lib/i18n";

/**
 * What wiring an agent leaves to do or cannot do: the files of an
 * administrator's policy that override entries it writes (a warning), and
 * the agent's notice, such as restarting it for a change to take effect,
 * as the daemon words it. `after` reads the notice as what follows applying
 * a plan. Nothing renders when there is neither.
 */
export function WiringNotes({
  notice,
  managed,
  after = false,
}: {
  notice?: string | undefined;
  managed?: readonly AgentManagedOverride[] | undefined;
  after?: boolean;
}) {
  const lines = managedLines(managed);
  return (
    <>
      {lines.length ? (
        <div role="alert" className="callout warn block space-y-1">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" />
            {t("agents.managed.title")}
          </p>
          <p>{t("agents.managed.lede")}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {lines.map((line) => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notice ? (
        <p className="callout info items-start">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{after ? t("agents.notice.after", { notice }) : notice}</span>
        </p>
      ) : null}
    </>
  );
}
