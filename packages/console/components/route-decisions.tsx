// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Loader2, Radio, RotateCcw, Waypoints } from "lucide-react";
import type {
  RouteDecision,
  RouteDecisionCandidate,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { formatDateTime, t } from "@/lib/i18n";
import { failureOf, modelPlane } from "@/lib/model-plane";
import {
  classifierText,
  decisionKindName,
  decisionSessions,
  mergeDecisions,
  ruleDecisionText,
  stickyText,
} from "@/lib/routing";
import { EmptyState, LoadError, LocalTime, PageHeader } from "./model-plane-ui";

/** Seconds one read waits for the next decision. */
const WAIT_SECONDS = 25;
/** Candidates a decision lists before "and N more". */
const CANDIDATES_SHOWN = 5;

type Trace =
  | { state: "loading" }
  | { state: "ready"; items: RouteDecision[]; following: boolean }
  | { state: "error"; message: string; items: RouteDecision[] };

/**
 * The gateway's route decisions of one conversation (or all), read now and,
 * while `follow`, each new one as it is made: one long poll at a time, ended
 * when the session, `follow` or `epoch` (a retry) changes or the page goes
 * away. After a failure it reads again in 5 seconds.
 */
function useDecisions(session: string, follow: boolean, epoch: number): Trace {
  const [trace, setTrace] = useState<Trace>({ state: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    let items: RouteDecision[] = [];
    let after = 0;
    let first = true;
    setTrace({ state: "loading" });
    const run = async () => {
      while (!abort.signal.aborted) {
        try {
          const page = await modelPlane().routing.decisions(
            {
              after,
              ...(session ? { session } : {}),
              limit: 256,
              ...(follow && !first ? { wait: WAIT_SECONDS } : {}),
            },
            { signal: abort.signal },
          );
          items = mergeDecisions(items, page);
          after = page.seq;
          first = false;
          setTrace({ state: "ready", items, following: follow });
          if (!follow) return;
        } catch (reason) {
          if (abort.signal.aborted) return;
          setTrace({
            state: "error",
            message: failureOf(reason).message,
            items,
          });
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    };
    void run();
    return () => abort.abort();
  }, [session, follow, epoch]);
  return trace;
}

function CandidateText({ candidate }: { candidate: RouteDecisionCandidate }) {
  return (
    <span className="font-mono text-[12px]">
      {candidate.model}
      <span className="text-subtle"> · {candidate.credential}</span>
      {candidate.effort ? (
        <span className="tag info ml-1.5">{candidate.effort}</span>
      ) : null}
      {candidate.fast ? <span className="tag brand ml-1.5">fast</span> : null}
      {candidate.member?.startsWith("group/") ? (
        <span className="ml-1.5 text-subtle">
          {t("routing.decisions.via", { member: candidate.member })}
        </span>
      ) : null}
    </span>
  );
}

function DecisionCard({
  decision,
  onSession,
}: {
  decision: RouteDecision;
  onSession: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all
    ? decision.candidates
    : decision.candidates.slice(0, CANDIDATES_SHOWN);
  const hidden =
    decision.candidates.length - shown.length + (decision.more ?? 0);
  const sticky = stickyText(decision.sticky);
  return (
    <li className="panel space-y-2.5 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[13px] font-medium">
          {decision.requested}
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          <LocalTime value={decision.at} />
        </span>
        {decision.agent ? <span className="tag">{decision.agent}</span> : null}
        {decision.turn !== undefined ? (
          <span className="text-[12.5px] text-muted-foreground">
            {decision.tokens !== undefined
              ? t("routing.decisions.turnTokens", {
                  turn: decision.turn,
                  tokens: decision.tokens,
                })
              : t("routing.decisions.turn", { turn: decision.turn })}
          </span>
        ) : null}
        <span className="ml-auto">
          {decision.done ? (
            <span
              className={`tag ${decision.status !== undefined && decision.status < 400 ? "good" : "error"}`}
            >
              {decision.status ?? t("routing.decisions.ended")}
            </span>
          ) : (
            <span className="tag info">
              <Loader2 className="size-3 animate-spin" />
              {t("routing.decisions.running")}
            </span>
          )}
        </span>
      </div>
      {decision.rules.length ? (
        <ul className="space-y-1.5 text-[13px]">
          {decision.rules.map((rule, index) => (
            <li key={`${rule.group}-${index}`}>
              <span className="tag mr-1.5">{decisionKindName(rule.kind)}</span>
              {decision.rules.length > 1 || index > 0 ? (
                <span className="mr-1 font-mono text-[12px] text-subtle">
                  group/{rule.group}
                </span>
              ) : null}
              {ruleDecisionText(rule)}
              {rule.then.length ? (
                <span className="text-muted-foreground">
                  {t("routing.decisions.then", {
                    members: rule.then.join(t("routing.separator")),
                  })}
                </span>
              ) : null}
              {rule.small?.length ? (
                <span className="text-muted-foreground">
                  {t("routing.decisions.small", {
                    members: rule.small.join(t("routing.separator")),
                  })}
                </span>
              ) : null}
              {rule.classifier ? (
                <p className="mt-0.5 pl-1 text-[12.5px] text-muted-foreground">
                  {classifierText(rule.classifier)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t("routing.decisions.noRules")}
        </p>
      )}
      {decision.effort || sticky ? (
        <p className="text-[12.5px] text-muted-foreground">
          {[
            decision.effort
              ? t("routing.decisions.effort", { effort: decision.effort })
              : "",
            sticky ?? "",
          ]
            .filter(Boolean)
            .join(t("routing.clauseSeparator"))}
        </p>
      ) : null}
      <div>
        <p className="text-[12px] text-subtle">
          {t("routing.decisions.order")}
        </p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {shown.map((candidate, index) => (
            <li
              key={`${candidate.provider}-${candidate.credential}-${candidate.model}-${index}`}
            >
              <CandidateText candidate={candidate} />
            </li>
          ))}
        </ol>
        {hidden > 0 && !all ? (
          <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
            {t("routing.decisions.more", { n: hidden })}
          </Button>
        ) : null}
      </div>
      {decision.served ? (
        <p className="text-[12.5px]">
          {t("routing.decisions.served")}
          <CandidateText candidate={decision.served} />
        </p>
      ) : null}
      <button
        type="button"
        className="font-mono text-[11.5px] text-subtle hover:text-foreground"
        title={t("routing.decisions.onlySession")}
        onClick={() => onSession(decision.conversation)}
      >
        {t("routing.decisions.session", {
          id: decision.conversation.slice(0, 16),
        })}
      </button>
    </li>
  );
}

/** The gateway's route decisions (`GET /api/v1/routing/decisions`), live. */
export function DecisionsPage({ tabs }: { tabs?: React.ReactNode }) {
  const [session, setSession] = useState("");
  const [follow, setFollow] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const trace = useDecisions(session, follow, epoch);
  const items = trace.state === "loading" ? [] : trace.items;
  // The conversations seen so far stay choosable while one is followed.
  const [sessions, setSessions] = useState(() => decisionSessions([], []));
  useEffect(() => {
    if (trace.state !== "loading")
      setSessions((known) => decisionSessions(known, trace.items));
  }, [trace]);
  return (
    <div className="page-body">
      <div className="page-column max-w-[1040px]">
        {tabs}
        <PageHeader
          title={t("routing.decisions.title")}
          lede={t("routing.decisions.lede")}
        >
          <Button
            size="sm"
            variant={follow ? "default" : "outline"}
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            <Radio />
            {follow
              ? t("routing.decisions.following")
              : t("routing.decisions.follow")}
          </Button>
        </PageHeader>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="field-label min-w-[280px] flex-1">
            {t("routing.decisions.sessionLabel")}
            <select
              className="field"
              value={session}
              onChange={(event) => setSession(event.target.value)}
            >
              <option value="">{t("routing.decisions.allSessions")}</option>
              {sessions.map((item) => (
                <option key={item.key} value={item.key}>
                  {`${item.agent ?? t("routing.decisions.unknownAgent")} · ${item.requested} · ${formatDateTime(item.lastAt)} · ${item.key.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </label>
          {session ? (
            <Button variant="ghost" size="sm" onClick={() => setSession("")}>
              <RotateCcw />
              {t("routing.decisions.showAll")}
            </Button>
          ) : null}
        </div>
        <div className="mt-5">
          {trace.state === "error" ? (
            <LoadError
              message={trace.message}
              retry={() => setEpoch((value) => value + 1)}
            />
          ) : null}
          {trace.state === "loading" ? (
            <div
              className="panel flex items-center gap-2 p-5 text-[13px] text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          ) : items.length ? (
            <ol className="space-y-3">
              {items.map((decision) => (
                <DecisionCard
                  key={decision.callId}
                  decision={decision}
                  onSession={setSession}
                />
              ))}
            </ol>
          ) : (
            <EmptyState icon={Waypoints} title={t("routing.decisions.empty")}>
              {follow
                ? t("routing.decisions.emptyHintFollow")
                : t("routing.decisions.emptyHint")}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
