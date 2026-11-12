import { useEffect, useRef, useState } from "react";
import { deliveryWords, evidenceWords, packetFacts, syncWords } from "../lib/relay-state.js";
import type { RelayApi, RelayPacket, RelayView } from "../relay.js";
import { Dialog, DialogClose, useClosingValue } from "../ui/overlay.js";
import { Badge, EmptyState, Spinner } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";

/** A packet's text as it was stored when it was sent: nothing is processed again when it is read (relay-architecture §10.2). */
type PacketText = { readonly packetId: string; readonly status: "loading" } | { readonly packetId: string; readonly status: "ready"; readonly text: string; readonly etag: string | null }
  | { readonly packetId: string; readonly status: "failed"; readonly message: string };
/** What the dialog is opened for: the packet, its number when known, and what the relay view says of it. */
export interface PacketTarget { readonly packetId: string; readonly number: number | null; readonly facts: RelayPacket | null }

/** Opens one packet's text, read from the Gateway when the dialog opens, with a way to copy it. */
export function RelayPacketDialog({ api, sessionId, packet, onClose, name }: {
  readonly api: RelayApi; readonly sessionId: string; readonly packet: PacketTarget | null; readonly onClose: () => void; readonly name: (id: string) => string;
}) {
  const shown = useClosingValue(packet);
  const [state, setState] = useState<PacketText | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const packetId = packet?.packetId ?? null;
  useEffect(() => {
    if (packetId === null) return;
    const controller = new AbortController();
    setState({ packetId, status: "loading" }); setCopy("idle");
    api.packetText(sessionId, packetId, controller.signal).then(
      result => { if (!controller.signal.aborted) setState({ packetId, status: "ready", text: result.text, etag: result.etag }); },
      (failure: unknown) => { if (!controller.signal.aborted) setState({ packetId, status: "failed", message: failure instanceof Error ? failure.message : "这份交接单没有读到。" }); });
    return () => controller.abort();
  }, [api, sessionId, packetId]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  if (shown === null) return null;
  const current = state !== null && state.packetId === shown.packetId ? state : { packetId: shown.packetId, status: "loading" as const };
  const facts = shown.facts, title = shown.number === null ? "交接单" : `交接单 #${shown.number}`;
  const description = facts === null ? "发出时的原文" : [`发给 ${name(facts.target.harnessId)}`, packetFacts(facts)].filter(Boolean).join(" · ");
  const write = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopy("copied"); } catch { setCopy("failed"); }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy("idle"), 1800);
  };
  return <Dialog open={packet !== null} onOpenChange={open => { if (!open) onClose(); }} title={title} description={description} className="relay-packet-dialog w-[min(760px,calc(100vw-32px))]">
    <div className="flex flex-col gap-3 px-5 pt-3 pb-5">
      {current.status === "loading" ? <p className="m-0 flex items-center gap-2 py-6 text-ui-sm text-fg-2" role="status"><Spinner size={13} label=""/>正在读取交接单</p>
        : current.status === "failed" ? <p className="m-0 rounded-block bg-red-soft px-3 py-2.5 text-ui-sm text-red-on-tint" role="alert">{current.message}</p>
        : <pre className="relay-packet-text m-0 max-h-[min(60vh,520px)] overflow-auto rounded-block bg-inset p-3 font-mono text-code break-words whitespace-pre-wrap" tabIndex={0} aria-label="交接单原文">{current.text}</pre>}
      <p className="m-0 text-caption text-fg-3">这是发出时的原文，逐字保存；查看时不会重新处理。{current.status === "ready" && current.etag ? <span className="mono" title="原文的 sha256"> sha256 {current.etag.replace(/^sha256[-:]/u, "").slice(0, 12)}…</span> : null}</p>
      <div className="flex justify-end gap-2">
        {current.status === "ready" ? <button type="button" className="btn" onClick={() => void write(current.text)}>{copy === "copied" ? "已复制" : copy === "failed" ? "无法使用剪贴板" : "复制原文"}</button> : null}
        <DialogClose className="btn btn-primary">关闭</DialogClose>
      </div>
    </div>
  </Dialog>;
}

/**
 * The details panel's "接续" tab (relay-architecture §12.1): where each Harness entry of the conversation stands, in one
 * sentence each, and the packets that were sent, with how each fared and a way to read it.
 */
export function RelayDetails({ view, name, onViewPacket }: { readonly view: RelayView; readonly name: (id: string) => string; readonly onViewPacket: (packetId: string) => void }) {
  return <div className="relay-details flex flex-col gap-5 px-4 pt-3.5 pb-4 text-ui-sm">
    <section className="flex flex-col gap-1" aria-label="各 Harness 的同步状态">
      <span className="text-caption text-fg-3">各 Harness 的同步状态</span>
      {view.bindings.length ? <ul className="m-0 flex list-none flex-col p-0">{view.bindings.map(binding => <li key={binding.harnessId + ":" + binding.controlId} className="relay-binding flex min-w-0 flex-col gap-0.5 py-2 hairline-b last:border-b-0" data-sync={binding.sync}>
        <div className="flex min-w-0 items-center gap-2"><BrandIcon brand={binding.harnessId} name={name(binding.harnessId)} size={18}/>
          <span className="min-w-0 truncate font-medium">{name(binding.harnessId)}</span></div>
        <p className="m-0 pl-[26px] text-caption text-fg-2">{syncWords(binding)}</p>
      </li>)}</ul> : <p className="m-0 py-2 text-caption text-fg-3">还没有 Harness 在这个对话里留下原生会话。</p>}
    </section>
    <section className="flex flex-col gap-1" aria-label="交接单">
      <span className="text-caption text-fg-3">交接单</span>
      {view.packets.length ? <ul className="m-0 flex list-none flex-col p-0">{view.packets.map(packet => {
        const proof = packet.delivery === "recorded" ? evidenceWords(packet.evidence) : null;
        return <li key={packet.packetId} className="relay-packet flex min-w-0 flex-col gap-1 py-2 hairline-b last:border-b-0" data-delivery={packet.delivery ?? "unknown"}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">交接单 #{packet.number}</span><span className="min-w-0 truncate text-caption text-fg-3">交给 {name(packet.target.harnessId)}</span>
            <Badge tone={packet.delivery === "not_recorded" ? "red" : packet.delivery === "recorded" || packet.delivery === "in_flight" ? "accent" : "neutral"}>{deliveryWords(packet.delivery)}{proof === null ? "" : ` · ${proof}`}</Badge>
            <button type="button" className="link-btn ml-auto flex-none text-caption" aria-label={`查看原文 · 交接单 #${packet.number}`} onClick={() => onViewPacket(packet.packetId)}>查看原文</button>
          </div>
          <p className="m-0 text-caption text-fg-3">{packetFacts(packet)}</p>
        </li>;
      })}</ul> : <EmptyState title="还没有交接单">把对话交给另一个 Harness 时，发出的交接单会列在这里。</EmptyState>}
    </section>
  </div>;
}
