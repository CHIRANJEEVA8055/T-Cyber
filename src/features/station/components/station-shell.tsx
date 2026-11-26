"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useState, useTransition, type ReactNode } from "react";
import { DropdownMenu as M } from "radix-ui";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { HistoryButtons } from "@/components/design/history";
import { setPreference, THEME_COOKIE, LANG_COOKIE } from "@/lib/preferences";
import { logoutAction } from "@/features/auth/actions";

export interface ShellUser {
  name: string;
  initials: string;
  roleLabel: string;
  isSupervisor: boolean;
  /** The developer account keeps the knowledge base and has no station or case screens. */
  isDeveloper?: boolean;
}

/**
 * The station's app bar (design: Dashboard artboard): brand, Dashboard / Procedure assistant tabs, back and
 * forward, Telugu labels, theme, and the officer's menu (settings, search, sign out).
 */
const DEV_TABS = [
  { href: "/developer/knowledge", label: "Knowledge", icon: "book" as const },
  { href: "/developer/templates", label: "Questions", icon: "chat" as const },
  { href: "/developer/audit", label: "Audit", icon: "clock" as const },
  { href: "/assistant", label: "Assistant", icon: "bookOpen" as const },
];

export function StationShell({
  user,
  station,
  openCases,
  lang,
  theme,
  children,
}: {
  user: ShellUser;
  station: { name: string; district: string };
  openCases: number;
  lang: "en" | "te";
  theme: "dark" | "light";
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [, start] = useTransition();
  const [themeNow, setThemeNow] = useState(theme);
  const onPa = pathname.startsWith("/assistant");
  const onHome = pathname === "/";
  const langLabel = lang === "te" ? "Switch the labels back to English" : "తెలుగు లేబుల్స్‌కు మారండి (switch the labels to Telugu)";

  const toggleTheme = () => {
    const next = themeNow === "light" ? "dark" : "light";
    setPreference(THEME_COOKIE, next);
    document.documentElement.classList.toggle("light", next === "light");
    setThemeNow(next);
  };
  const toggleLang = () => {
    setPreference(LANG_COOKIE, lang === "te" ? "en" : "te");
    router.refresh();
  };
  return (
    <div className="pageroot scr-dashboard" style={{ display: "flex", flexDirection: "column", minHeight: "100vh", position: "relative" }}>
      <a href="#content" className="skip">
        Skip to the content
      </a>
      <main className="main">
        <header className={`appbar${onPa ? "" : " centred"}`} aria-label={user.isDeveloper ? "Developer console" : "Station"}>
          <Link className="brand" href="/" title="Station dashboard">
            <img src="/brand/TG_POLICE.png" alt="" style={{ height: 40, width: "auto", flex: "none" }} />
            <span>
              <span className="bn">T-CYBER</span>
              <span className="bs">
                {station.name} · {station.district}
              </span>
            </span>
          </Link>
          <nav className="tabsbar" aria-label="Station">
            {user.isDeveloper ? (
              DEV_TABS.map((t) => {
                const on = pathname.startsWith(t.href);
                return (
                  <Link key={t.href} className={`navitem${on ? " on" : ""}`} href={t.href} aria-current={on ? "page" : undefined}>
                    <Icon name={t.icon} strokeWidth={1.75} />
                    <span className="tl">{t.label}</span>
                  </Link>
                );
              })
            ) : (
              <>
                <Link className={`navitem${onPa ? "" : " on"}`} href="/" aria-current={onPa ? undefined : "page"}>
                  <Icon name="home" strokeWidth={1.75} />
                  <span className="tl">Dashboard</span>
                  <span className="num cnt">{openCases}</span>
                </Link>
                <Link className={`navitem${onPa ? " on" : ""}`} href="/assistant" aria-current={onPa ? "page" : undefined}>
                  <Icon name="book" strokeWidth={1.75} />
                  <span className="tl">Procedure Assistant</span>
                </Link>
              </>
            )}
          </nav>
          <div className="right">
            <div className="navctl hidenarrow" aria-label="Back and forward">
              <Suspense fallback={null}>
                <HistoryButtons />
              </Suspense>
            </div>
            {onHome && (
              <button className="histbtn langbtn" type="button" aria-label={langLabel} title={langLabel} onClick={toggleLang}>
                <Icon name="globe" />
                <span className="hidenarrow">{lang === "te" ? "English" : "తెలుగు"}</span>
              </button>
            )}
            <button className="histbtn" type="button" aria-label={themeNow === "light" ? "Switch to the dark theme" : "Switch to the light theme"} title={themeNow === "light" ? "Switch to the dark theme" : "Switch to the light theme"} onClick={toggleTheme}>
              <Icon name={themeNow === "light" ? "moon" : "sun"} />
            </button>
            <M.Root>
              <M.Trigger className="profile" aria-label={`${user.name}, ${user.roleLabel}: open the menu`} style={{ background: "none", border: 0, borderLeft: `1px solid ${C.line}`, color: "inherit", font: "inherit", cursor: "pointer", height: "100%" }}>
                <span className="avatar">{user.initials}</span>
                <span className="hidenarrow" style={{ textAlign: "left" }}>
                  <span className="pn">{user.name}</span>
                  <span className="pr">{user.roleLabel}</span>
                </span>
                <Icon name="chevronDown" size={16} style={{ color: C.mut }} className="hidenarrow" />
              </M.Trigger>
              <M.Portal>
                <div className="scr-dashboard">
                  <M.Content className="cmenu" align="end" sideOffset={6} style={{ position: "static" }}>
                    {user.isDeveloper ? null : (
                      <>
                        <M.Item asChild>
                          <button type="button" onClick={() => router.push("/settings")}>
                            <Icon name="shield" size={16} />
                            {user.isSupervisor ? "Station settings" : "Station settings (read only)"}
                          </button>
                        </M.Item>
                        <M.Item asChild>
                          <button type="button" onClick={() => router.push("/search")}>
                            <Icon name="search" size={16} />
                            Search records
                          </button>
                        </M.Item>
                      </>
                    )}
                    <M.Separator style={{ height: 1, background: C.line, margin: "4px 0" }} />
                    <M.Item asChild>
                      <button type="button" onClick={() => start(async () => void (await logoutAction()))}>
                        <Icon name="export" size={16} />
                        Sign out
                      </button>
                    </M.Item>
                  </M.Content>
                </div>
              </M.Portal>
            </M.Root>
          </div>
        </header>
        <div id="content" style={{ display: "contents" }}>
          {children}
        </div>
      </main>

    </div>
  );
}
