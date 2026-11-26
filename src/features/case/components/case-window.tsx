"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { HistoryButtons } from "@/components/design/history";
import { NAV_COOKIE, setPreference } from "@/lib/preferences";
import { caseSections, sectionFor } from "../nav";
import type { CaseWindowData } from "@/server/services/case-home";

/**
 * The case window (design: every case artboard): the station strip behind it, the title bar with close, and the
 * side panel of case sections with back, forward and collapse. On a phone the side panel opens from a menu.
 */
export function CaseWindow({ data, navOpen, children }: { data: CaseWindowData; navOpen: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(navOpen);
  const [menu, setMenu] = useState(false);
  const sections = caseSections(data.id);
  const current = sectionFor(data.id, pathname);

  // A phone's menu closes when the officer moves to another section.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setMenu(false);
  }
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  // The content scrolls inside the window, so a new section starts at its top (the browser only resets the page).
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [pathname]);

  const toggle = () => {
    setPreference(NAV_COOKIE, open ? "min" : "open");
    setOpen(!open);
  };

  return (
    <div className={`casewin ${current.scope}`}>
      <a className="skip" href="#case-main">
        Skip to the case screen
      </a>
      <div className="shell">
        <div className="backdrop" aria-hidden="true">
          <div className="bd-row">
            <span className="bd-card" />
            <span className="bd-card" />
            <span className="bd-card" />
            <span className="bd-card" />
          </div>
          <div className="bd-list" />
        </div>
        <div className="shelltop" style={{ zIndex: 1 }}>
          <Link href="/">
            <Icon name="grid" />
            Station dashboard
          </Link>
          <span className="wdot hidenarrow" aria-hidden="true" style={{ width: 4, height: 4, borderRadius: 999, background: C.faint }} />
          <span className="hidenarrow">
            {data.stationName} · {data.openCases} open {data.openCases === 1 ? "case" : "cases"}
          </span>
          <span className="ghost" aria-hidden="true">
            <span style={{ width: 140 }} />
            <span style={{ width: 90 }} />
            <span style={{ width: 180 }} />
          </span>
        </div>
        <div className="win" role="region" aria-label={`Case window · ${data.ref}`}>
          <div className="winbar">
            <button className="navmenu" type="button" aria-label="Open the case sections" aria-expanded={menu} aria-controls="case-sections" onClick={() => setMenu(!menu)}>
              <Icon name="sidebar" />
            </button>
            <span className="wt">
              {data.ref}
              <span className="hidenarrow"> · {data.title}</span>
              {data.closed ? <span className="hidenarrow"> · closed</span> : null}
            </span>
            <Link className="winclose" href="/" aria-label="Close the case window and return to the dashboard" title="Close and return to the dashboard">
              <Icon name="x" />
            </Link>
          </div>
          <div className="winbody" style={{ display: "flex", flexWrap: "wrap", position: "relative" }}>
            {menu ? <button className="navscrim" type="button" aria-label="Close the case sections" onClick={() => setMenu(false)} /> : null}
            <nav id="case-sections" className={`nav${open ? "" : " min"}${menu ? " open" : ""}`} aria-label="Case sections">
              <div className="navctl" aria-label="Back, forward and collapse">
                <Suspense fallback={null}>
                  <HistoryButtons />
                </Suspense>
                <button className="navtoggle" type="button" aria-label={open ? "Collapse the side panel" : "Expand the side panel"} aria-expanded={open} onClick={toggle}>
                  <Icon name="sidebar" />
                </button>
              </div>
              <div className="lbl" style={{ padding: "0 12px 6px" }}>
                {data.ref}
              </div>
              {sections.map((s) => {
                const on = s.key === current.key;
                return (
                  <Link key={s.key} className={`navitem${on ? " on" : ""}`} href={s.href} aria-current={on ? "page" : undefined} title={open ? undefined : s.label} aria-label={!open ? s.label : undefined}>
                    <Icon name={s.icon} strokeWidth={1.75} />
                    {s.label}
                    {s.key === "actions" && data.actionCount ? (
                      <span className="num" style={{ marginLeft: "auto", fontSize: 12, color: C.amber }} aria-label={`${data.actionCount} open`}>
                        {data.actionCount}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
              <div style={{ flex: "1 1 24px" }} />
              <div className="lbl" style={{ padding: "8px 12px 6px" }}>
                Department
              </div>
              <Link className="navitem" href="/assistant" title={open ? undefined : "Procedure Assistant"} aria-label={!open ? "Procedure Assistant" : undefined}>
                <Icon name="book" strokeWidth={1.75} />
                Procedure Assistant
              </Link>
              <div className="row" style={{ padding: 12, gap: 10, borderTop: `1px solid ${C.line}`, marginTop: 8 }}>
                <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 999, background: C.chip, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: C.chipFg, flex: "none" }}>
                  {data.viewer.initials}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{data.viewer.name}</div>
                  <div className="mut" style={{ fontSize: 12 }}>
                    {data.viewer.role}
                  </div>
                </div>
              </div>
            </nav>
            <main className="main" id="case-main" tabIndex={-1} ref={mainRef}>
              {children}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
