"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useRevealCurrent } from "@/components/app/use-reveal-current";

/**
 * Second-level navigation as underline tabs (case sub-sections, settings sections). On a narrow screen
 * the tabs scroll sideways and the current one is scrolled into view.
 */
export function SubNav({ label, items, className }: { label: string; items: { href: string; label: string; exact?: boolean }[]; className?: string }) {
  const pathname = usePathname();
  const strip = useRef<HTMLElement>(null);
  useRevealCurrent(strip, pathname);
  return (
    <div className={cn("no-print mx-auto w-full max-w-[1440px] px-4 pt-5 sm:px-6 lg:px-8", className)}>
      <nav ref={strip} aria-label={label} className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-6">
          {items.map((i) => {
            const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
            return (
              <li key={i.href}>
                <Link
                  href={i.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-10 items-center text-body font-medium",
                    active ? "text-action after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-action" : "text-ink-2 hover:text-ink",
                  )}
                >
                  {i.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
