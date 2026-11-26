import { Fragment } from "react";
import { addressBreakPoints } from "@/lib/recipients";
import { cn } from "@/lib/cn";

/** An email or portal address that wraps only after "@" or before a dot, never mid-word. */
export function Address({ value, className }: { value: string; className?: string }) {
  const parts = addressBreakPoints(value);
  return (
    <span className={cn("font-mono [overflow-wrap:anywhere]", className)}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          {p}
        </Fragment>
      ))}
    </span>
  );
}
