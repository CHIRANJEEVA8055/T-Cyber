"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";

/**
 * Back and forward between the screens visited in this tab, like the design's own buttons. Kept in
 * sessionStorage, so it survives reloads but is never shared between tabs or people.
 */
const KEY = "tc.hist";
type Hist = { s: string[]; i: number };

function read(): Hist {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{"s":[],"i":-1}') as Hist;
  } catch {
    return { s: [], i: -1 };
  }
}
function write(h: Hist) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(h));
    window.dispatchEvent(new Event(KEY));
  } catch {
    /* storage may be unavailable (private mode): the buttons then stay disabled */
  }
}
const EMPTY = '{"s":[],"i":-1}';
const subscribe = (cb: () => void) => {
  window.addEventListener(KEY, cb);
  return () => window.removeEventListener(KEY, cb);
};
const snapshot = () => {
  try {
    return sessionStorage.getItem(KEY) ?? EMPTY;
  } catch {
    return EMPTY;
  }
};

export function useScreenHistory() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const url = `${pathname}${search.toString() ? `?${search}` : ""}`;
  const h = JSON.parse(useSyncExternalStore(subscribe, snapshot, () => EMPTY)) as Hist;
  useEffect(() => {
    const cur = read();
    if (cur.s[cur.i] === url) return;
    // A screen reached by back/forward is already in the stack; anything else is a new step.
    const at = cur.s.indexOf(url);
    if (at >= 0 && (at === cur.i - 1 || at === cur.i + 1)) cur.i = at;
    else {
      cur.s = [...cur.s.slice(0, cur.i + 1), url].slice(-50);
      cur.i = cur.s.length - 1;
    }
    write(cur);
  }, [url]);
  const go = (d: -1 | 1) => {
    const cur = read();
    const next = cur.i + d;
    if (next < 0 || next >= cur.s.length) return;
    cur.i = next;
    write(cur);
    router.push(cur.s[next]!);
  };
  return { canBack: h.i > 0, canFwd: h.i >= 0 && h.i < h.s.length - 1, back: () => go(-1), forward: () => go(1) };
}

export function HistoryButtons() {
  const { canBack, canFwd, back, forward } = useScreenHistory();
  return (
    <>
      <button className={`histbtn${canBack ? "" : " off"}`} type="button" aria-label="Back to the previous screen" title="Back" onClick={back} disabled={!canBack}>
        <Icon name="chevronLeft" />
      </button>
      <button className={`histbtn${canFwd ? "" : " off"}`} type="button" aria-label="Forward to the next screen" title="Forward" onClick={forward} disabled={!canFwd}>
        <Icon name="chevronRight" />
      </button>
    </>
  );
}
