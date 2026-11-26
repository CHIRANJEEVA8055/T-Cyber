import type { Metadata } from "next";
import { requireUser } from "@/server/auth/current-user";
import { getDb } from "@/server/db";
import { listIntegrations } from "@/server/services/settings";
import { canManageDirectory } from "@/domain/permissions";
import { PageBody, PageHeader } from "@/components/app/page";
import { InlineAlert } from "@/components/ui/feedback";
import { IntegrationsView } from "@/features/settings/components/integrations-view";
import { localModelStatus } from "@/server/ai/local-model";
import { deliverySettings } from "@/server/config";
import { smtpFromEnv } from "@/server/mail/smtp";
import { gmailStatus } from "@/server/gmail/oauth";
import { gmailRunnerState } from "@/server/gmail/runner";
import { GmailConnect } from "@/features/settings/components/gmail-connect";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  const user = await requireUser();
  const [items, model] = await Promise.all([listIntegrations(getDb(), user), localModelStatus()]);
  const delivery = deliverySettings();
  const smtp = smtpFromEnv();
  const canManage = canManageDirectory(user);
  const gmail = gmailStatus();
  const runner = gmailRunnerState();
  return (
    <PageBody>
      <PageHeader title="Integrations" description="How this build reaches banks, telecom routes, NPCI, provider portals and the assistant. No bank, telecom or provider system is connected." />
      <section className="panel mt-6 p-5" aria-labelledby="delivery-h">
        <h2 id="delivery-h" className="text-section font-semibold text-ink">
          How Approved Requests Leave the Station
        </h2>
        {delivery.mode === "gmail" ? (
          <p className="mt-1 text-body text-ink-2">
            From the linked Gmail account (prototype): every request draft is also kept in that account’s Drafts, edits made in T-CYBER or in Gmail are copied to the other, and an approved request is sent from that account to the address the officer types. Nothing is sent without approval.
          </p>
        ) : delivery.mode === "via-io" ? (
          <p className="mt-1 text-body text-ink-2">
            Through the investigating officer (version 1): each approved request is mailed to <span className="font-medium text-ink">{delivery.ioMailbox}</span> ({delivery.ioName}), and the IO forwards it to the nodal officer from their own mailbox, then marks it as forwarded. Nothing is sent to a bank or provider by T-CYBER.
          </p>
        ) : (
          <p className="mt-1 text-body text-ink-2">Straight to the nodal officer, through the channels below.</p>
        )}
        {delivery.mode === "via-io" ? (
        <p className="mt-3 text-body">
          <span className={`mr-2 inline-block rounded-full px-2.5 py-0.5 text-label font-medium ${delivery.transport === "smtp" && smtp.ok ? "bg-success-tint text-success" : "bg-warning-tint text-warning"}`}>{delivery.transport === "simulated" ? "Simulated" : smtp.ok ? "Mail server set" : "Mail server missing"}</span>
          {delivery.transport === "simulated"
            ? "The mail to the IO is kept in T-CYBER (nothing leaves this server). The IO opens it from the request: open it in the mail app, copy it, or download it as an email file."
            : smtp.ok
              ? `Mailed through ${smtp.settings.host}:${smtp.settings.port} (${smtp.settings.secure}). The login is read from the environment, never shown here.`
              : `${smtp.error} Until it is set, mailing to the IO fails and says why.`}
        </p>
        ) : null}
        <p className="mt-2 text-label text-ink-3">Set in config/t-cyber.config.json under “delivery” (mode: gmail, via-io or direct).</p>
      </section>
      <section className="panel mt-6 p-5" aria-labelledby="gmail-h">
        <h2 id="gmail-h" className="text-section font-semibold text-ink">
          Gmail
        </h2>
        <p className="mt-1 text-body text-ink-2">
          Prototype link to {gmail.account ?? "one Gmail account"}. T-CYBER asks Google to manage drafts and send them{gmail.readReplies ? ", and to read the inbox for replies to requests: a reply is linked to its request and read into the case; mail that is not about a case is skipped and never stored" : "; it does not read the mailbox"}. Case text in these drafts is stored in that Google account.
        </p>
        <p className="mt-3 text-body">
          <span className={`mr-2 inline-block rounded-full px-2.5 py-0.5 text-label font-medium ${gmail.enabled && gmail.connected ? "bg-success-tint text-success" : "bg-warning-tint text-warning"}`}>{!gmail.enabled ? "Switched off" : gmail.connected ? "Connected" : "Not connected"}</span>
          {gmail.note}
          {gmail.enabled && gmail.connected && runner.last ? ` Last check ${new Date(runner.last.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}: ${runner.last.result}.` : ""}
        </p>
        {gmail.enabled && gmail.connected && gmail.readReplies ? (
          <p className="mt-2 text-body">
            <span className={`mr-2 inline-block rounded-full px-2.5 py-0.5 text-label font-medium ${gmail.canRead ? "bg-success-tint text-success" : "bg-warning-tint text-warning"}`}>{gmail.canRead ? "Reading replies" : gmail.canRead === null ? "Checking permission" : "Needs the read permission"}</span>
            {gmail.canRead === false
              ? "This link was made with permission to manage drafts only. To have replies read and linked to their requests, connect again below and allow T-CYBER to read the mailbox."
              : runner.replies
                ? `Last looked ${new Date(runner.replies.at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}: ${runner.replies.note ?? runner.replies.result}.`
                : "Replies are looked for with every Gmail check."}
          </p>
        ) : null}
        {gmail.enabled && gmail.clientFile ? <GmailConnect connected={gmail.connected} canManage={canManage} needsRead={gmail.connected && gmail.readReplies && gmail.canRead === false} /> : null}
        <p className="mt-2 text-label text-ink-3">Set in config/t-cyber.config.json under “gmail” (enabled, account, credentialsFile, tokenFile, syncSeconds, senderApproves, readReplies). The client file and the token stay in data/secrets and are never shown.</p>
      </section>
      <section className="panel mt-6 p-5" aria-labelledby="model-h">
        <h2 id="model-h" className="text-section font-semibold text-ink">
          Local Model
        </h2>
        <p className="mt-1 text-body text-ink-2">
          Rules do everything they can. The local model ({model.model} through Ollama at {model.host.replace(/^https?:\/\//, "")}, loopback only) reads scanned FIR pages, translates Telugu and Hindi copies, and answers assistant questions the rules cannot place. Case documents are never sent to a remote model.
        </p>
        <p className="mt-3 text-body">
          <span className={`mr-2 inline-block rounded-full px-2.5 py-0.5 text-label font-medium ${model.reachable && model.hasModel ? "bg-success-tint text-success" : "bg-warning-tint text-warning"}`}>{model.reachable && model.hasModel ? "Ready" : model.reachable ? "Model not installed" : "Not running"}</span>
          {model.note}
        </p>
      </section>
      {!canManage ? (
        <InlineAlert tone="info" className="mt-6">
          You can read the integration status. Only a supervisor can rehearse a failed submission.
        </InlineAlert>
      ) : null}
      <div className="mt-4">
        <IntegrationsView items={items} canManage={canManage} />
      </div>
    </PageBody>
  );
}
