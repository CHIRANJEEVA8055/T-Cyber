"use client";

import { DropdownMenu as M } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Secondary actions live in a labelled menu ("More actions", "Case actions"), never behind an unlabeled icon only. */
export function ActionMenu({ label, children, align = "end", triggerClassName }: { label: string; children: ReactNode; align?: "start" | "end"; triggerClassName?: string }) {
  return (
    <M.Root>
      <M.Trigger
        className={cn(
          "inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-input bg-surface px-3.5 text-body font-medium text-ink shadow-[var(--shadow-control)] hover:bg-surface-muted data-[state=open]:bg-surface-muted pointer-coarse:h-11",
          triggerClassName,
        )}
      >
        {label}
        <ChevronDown className="size-4 text-ink-3" aria-hidden="true" />
      </M.Trigger>
      <M.Portal>
        <M.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="anim-pop z-[55] min-w-56 rounded-[var(--radius-panel)] border border-line bg-surface p-1.5 shadow-[var(--shadow-highlight),var(--shadow-raised)]"
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function ActionMenuItem({ children, onSelect, icon, tone, disabled, description }: { children: ReactNode; onSelect: () => void; icon?: ReactNode; tone?: "danger"; disabled?: boolean; description?: string }) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-start gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-body outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-surface-sunken data-[disabled]:opacity-50 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
        tone === "danger" ? "text-danger" : "text-ink",
      )}
    >
      {icon}
      <span className="flex flex-col">
        {children}
        {description ? <span className="text-meta text-ink-3">{description}</span> : null}
      </span>
    </M.Item>
  );
}

export function ActionMenuSeparator() {
  return <M.Separator className="my-1.5 h-px bg-line" />;
}

export function ActionMenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pb-1 pt-1.5 text-meta font-medium text-ink-3">{children}</M.Label>;
}
