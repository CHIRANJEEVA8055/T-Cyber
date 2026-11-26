"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, BookOpen, Clock3, FileText, FolderOpen, Fingerprint, History, Inbox, Landmark, LayoutGrid, ListTodo, Sparkles, Users, Waypoints } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { CaseActions } from "@/components/app/case-header";
import type { CaseHeaderData } from "@/server/services/overview";

interface Section {
  href: string;
  label: string;
  /** Page title and description shown above the section; omitted where the page renders its own header. */
  title?: string;
  description?: string;
  icon: typeof LayoutGrid;
  /** Active only on this exact path (otherwise also on sub-paths). */
  exact?: boolean;
  /** Other paths that belong to this section. */
  also?: string[];
  badge?: { count: number; label: string; tone: "warning" | "neutral" };
}

function sections(c: CaseHeaderData): Section[] {
  return [
    { href: "", label: "Overview", icon: LayoutGrid, exact: true, title: "Case overview", description: "Where the case stands: money, open actions and what changed recently." },
    { href: "/investigation", label: "Next actions", icon: ListTodo, exact: true },
    { href: "/investigation/people", label: "People", icon: Users },
    { href: "/investigation/identifiers", label: "Identifiers & locations", icon: Fingerprint },
    { href: "/requests", label: "Requests & inbox", icon: Inbox, also: ["/responses"], badge: { count: c.responsesToReview, label: "responses to review", tone: "warning" } },
    { href: "/funds", label: "Funds & refunds", icon: Landmark, title: "Funds & refunds", description: "Reported loss, holds, allocations and refunds, computed from confirmed records only." },
    { href: "/evidence", label: "Evidence", icon: FolderOpen, badge: { count: c.candidatesPending, label: "extracted items to review", tone: "neutral" } },
    { href: "/graph", label: "Graph", icon: Waypoints, title: "Graph", description: "How money and identities connect. Each link comes from a confirmed record and shows its source." },
    { href: "/graph?view=timeline", label: "Timeline", icon: Clock3, title: "Timeline", description: "Events and discoveries in date order, each linked to its source." },
    { href: "/assistant", label: "Case AI", icon: Sparkles },
    { href: "/activity", label: "Activity & audit", icon: History, exact: true },
    { href: "/activity/reports", label: "Reports & handover", icon: FileText, also: ["/activity/handover"] },
  ];
}

function victimsLine(v: CaseHeaderData["victims"]) {
  if (!v.count || !v.first) return "No victim claim recorded";
  return v.count === 1 ? v.first : `${v.first} + ${v.count - 1} ${v.count === 2 ? "victim" : "victims"}`;
}

/**
 * Case navigation on wide screens (the reference layout): the case's identity and actions stay in view
 * while the officer moves between its sections. Narrow screens use the case header's section strip.
 */
function useIsActive(caseId: string) {
  const pathname = usePathname();
  const view = useSearchParams().get("view");
  const base = `/cases/${caseId}`;
  return (s: Section) => {
    if (s.href === "/graph") return pathname === `${base}/graph` && view !== "timeline";
    if (s.href === "/graph?view=timeline") return pathname === `${base}/graph` && view === "timeline";
    const paths = [s.href, ...(s.also ?? [])].map((p) => `${base}${p}`);
    return paths.some((p) => (s.exact ? pathname === p : pathname === p || pathname.startsWith(`${p}/`)));
  };
}

/** "All cases / FIR 1/2026 / Section" above case pages on wide screens (narrow screens show the case header). */
export function CaseBreadcrumb({ c }: { c: CaseHeaderData }) {
  const isActive = useIsActive(c.id);
  const section = sections(c).find(isActive);
  const base = `/cases/${c.id}`;
  return (
    <nav aria-label="Breadcrumb" className="no-print mx-auto hidden w-full max-w-[1440px] px-8 pt-6 lg:block">
      <ol className="flex flex-wrap items-center gap-1.5 text-label text-ink-3">
        <li>
          <Link href="/cases" className="hover:text-ink hover:underline">
            All cases
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li>
          {section && section.href !== "" ? (
            <Link href={base} className="hover:text-ink hover:underline">
              {c.reference}
            </Link>
          ) : (
            <span className="text-ink-2">{c.reference}</span>
          )}
        </li>
        {section && section.href !== "" ? (
          <>
            <li aria-hidden="true">/</li>
            <li>
              <span aria-current="page" className="text-ink-2">
                {section.label}
              </span>
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}

/** Title and description for the current case section, for pages that do not render their own header. */
export function CaseSectionHeading({ c }: { c: CaseHeaderData }) {
  const isActive = useIsActive(c.id);
  const section = sections(c).find(isActive);
  if (!section?.title) return null;
  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 pt-6 sm:px-6 lg:px-8 lg:pt-8">
      <h1 className="text-title font-semibold tracking-tight text-ink">{section.title}</h1>
      {section.description ? <p className="mt-1 max-w-[70ch] text-body text-ink-2">{section.description}</p> : null}
    </div>
  );
}

export function CaseSidebar({ c }: { c: CaseHeaderData }) {
  const isActive = useIsActive(c.id);
  const base = `/cases/${c.id}`;

  return (
    <aside aria-label="Case" className="no-print sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface [scrollbar-color:var(--color-line-strong)_transparent] [scrollbar-width:thin] lg:flex">
      <div className="border-b border-line px-5 pb-5 pt-4">
        <Link href="/cases" className="inline-flex items-center gap-1.5 text-label font-medium text-action hover:underline">
          <ArrowLeft aria-hidden="true" className="size-4" />
          All cases
        </Link>
        <p className="mt-3 text-heading font-semibold tracking-tight text-ink">{c.reference}</p>
        <p className="mt-0.5 line-clamp-2 text-label text-ink-2">{c.title}</p>
        <p className="mt-1.5 text-meta text-ink-3">{c.stationName}</p>
        <p className="text-meta text-ink-3">{victimsLine(c.victims)}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <StatusBadge kind="case" value={c.status} />
          {c.referenceType === "COMPLAINT" ? <Tag tone="warning">FIR not yet available</Tag> : null}
          {c.isDemo ? <Tag>Synthetic</Tag> : null}
        </div>
        <div className="mt-3">
          <CaseActions c={c} triggerClassName="h-9 w-full justify-between px-3 text-label" />
        </div>
      </div>
      <nav aria-label="Case sections" className="flex-1 px-3 py-3">
        <ul className="flex flex-col gap-0.5">
          {sections(c).map((s) => {
            const active = isActive(s);
            return (
              <li key={s.label}>
                <Link
                  href={`${base}${s.href}`}
                  aria-current={active ? "page" : undefined}
                  className={cn("flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-body", active ? "bg-action-tint font-medium text-action" : "text-ink-2 hover:bg-surface-muted hover:text-ink")}
                >
                  <s.icon aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.75} />
                  <span className="flex-1 truncate">{s.label}</span>
                  {s.badge && s.badge.count > 0 ? (
                    <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-meta font-semibold tabular-nums", s.badge.tone === "warning" ? "bg-warning-tint text-warning" : "bg-surface-sunken text-ink-2")}>
                      {s.badge.count}
                      <span className="sr-only"> {s.badge.label}</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 border-t border-line pt-3">
          <Link href="/guidance" className="flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-body text-ink-2 hover:bg-surface-muted hover:text-ink">
            <BookOpen aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.75} />
            AI guidance
          </Link>
          <p className="px-3 text-meta text-ink-3">Procedure library, separate from case evidence</p>
        </div>
      </nav>
    </aside>
  );
}
