import type { IconName } from "@/components/ui/icon";

/**
 * The case window's sections, in the design's order, with the screen scope each one renders under. Screens not
 * yet rebuilt in the new design point at their existing routes; each entry changes in one place when it moves.
 */
export interface CaseSection {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  /** design.css scopes rules per screen with :where(.scr-…). */
  scope: string;
  /** Path prefixes (after /cases/<id>) that count as this section. "" is the overview itself. */
  paths: string[];
}

export function caseSections(id: string): CaseSection[] {
  const b = `/cases/${id}`;
  return [
    { key: "overview", label: "Overview", icon: "grid", href: b, scope: "scr-main", paths: [""] },
    { key: "actions", label: "Next Actions", icon: "bolt", href: `${b}/actions`, scope: "scr-next-actions", paths: ["/actions"] },
    { key: "people", label: "People & Identifiers", icon: "people", href: `${b}/people`, scope: "scr-people", paths: ["/people", "/investigation"] },
    { key: "recovery", label: "Transactions & Recovery", icon: "card", href: `${b}/recovery`, scope: "scr-recovery", paths: ["/recovery", "/funds"] },
    { key: "requests", label: "Requests & Responses", icon: "mail", href: `${b}/requests`, scope: "scr-requests", paths: ["/requests", "/responses"] },
    { key: "intake", label: "Intake & Evidence", icon: "file", href: `${b}/intake`, scope: "scr-intake", paths: ["/intake", "/evidence"] },
    { key: "graph", label: "Graph & Timeline", icon: "graph", href: `${b}/graph`, scope: "scr-graph", paths: ["/graph"] },
    { key: "assistant", label: "Case Assistant", icon: "chat", href: `${b}/assistant`, scope: "scr-case-assistant", paths: ["/assistant"] },
    { key: "audit", label: "Activity & Audit", icon: "clock", href: `${b}/activity`, scope: "scr-audit", paths: ["/activity"] },
    { key: "reports", label: "Reports & Handover", icon: "report", href: `${b}/activity/reports`, scope: "scr-reports", paths: ["/reports", "/activity/reports", "/activity/handover"] },
  ];
}

/** The section a path belongs to: the longest matching prefix wins ("/activity/reports" is Reports, not Audit). */
export function sectionFor(id: string, pathname: string): CaseSection {
  const sections = caseSections(id);
  const rest = pathname.startsWith(`/cases/${id}`) ? pathname.slice(`/cases/${id}`.length).replace(/\/$/, "") : "";
  let best: { s: CaseSection; len: number } | null = null;
  for (const s of sections)
    for (const p of s.paths) {
      const hit = p === "" ? rest === "" : rest === p || rest.startsWith(`${p}/`);
      if (hit && (!best || p.length > best.len)) best = { s, len: p.length };
    }
  return best?.s ?? sections[0]!;
}
