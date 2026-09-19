"use client";
import {
  BrainCircuit,
  Cpu,
  Loader2,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Trophy,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GatewayStatus } from "@/lib/gateway-status";

type Tone = "good" | "warn" | "bad" | "accent" | "neutral";
function Chip({
  icon: Icon,
  tone = "neutral",
  title,
  spin,
  onClick,
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  title?: string;
  spin?: boolean;
  /** Renders the chip as a button that opens the related page. */
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const content = (
    <>
      <Icon className={cn("size-3", spin && "animate-spin")} aria-hidden />
      {children}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={cn("status-chip interactive", tone)}
      title={title}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <span className={cn("status-chip", tone)} title={title}>
      {content}
    </span>
  );
}
function timeLabel(ms: number | null) {
  return ms
    ? new Date(ms).toLocaleTimeString("zh-CN", { hour12: false })
    : "尚未检查";
}
/**
 * Always-visible Gateway facts: connectivity from the live health probe, and mode, engine,
 * Full Access and unified model from `/v1/runtime/info` and `/v1/harness/model`.
 */
export function StatusBar({
  status,
  onOpenModel,
}: {
  status: GatewayStatus;
  onOpenModel: () => void;
}) {
  const { health, runtime, model } = status;
  const checked = `最后检查：${timeLabel(status.checkedAt)}`;
  const info = runtime.state === "ready" ? runtime.value : undefined;
  const view = model.state === "ready" ? model.value : undefined;
  return (
    <div className="status-strip" aria-label="运行状态">
      <span role="status">
        {health === "ready" ? (
          <Chip icon={Radio} tone="good" title={checked}>
            Gateway 已连接
          </Chip>
        ) : health === "not-ready" ? (
          <Chip icon={Radio} tone="warn" title={checked}>
            Gateway 未就绪
          </Chip>
        ) : health === "offline" ? (
          <Chip icon={WifiOff} tone="bad" title={checked}>
            无法连接 Gateway
          </Chip>
        ) : (
          <Chip icon={Loader2} spin>
            正在检查 Gateway
          </Chip>
        )}
      </span>
      {info ? (
        <>
          <Chip
            icon={info.competition ? Trophy : Cpu}
            tone={info.competition ? "accent" : "neutral"}
          >
            {info.competition ? "比赛模式" : "普通模式"}
          </Chip>
          {info.competition ? (
            <Chip
              icon={Cpu}
              tone="accent"
              title="比赛接口 /session 固定使用该引擎"
            >
              比赛引擎 {info.competitionEngine ?? "未报告"}
            </Chip>
          ) : null}
          <Chip
            icon={info.fullAccess ? ShieldAlert : ShieldCheck}
            tone={info.fullAccess ? "warn" : "neutral"}
            title={
              info.fullAccess
                ? "引擎的写文件与命令请求会被自动批准"
                : "工具权限请求需要确认"
            }
          >
            Full Access {info.fullAccess ? "已开启" : "未开启"}
          </Chip>
        </>
      ) : runtime.state === "unsupported" ? (
        <Chip icon={Cpu} title="需要支持 /v1/runtime/info 的 Gateway">
          运行模式：当前 Gateway 不支持
        </Chip>
      ) : runtime.state === "error" ? (
        <Chip icon={Cpu} tone="warn" title={runtime.message}>
          运行模式读取失败
        </Chip>
      ) : null}
      {view?.configured ? (
        <Chip
          icon={BrainCircuit}
          tone="good"
          title={`上游真实模型 ${view.model ?? "未报告"}；引擎看到的名称 ${view.alias}。点击查看或修改`}
          onClick={onOpenModel}
        >
          统一模型 {view.model ?? "未报告"}
          <span className="opacity-70">· 别名 {view.alias}</span>
        </Chip>
      ) : view ? (
        <Chip
          icon={BrainCircuit}
          tone="warn"
          title="各引擎仍使用自身的模型配置。点击配置统一模型"
          onClick={onOpenModel}
        >
          未配置统一模型
        </Chip>
      ) : model.state === "unsupported" ? (
        <Chip
          icon={BrainCircuit}
          title="需要支持 /v1/harness/model 的 Gateway"
          onClick={onOpenModel}
        >
          统一模型：当前 Gateway 不支持
        </Chip>
      ) : model.state === "error" ? (
        <Chip
          icon={BrainCircuit}
          tone="warn"
          title={model.message}
          onClick={onOpenModel}
        >
          统一模型读取失败
        </Chip>
      ) : (
        <Chip icon={Loader2} spin>
          读取统一模型
        </Chip>
      )}
    </div>
  );
}
