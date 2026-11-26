import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { InlineAlert } from "@/components/ui/feedback";
import { getCurrentUser } from "@/server/auth/current-user";
import { LoginForm } from "./login-form";
import { getDb } from "@/server/db";
import { getAppConfig } from "@/server/config";
import { ensureConfigApplied } from "@/server/services/config-sync";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  // Per request: keeps the configuration write and session lookup out of the build's prerendering.
  await connection();
  await ensureConfigApplied(getDb());
  if (await getCurrentUser()) redirect("/cases");
  const { next, reset } = await searchParams;
  const station = getAppConfig().station;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <img src="/brand/TG_POLICE.png" alt="" className="h-14 w-auto shrink-0" />
          <div>
            <p className="text-heading font-semibold tracking-tight text-ink">T-CYBER</p>
            <p className="text-label text-ink-2">{station.name}</p>
          </div>
        </div>
        {reset === "1" ? (
          <InlineAlert tone="info" title="Demonstration data reset" className="mb-4">
            All cases and records were reloaded from the synthetic demonstration, and everyone was signed out. Sign in again to continue.
          </InlineAlert>
        ) : null}
        <div className="panel-raised p-6">
          <h1 className="text-heading font-semibold tracking-tight text-ink">Sign In</h1>
          <p className="mt-1 text-body text-ink-2">For authorised officers. Activity is recorded.</p>
          <LoginForm next={next ?? ""} />
        </div>
        <section aria-labelledby="demo-accounts" className="mt-4 rounded-[var(--radius-panel)] border border-line bg-surface-muted p-4">
          <h2 id="demo-accounts" className="text-label font-semibold text-ink">
            Local Demonstration Accounts
          </h2>
          <p className="mt-1 text-label text-ink-2">
            All accounts use the password <span className="font-mono text-ink">tcyber-demo</span>. Production single sign-on is not implemented in this build.
          </p>
          <ul className="mt-3 space-y-1.5 text-label">
            <li className="flex justify-between gap-3"><span className="font-mono text-ink">officer1</span><span className="text-ink-2">SI Krishna, investigating officer (FIR 412/2026)</span></li>
            <li className="flex justify-between gap-3"><span className="font-mono text-ink">officer2</span><span className="text-ink-2">SI P. Lavanya, investigating officer</span></li>
            <li className="flex justify-between gap-3"><span className="font-mono text-ink">officer3</span><span className="text-ink-2">SI M. Arjun, investigating officer (FIR 377/2026)</span></li>
            <li className="flex justify-between gap-3"><span className="font-mono text-ink">supervisor</span><span className="text-ink-2">Inspector R. Devi, station supervisor</span></li>
            <li className="flex justify-between gap-3"><span className="font-mono text-ink">developer</span><span className="text-ink-2">Developer: knowledge base, ready questions, audit</span></li>
          </ul>
        </section>
      </div>
    </main>
  );
}
