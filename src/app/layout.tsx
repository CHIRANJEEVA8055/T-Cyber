import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "@/components/ui/feedback";
import { THEME_COOKIE } from "@/lib/preferences";
import { UiNotes } from "@/features/dev/ui-notes";

export const metadata: Metadata = {
  title: { default: "T-CYBER", template: "%s – T-CYBER" },
  description: "Cybercrime investigation workspace (local demonstration build with simulated external integrations).",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#09090b",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Dark is the default; the officer's choice is kept in a cookie so the server renders the right theme.
  const light = (await cookies()).get(THEME_COOKIE)?.value === "light";
  return (
    <html lang="en-IN" className={light ? "light" : undefined}>
      <body>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
        {/* Comment mode for UI notes: development builds only (and only for signed-in users). */}
        {process.env.NODE_ENV === "development" || process.env.T_CYBER_UI_NOTES === "1" ? <UiNotes /> : null}
      </body>
    </html>
  );
}
