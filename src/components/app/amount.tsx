import { formatInr, minorFromString } from "@/domain/money";
import { cn } from "@/lib/cn";

/**
 * Renders minor-unit strings as Indian rupees with tabular numerals. Null means unknown and is
 * shown as "Unknown" with an explanation — never as ₹0.
 */
export function AmountDisplay({ minor, className, unknownLabel = "Unknown", unknownHint = "Not confirmed. Unknown is not ₹0." }: { minor: string | null | undefined; className?: string; unknownLabel?: string; unknownHint?: string }) {
  if (minor === null || minor === undefined) {
    return (
      <span className={cn("whitespace-nowrap text-ink-3 italic", className)}>
        {unknownLabel}
        <span className="sr-only"> ({unknownHint})</span>
      </span>
    );
  }
  return <span className={cn("whitespace-nowrap tabular-nums", className)}>{formatInr(minorFromString(minor))}</span>;
}
