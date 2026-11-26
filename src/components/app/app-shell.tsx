"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { Dialog as D, DropdownMenu as M } from "radix-ui";
import { BookOpen, Briefcase, ChevronDown, ListChecks, LogOut, Mail, Menu, Printer, Search, Settings, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { logoutAction } from "@/features/auth/actions";

export interface ShellUser {
  displayName: string;
  rank: string;
  role: "OFFICER" | "SUPERVISOR" | "DEVELOPER";
  stationName: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof Briefcase;
  count?: number;
  countLabel?: string;
}

function navItems(counts: { workQueue: number; correspondence: number }): NavItem[] {
  return [
    { href: "/cases", label: "Cases", icon: Briefcase },
    { href: "/work-queue", label: "Work queue", icon: ListChecks, count: counts.workQueue, countLabel: "items need action" },
    { href: "/correspondence", label: "Correspondence", icon: Mail, count: counts.correspondence, countLabel: "responses to review" },
    { href: "/guidance", label: "AI guidance", icon: BookOpen },
    { href: "/settings", label: "Settings", icon: Settings },
  ];
}

/** A case workspace (not the New FIR page) brings its own sidebar on wide screens. */
function isCaseWorkspace(pathname: string) {
  return /^\/cases\/(?!new(?:\/|$))[^/]+/.test(pathname);
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn("flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-body pointer-coarse:h-11", active ? "bg-action-tint font-medium text-action" : "text-ink-2 hover:bg-surface-muted hover:text-ink")}
            >
              <item.icon aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.75} />
              <span className="flex-1 truncate">{item.label}</span>
              {item.count ? (
                <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-meta font-semibold tabular-nums", active ? "bg-action text-white" : "bg-surface-sunken text-ink-2")}>
                  {item.count}
                  <span className="sr-only"> {item.countLabel}</span>
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand({ stationName }: { stationName: string }) {
  return (
    <Link href="/cases" className="flex min-w-0 items-center gap-2.5" aria-label="T-CYBER, go to cases">
      <img src="/brand/TG_POLICE.png" alt="" className="h-10 w-auto shrink-0" />
      <span className="min-w-0">
        <span className="block text-[1.375rem] font-semibold leading-none tracking-tight text-ink">T-CYBER</span>
        <span className="mt-1 hidden truncate text-meta leading-none text-ink-3 sm:block">{stationName}</span>
      </span>
    </Link>
  );
}

const subscribeSeconds = (onTick: () => void) => {
  const timer = window.setInterval(onTick, 1000);
  return () => window.clearInterval(timer);
};
const IST_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Station time. Shown after hydration: the server's clock and the officer's can differ by a second. */
function IstClock() {
  const second = useSyncExternalStore(
    subscribeSeconds,
    () => Math.floor(Date.now() / 1000),
    () => 0,
  );
  return (
    <span className="hidden h-8 items-center rounded-[var(--radius-control)] bg-warning-tint px-2.5 text-label font-semibold tabular-nums text-warning xl:inline-flex">
      <span className="sr-only">India Standard Time </span>
      {second ? IST_TIME.format(new Date(second * 1000)) : "--:--:--"}
      <span aria-hidden="true" className="ml-1 font-medium">
        IST
      </span>
    </span>
  );
}

function initials(name: string) {
  return name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(-2)
    .map((p) => p[0])
    .join("");
}

export function AppShell({ user, counts, children }: { user: ShellUser; counts: { workQueue: number; correspondence: number }; children: ReactNode }) {
  const pathname = usePathname();
  const items = navItems(counts);
  const inCase = isCaseWorkspace(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, startSignOut] = useTransition();

  return (
    <div className="min-h-dvh">
      <a href="#main" className="fixed left-3 top-3 z-[80] -translate-y-20 rounded-[var(--radius-control)] bg-action px-4 py-2 text-body font-medium text-white focus:translate-y-0">
        Skip to main content
      </a>

      <header className="no-print chrome-blur sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line px-3 sm:px-4 lg:px-5">
        <button type="button" onClick={() => setMobileOpen(true)} aria-label="Open navigation" className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-ink-2 hover:bg-surface-sunken lg:hidden">
          <Menu aria-hidden="true" className="size-5" />
        </button>
        <div className="min-w-0 shrink-0">
          <Brand stationName={user.stationName} />
        </div>
        <form action="/search" method="get" role="search" className="hidden max-w-md flex-1 items-center md:flex">
          <label htmlFor="global-search" className="mr-2 text-label font-medium text-ink-2">
            Search
          </label>
          <div className="relative flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <input id="global-search" name="q" type="search" placeholder="FIR number, identifier or text" className="h-10 w-full rounded-[var(--radius-control)] border border-line-input bg-surface pl-9 pr-3 text-body text-ink placeholder:text-ink-3 focus-visible:border-focus focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[rgb(40_102_197/0.25)]" />
          </div>
        </form>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Link href="/search" aria-label="Search" className="inline-flex size-11 items-center justify-center rounded-[var(--radius-control)] text-ink-2 hover:bg-surface-sunken md:hidden">
            <Search aria-hidden="true" className="size-5" />
          </Link>
          <IstClock />
          <Tooltip content="Synthetic demonstration data. Bank, telecom, NPCI and portal connections are simulated; nothing is sent.">
            <span tabIndex={0} className="hidden h-8 items-center rounded-[var(--radius-control)] border border-line bg-surface-muted px-2.5 text-label font-medium text-ink-2 lg:inline-flex">
              Demo data
            </span>
          </Tooltip>
          <button type="button" onClick={() => window.print()} className="hidden h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-input bg-surface px-2.5 text-label font-medium text-ink hover:bg-surface-muted lg:inline-flex">
            <Printer aria-hidden="true" className="size-4" />
            Print
          </button>
          <M.Root>
            <M.Trigger className="flex h-11 items-center gap-2 rounded-[var(--radius-panel)] bg-surface-muted pl-1.5 pr-2 text-left hover:bg-surface-sunken data-[state=open]:bg-surface-sunken" aria-label={`Account menu for ${user.rank} ${user.displayName}`}>
              <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-amber-soft text-meta font-semibold text-warning">
                {initials(user.displayName)}
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-label font-semibold leading-tight text-ink">{user.displayName}</span>
                <span className="block truncate text-meta leading-tight text-ink-3">{user.role === "SUPERVISOR" ? "Supervisor" : "Investigating officer"}</span>
              </span>
              <ChevronDown aria-hidden="true" className="hidden size-4 text-ink-3 sm:block" />
            </M.Trigger>
            <M.Portal>
              <M.Content align="end" sideOffset={6} className="anim-pop z-[55] w-64 rounded-[var(--radius-panel)] border border-line bg-surface p-1.5 shadow-[var(--shadow-highlight),var(--shadow-raised)]">
                <div className="px-2.5 py-2">
                  <p className="text-body font-medium text-ink">
                    {user.rank} {user.displayName}
                  </p>
                  <p className="text-label text-ink-2">{user.stationName}</p>
                  <p className="mt-1 text-meta text-ink-3">Local demo sign-in. Production SSO is not implemented.</p>
                </div>
                <M.Separator className="my-1 h-px bg-line" />
                {/* Called directly: a form inside a menu item is removed when the menu closes, before it can submit. */}
                <M.Item
                  disabled={signingOut}
                  onSelect={(e) => {
                    e.preventDefault();
                    startSignOut(async () => {
                      await logoutAction();
                    });
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-body text-ink outline-none data-[disabled]:cursor-default data-[disabled]:text-ink-3 data-[highlighted]:bg-surface-sunken"
                >
                  <LogOut aria-hidden="true" className="size-4" />
                  {signingOut ? "Signing out…" : "Sign out"}
                </M.Item>
              </M.Content>
            </M.Portal>
          </M.Root>
        </div>
      </header>

      {/* Off-canvas navigation below the wide breakpoint */}
      <D.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <D.Portal>
          <D.Overlay className="scrim anim-scrim fixed inset-0 z-50 lg:hidden" />
          <D.Content className="anim-nav fixed inset-y-0 left-0 z-[51] flex w-[min(300px,85vw)] flex-col bg-surface shadow-[var(--shadow-overlay)] outline-none lg:hidden">
            <D.Title className="sr-only">Navigation</D.Title>
            <D.Description className="sr-only">Main destinations</D.Description>
            <div className="flex h-16 items-center justify-between border-b border-line pl-4 pr-2">
              <Brand stationName={user.stationName} />
              <D.Close aria-label="Close navigation" className="inline-flex size-11 items-center justify-center rounded-[var(--radius-control)] text-ink-2 hover:bg-surface-sunken">
                <X aria-hidden="true" className="size-5" />
              </D.Close>
            </div>
            <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
              <NavLinks items={items} onNavigate={() => setMobileOpen(false)} />
            </nav>
          </D.Content>
        </D.Portal>
      </D.Root>

      <div className="flex">
        {/* Inside a case, the case sidebar takes this place on wide screens. */}
        {!inCase ? (
          <aside aria-label="Main navigation" className="no-print sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 flex-col border-r border-line bg-surface lg:flex">
            <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
              <NavLinks items={items} />
            </nav>
          </aside>
        ) : null}
        <main id="main" tabIndex={-1} className="flex min-h-[calc(100dvh-4rem)] min-w-0 flex-1 flex-col outline-none">
          <div className="flex-1">{children}</div>
          <footer className="no-print border-t border-line">
            <div className="mx-auto flex w-full max-w-[1440px] flex-wrap justify-between gap-x-6 gap-y-1 px-4 py-4 text-meta text-ink-3 sm:px-6 lg:px-8">
              <span>Synthetic demonstration data only. No real evidence, legal authority or dispatch.</span>
              <span>Every draft and proposal needs officer review.</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
