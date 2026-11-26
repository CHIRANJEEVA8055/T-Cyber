import {
  AlertTriangle,
  BadgeCheck,
  Check,
  CircleDot,
  CircleHelp,
  Clock3,
  Eye,
  Hourglass,
  Inbox,
  Link2,
  Lock,
  Minus,
  Pause,
  PencilLine,
  Send,
  CircleDashed,
  X,
  type LucideIcon,
} from "lucide-react";
import { statusDef, type IconName, type Tone } from "@/lib/labels";
import { cn } from "@/lib/cn";

const ICONS: Record<IconName, LucideIcon> = {
  draft: PencilLine,
  hourglass: Hourglass,
  approved: BadgeCheck,
  send: Send,
  inbox: Inbox,
  partial: CircleDashed,
  check: Check,
  x: X,
  alert: AlertTriangle,
  dot: CircleDot,
  clock: Clock3,
  lock: Lock,
  pause: Pause,
  minus: Minus,
  eye: Eye,
  question: CircleHelp,
  link: Link2,
};

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-neutral-tint text-ink-2 border-[rgb(21_35_59/0.08)]",
  info: "bg-action-tint text-info-ink border-[rgb(40_102_197/0.14)]",
  success: "bg-success-tint text-success border-[rgb(23_102_58/0.16)]",
  warning: "bg-warning-tint text-warning border-[rgb(138_83_0/0.18)]",
  danger: "bg-danger-tint text-danger border-[rgb(180_35_24/0.16)]",
};

/** Status with icon + text + tone. Meaning never depends on colour alone. */
export function StatusBadge({ kind, value, className, label }: { kind: string; value: string; className?: string; label?: string }) {
  const def = statusDef(kind, value);
  const Icon = ICONS[def.icon];
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--radius-chip)] border px-1.5 text-meta font-medium", TONE_CLASSES[def.tone], className)}>
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
      {label ?? def.label}
    </span>
  );
}

/** Small neutral tag for categorical metadata that is not a status (e.g. "Synthetic", "Layer 2"). */
export function Tag({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: Tone; className?: string }) {
  return <span className={cn("inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-[var(--radius-chip)] border px-1.5 text-meta font-medium", TONE_CLASSES[tone], className)}>{children}</span>;
}
