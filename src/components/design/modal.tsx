"use client";

import { Dialog as D } from "radix-ui";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

/**
 * The design's modal (.ov / .ovbg / .modal) on Radix Dialog: focus is trapped while open and returned to the
 * trigger on close; Escape and the backdrop close it. The portal wrapper carries the screen's scope class
 * (e.g. scr-dashboard) so the design's scoped styles apply outside the page tree.
 */
export function DesignModal({
  open,
  onClose,
  scope,
  maxWidth,
  title,
  returnFocusTo,
  children,
}: {
  open: boolean;
  onClose: () => void;
  scope: string;
  maxWidth?: number;
  /** Accessible name of the dialog when no <ModalTitle> is rendered inside it. */
  title?: string;
  /** The element focus goes back to on close, when it is not the element focused at opening. */
  returnFocusTo?: () => HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <div className={scope}>
          <div className="ov">
            <D.Overlay className="ovbg" />
            <D.Content
              className="modal"
              style={maxWidth ? { maxWidth } : undefined}
              aria-describedby={undefined}
              onCloseAutoFocus={(e) => {
                const el = returnFocusTo?.();
                if (el && el.isConnected) {
                  e.preventDefault();
                  el.focus();
                }
              }}
            >
              {title && <D.Title className="srt">{title}</D.Title>}
              <D.Close className="close" aria-label="Close">
                <Icon name="x" />
              </D.Close>
              {children}
            </D.Content>
          </div>
        </div>
      </D.Portal>
    </D.Root>
  );
}

/** The modal's visible heading, which also names the dialog. */
export function ModalTitle({ id, children, style, className = "h" }: { id?: string; children: ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <D.Title id={id} className={className} style={style}>
      {children}
    </D.Title>
  );
}

export const ModalClose = D.Close;
