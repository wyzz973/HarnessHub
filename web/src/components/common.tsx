import { AlertCircle, Check, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";

export function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={small ? "brand-mark small" : "brand-mark"} aria-hidden="true"><svg viewBox="0 0 36 36" fill="none"><path d="M8 7v22M28 7v22M8 18h20M18 7v22" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/><path d="m8 7 10 5 10-5M8 29l10-5 10 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>;
}
export function Spinner({ label = "加载中" }: { label?: string }) { return <LoaderCircle size={16} className="spinner" aria-label={label} />; }
export function ErrorNotice({ message, onDismiss, action }: { message: string; onDismiss?: () => void; action?: ReactNode }) {
  return <div className="error-notice" role="alert"><AlertCircle size={17} aria-hidden="true"/><div>{message}{action}</div>{onDismiss ? <button className="icon-button" aria-label="关闭提示" onClick={onDismiss}><X size={16}/></button> : null}</div>;
}
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon" aria-hidden="true">{icon}</div><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function StatusBadge({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warning" | "danger"; children: ReactNode }) {
  return <span className={`status-badge ${tone}`}>{tone === "success" ? <Check size={11} aria-hidden="true"/> : <span className="status-dot" aria-hidden="true"/>}{children}</span>;
}
export function endpointLabel(url: string): string { try { const value = new URL(url); return value.host + (value.pathname === "/" ? "" : value.pathname); } catch { return url; } }
