"use client";

import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { useReturnFocus } from "./return-focus";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

const SIZES = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" } as const;

/**
 * Viewport-bounded modal: the body scrolls, the header and footer actions stay visible.
 * Radix traps focus while open and restores it to the trigger on close; Escape always closes.
 */
export function DialogContent({
  title,
  description,
  size = "md",
  children,
  footer,
  className,
  initialFocusRef,
}: {
  title: ReactNode;
  description?: ReactNode;
  size?: keyof typeof SIZES;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const returnFocus = useReturnFocus();
  return (
    <D.Portal>
      <D.Overlay className="scrim anim-scrim fixed inset-0 z-50" />
      <div className="pointer-events-none fixed inset-0 z-[51] flex items-center justify-center p-4">
        <D.Content
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          onOpenAutoFocus={(e) => {
            returnFocus.remember();
            if (initialFocusRef?.current) {
              e.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          className={cn(
            "anim-dialog pointer-events-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-highlight),0_24px_48px_-12px_rgba(0,0,0,0.07)] outline-none",
            SIZES[size],
            className,
          )}
        >
          <div className="flex items-start gap-4 border-b border-line px-6 py-4">
            <div className="min-w-0 flex-1">
              <D.Title className="text-heading font-semibold tracking-tight text-ink">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-body text-ink-2">{description}</D.Description> : <D.Description className="sr-only">Dialog</D.Description>}
            </div>
            <D.Close className="-mr-2 -mt-1 inline-flex size-9 items-center justify-center rounded-[var(--radius-control)] text-ink-3 hover:bg-surface-sunken hover:text-ink" aria-label="Close dialog">
              <X className="size-[18px]" aria-hidden="true" />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-muted px-6 py-3.5 rounded-b-[var(--radius-panel)]">{footer}</div> : null}
        </D.Content>
      </div>
    </D.Portal>
  );
}

export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the exact action and entity, e.g. "Submit REQ-412/2026-002 to Demo Bank B?" */
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => Promise<boolean | void> | boolean | void;
  children?: ReactNode;
  size?: "sm" | "md" | "lg";
}

/** Final check before consequential actions. Cancel has default focus; Escape cancels without side effects. */
export function ConfirmationDialog({ open, onOpenChange, title, description, confirmLabel, tone = "primary", onConfirm, children, size = "sm" }: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title={title}
        description={description}
        size={size}
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await onConfirm();
                  if (result !== false) onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
