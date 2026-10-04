// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Loader2, Radio, RotateCcw, Waypoints } from "lucide-react";
import type {
  RouteDecision,
  RouteDecisionCandidate,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import { failureOf, modelPlane } from "@/lib/model-plane";
import {
  classifierText,
  decisionKinds,
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
        <span className="ml-1.5 text-subtle">（经 {candidate.member}）</span>
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
            第 {decision.turn} 轮
            {decision.tokens !== undefined
              ? ` · 约 ${decision.tokens.toLocaleString()} token`
              : ""}
          </span>
        ) : null}
        <span className="ml-auto">
          {decision.done ? (
            <span
              className={`tag ${decision.status !== undefined && decision.status < 400 ? "good" : "error"}`}
            >
              {decision.status ?? "已结束"}
            </span>
          ) : (
            <span className="tag info">
              <Loader2 className="size-3 animate-spin" />
              进行中
            </span>
          )}
        </span>
      </div>
      {decision.rules.length ? (
        <ul className="space-y-1.5 text-[13px]">
          {decision.rules.map((rule, index) => (
            <li key={`${rule.group}-${index}`}>
              <span className="tag mr-1.5">{decisionKinds[rule.kind]}</span>
              {decision.rules.length > 1 || index > 0 ? (
                <span className="mr-1 font-mono text-[12px] text-subtle">
                  group/{rule.group}
                </span>
              ) : null}
              {ruleDecisionText(rule)}
              {rule.then.length ? (
                <span className="text-muted-foreground">
                  ；其后 {rule.then.join("、")}
                </span>
              ) : null}
              {rule.small?.length ? (
                <span className="text-muted-foreground">
                  ；窗口太小跳过 {rule.small.join("、")}
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
          这个组没有规则：按组的策略排列。
        </p>
      )}
      {decision.effort || sticky ? (
        <p className="text-[12.5px] text-muted-foreground">
          {[
            decision.effort ? `推理强度由分类器定为 ${decision.effort}` : "",
            sticky ?? "",
          ]
            .filter(Boolean)
            .join("；")}
        </p>
      ) : null}
      <div>
        <p className="text-[12px] text-subtle">尝试顺序</p>
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
            还有 {hidden} 个
          </Button>
        ) : null}
      </div>
      {decision.served ? (
        <p className="text-[12.5px]">
          应答：
          <CandidateText candidate={decision.served} />
        </p>
      ) : null}
      <button
        type="button"
        className="font-mono text-[11.5px] text-subtle hover:text-foreground"
        title="只看这个会话"
        onClick={() => onSession(decision.conversation)}
      >
        会话 {decision.conversation.slice(0, 16)}…
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
          title="路由决定"
          lede="路由组的每一轮如何路由：命中的规则、分类器的回答、粘性与候选的尝试顺序，以及最后由谁应答。只保存在守护进程内存中（最近 256 条）。"
        >
          <Button
            size="sm"
            variant={follow ? "default" : "outline"}
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
          >
            <Radio />
            {follow ? "实时跟随中" : "实时跟随"}
          </Button>
        </PageHeader>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="field-label min-w-[280px] flex-1">
            会话
            <select
              className="field"
              value={session}
              onChange={(event) => setSession(event.target.value)}
            >
              <option value="">全部会话</option>
              {sessions.map((item) => (
                <option key={item.key} value={item.key}>
                  {`${item.agent ?? "未知 Agent"} · ${item.requested} · ${new Date(item.lastAt).toLocaleString()} · ${item.key.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </label>
          {session ? (
            <Button variant="ghost" size="sm" onClick={() => setSession("")}>
              <RotateCcw />
              显示全部
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
              正在读取
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
            <EmptyState icon={Waypoints} title="还没有路由决定">
              请求路由组（group/ID）后，每一轮的决定会出现在这里
              {follow ? "，页面会自动显示新的决定" : ""}。
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
