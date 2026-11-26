import { formatDateIST, formatDateTimeIST } from "@/domain/time";
import { cn } from "@/lib/cn";

/** Timestamps are stored in UTC and always shown in Asia/Kolkata with an explicit IST label. */
export function DateTime({ iso, mode = "datetime", seconds, label = true, className, fallback = "Not recorded" }: { iso: string | null | undefined; mode?: "datetime" | "date"; seconds?: boolean; label?: boolean; className?: string; fallback?: string }) {
  if (!iso) return <span className={cn("text-ink-3", className)}>{fallback}</span>;
  const d = new Date(iso);
  return (
    <time dateTime={iso} className={cn("whitespace-nowrap tabular-nums", className)}>
      {mode === "date" ? formatDateIST(d) : formatDateTimeIST(d, { seconds, label })}
    </time>
  );
}
