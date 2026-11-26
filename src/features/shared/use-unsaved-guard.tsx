"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConfirmationDialog } from "@/components/ui/dialog";

/**
 * Protects unsaved edits: warns before closing the tab, and intercepts in-app link clicks with a
 * named confirmation instead of silently discarding work.
 */
/**
 * `keptInBrowser` must only be true for editors that really save unsaved edits locally (request and report drafts),
 * so the warning never promises a recovery that will not happen.
 */
export function useUnsavedGuard(dirty: boolean, opts: { keptInBrowser?: boolean } = {}) {
  const keptInBrowser = opts.keptInBrowser ?? true;
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.dataset.allowUnsaved === "true") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  const dialog = (
    <ConfirmationDialog
      open={pendingHref !== null}
      onOpenChange={(o) => !o && setPendingHref(null)}
      title="Leave without saving your changes?"
      description={
        keptInBrowser
          ? "Your edits have not been saved as a new version. They stay in this browser and are offered again when you come back."
          : "Your edits have not been saved and will be lost if you leave."
      }
      confirmLabel="Leave this page"
      tone="danger"
      onConfirm={() => {
        const href = pendingHref;
        setPendingHref(null);
        if (href) router.push(href);
      }}
    />
  );
  return { dialog };
}
