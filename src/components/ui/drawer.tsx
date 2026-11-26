"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useReturnFocus } from "./return-focus";

/**
 * Slide-over for quick inspection without leaving the page. Fixed position (no layout shift),
 * focus trapped while open and restored on close; full width on narrow screens.
 */
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  width = "md",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
}) {
  const returnFocus = useReturnFocus();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="scrim anim-scrim fixed inset-0 z-50" />
        <D.Content
          onOpenAutoFocus={returnFocus.remember}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          className={cn(
            "anim-drawer fixed inset-y-0 right-0 z-[51] flex w-full flex-col border-l border-line bg-surface shadow-[0_0_48px_-12px_rgba(0,0,0,0.07)] outline-none",
            width === "md" ? "sm:max-w-[480px]" : "sm:max-w-[640px]",
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-6 py-4">
            <div className="min-w-0 flex-1">
              <D.Title className="text-heading font-semibold tracking-tight text-ink">{title}</D.Title>
              {subtitle ? <D.Description className="mt-1 text-label text-ink-2">{subtitle}</D.Description> : <D.Description className="sr-only">Details</D.Description>}
            </div>
            <D.Close className="-mr-2 inline-flex size-10 items-center justify-center rounded-[var(--radius-control)] text-ink-3 hover:bg-surface-sunken hover:text-ink" aria-label="Close panel">
              <X className="size-[18px]" aria-hidden="true" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-muted px-6 py-3.5">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
