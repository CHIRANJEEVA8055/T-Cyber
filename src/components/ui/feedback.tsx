"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("spin size-4", className)}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("skeleton h-4", className)} />;
}

type AlertTone = "info" | "success" | "warning" | "danger";
const ALERT: Record<AlertTone, { cls: string; Icon: typeof Info }> = {
  info: { cls: "border-[rgb(40_102_197/0.2)] bg-action-tint text-info-ink", Icon: Info },
  success: { cls: "border-[rgb(23_102_58/0.2)] bg-success-tint text-success", Icon: CheckCircle2 },
  warning: { cls: "border-[rgb(138_83_0/0.22)] bg-warning-tint text-warning", Icon: AlertTriangle },
  danger: { cls: "border-[rgb(180_35_24/0.22)] bg-danger-tint text-danger", Icon: XCircle },
};

/** Inline banner for blocked workflows, warnings and confirmations within a page or panel. */
export function InlineAlert({ tone = "info", title, children, action, className, role }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; role?: "alert" | "status" }) {
  const { cls, Icon } = ALERT[tone];
  return (
    <div role={role ?? (tone === "danger" ? "alert" : "status")} className={cn("flex gap-3 rounded-[var(--radius-control)] border px-4 py-3 text-body", cls, className)}>
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {/* The action sits under the text on narrow screens and beside it from 640px. */}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          {title ? <p className="font-medium">{title}</p> : null}
          {children ? <div className={cn(title ? "mt-0.5" : "", "text-ink-2 [&_strong]:text-ink")}>{children}</div> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

interface Toast {
  id: number;
  tone: "success" | "danger" | "info";
  message: string;
}

const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

/** Polite live region for action outcomes. Toasts never carry the only copy of important information. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-4 bottom-4 z-[70] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => setToasts((all) => all.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, toast.tone === "danger" ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [onDone, toast.tone]);
  const Icon = toast.tone === "success" ? CheckCircle2 : toast.tone === "danger" ? XCircle : Info;
  return (
    <div className="anim-pop pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[var(--radius-panel)] border border-line bg-surface px-4 py-3 text-body shadow-[var(--shadow-highlight),var(--shadow-raised)]" data-state="open">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", toast.tone === "success" ? "text-success" : toast.tone === "danger" ? "text-danger" : "text-action")} />
      <p className="min-w-0 flex-1 text-ink">{toast.message}</p>
      <button type="button" onClick={onDone} aria-label="Dismiss notification" className="-m-1 rounded p-1 text-ink-3 hover:text-ink">
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
