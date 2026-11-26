import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { getSettingsOverview } from "@/server/services/settings";
import { DefinitionList, PageBody, PageHeader, Panel } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { DateTime } from "@/components/app/datetime";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsOverviewPage() {
  const user = await requireUser();
  const s = await getSettingsOverview(getDb(), user);
  return (
    <PageBody>
      <PageHeader
        title="Settings"
        description="Station details, the recipient directory and the mailbox come from the configuration file; changes to it apply without a restart. Verification, routes, templates and integration tests are managed here by a supervisor."
      />
      {!s.canManage ? (
        <InlineAlert tone="info" className="mt-6">
          You can read these settings. Only a supervisor can change them.
        </InlineAlert>
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
          <Panel title="Configuration File" description="The single place for station details, the mailbox, request numbering and the recipient directory.">
            {s.config.ok ? (
              <InlineAlert tone="success" title="Loaded">
                <span className="font-mono">{s.config.file}</span>
                {s.config.lastValidChangeAt ? (
                  <>
                    , last changed <DateTime iso={s.config.lastValidChangeAt} />
                  </>
                ) : null}
                .
              </InlineAlert>
            ) : (
              <InlineAlert tone="danger" title="The configuration file has an error">
                <p>The last valid configuration is still in use. Fix the file; the change applies as soon as it is saved.</p>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-label text-ink">{s.config.error}</pre>
              </InlineAlert>
            )}
          </Panel>
          <Panel title="Station">
            <DefinitionList
              items={[
                { term: "Name", value: s.station.name },
                { term: "Code", value: <span className="font-mono">{s.station.code}</span> },
                { term: "District", value: s.station.district },
                { term: "Phone", value: s.station.phone },
                { term: "Email", value: s.station.email },
                { term: "Address", value: s.station.address, wide: true },
              ]}
            />
          </Panel>
          <Panel title="Mailbox and Requests" description="Used as the sender of every request and in each request's signature.">
            <DefinitionList
              items={[
                { term: "Sent from", value: <span className="break-all font-mono">{s.mailbox.fromAddress}</span> },
                { term: "Display name", value: s.mailbox.displayName },
                { term: "Request numbering", value: `${s.requests.referencePrefix}-<FIR no.>/<year>-<NNN>, replies RES-…; reminders add -R1, -R2` },
                { term: "Default follow-up", value: `${s.requests.defaultFollowUpDays} days, where a route does not set its own` },
                { term: "Signature", value: <span className="whitespace-pre-line">{s.mailbox.signature.join("\n")}</span>, wide: true },
              ]}
            />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-4">
          <Panel title="At a Glance" bodyClassName="p-0">
            <ul className="divide-y divide-line text-body">
              {[
                { href: "/settings/directory", label: "Recipients", value: `${s.counts.recipients}${s.counts.unverified ? `, ${s.counts.unverified} not verified` : ""}` },
                { href: "/settings/routes", label: "Routes", value: String(s.counts.routes) },
                { href: "/settings/templates", label: "Templates", value: String(s.counts.templates) },
                { href: "/settings/knowledge", label: "Knowledge documents", value: String(s.counts.documents) },
              ].map((x) => (
                <li key={x.href}>
                  <Link href={x.href} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-muted">
                    <span className="font-medium text-action">{x.label}</span>
                    <span className="tabular-nums text-ink-2">{x.value}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Recent Changes" description="Changes to settings and to the configuration file." bodyClassName="p-0">
            {s.history.length ? (
              <ol className="divide-y divide-line">
                {s.history.map((h) => (
                  <li key={h.id} className="px-5 py-3">
                    <p className="text-body text-ink">{h.summary}</p>
                    <p className="text-label text-ink-3">
                      {h.actor}, <DateTime iso={h.at} />
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="px-5 py-4 text-body text-ink-2">No settings have been changed yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </PageBody>
  );
}
