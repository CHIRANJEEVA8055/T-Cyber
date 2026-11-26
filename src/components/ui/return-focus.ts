"use client";

import { useRef } from "react";

/**
 * Radix modals return focus to their Trigger on close. Overlays opened from state (a table row, a
 * graph record, a timeline entry) have no Trigger, so focus would fall to <body> and keyboard users
 * would lose their place. This remembers what had focus when the overlay opened and returns there
 * on close, as long as that element is still on the page.
 */
export function useReturnFocus() {
  const ref = useRef<HTMLElement | null>(null);
  return {
    remember() {
      const el = document.activeElement;
      ref.current = el instanceof HTMLElement && el !== document.body ? el : null;
    },
    onCloseAutoFocus(event: Event) {
      const el = ref.current;
      ref.current = null;
      if (el?.isConnected) {
        event.preventDefault();
        el.focus({ preventScroll: true });
      }
    },
  };
}
