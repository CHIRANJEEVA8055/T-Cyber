"use client";

import { useRef, type ReactNode } from "react";
import { useRevealCurrent } from "@/components/app/use-reveal-current";

/** A horizontally scrolling <nav> for server-rendered tab strips; keeps the current item in view. */
export function RevealStrip({ label, revealKey, className, children }: { label: string; revealKey: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useRevealCurrent(ref, revealKey);
  return (
    <nav ref={ref} aria-label={label} className={className}>
      {children}
    </nav>
  );
}
