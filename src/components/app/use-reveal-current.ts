"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Horizontally scrolling tab strips (case sections, sub-sections, settings) start scrolled to the
 * left, so on a phone the current tab can sit off-screen. This scrolls the strip, not the page, so
 * the item marked aria-current="page" is fully visible, centred when it had to move. Instant: no
 * animated scrolling.
 */
export function useRevealCurrent(ref: RefObject<HTMLElement | null>, key: string) {
  useLayoutEffect(() => {
    const strip = ref.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !current || strip.scrollWidth <= strip.clientWidth) return;
    const box = strip.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.left >= box.left && item.right <= box.right) return;
    strip.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
  }, [ref, key]);
}
