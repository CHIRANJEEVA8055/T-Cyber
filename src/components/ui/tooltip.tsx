"use client";

import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={300} skipDelayDuration={200}>
      {children}
    </T.Provider>
  );
}

/** Supplements a visible or accessible label; never the only label. Shows on hover and keyboard focus. */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="anim-pop z-[60] max-w-xs rounded-[var(--radius-control)] bg-ink px-2.5 py-1.5 text-label text-white shadow-[var(--shadow-raised)]"
        >
          {content}
          <T.Arrow className="fill-ink" width={10} height={5} />
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ml-2 rounded-[var(--radius-chip)] border border-white/25 px-1 font-sans text-meta text-white/85">{children}</kbd>;
}
