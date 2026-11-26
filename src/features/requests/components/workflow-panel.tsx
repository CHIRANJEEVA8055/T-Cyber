"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Send, ShieldCheck, Undo2, Upload, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/dialog";
import { FormField, Input, Textarea } from "@/components/ui/field";
import { InlineAlert, useToast } from "@/components/ui/feedback";
import { DateTime } from "@/components/app/datetime";
import { channelText } from "@/lib/labels";
import { useServerAction } from "@/features/shared/use-action";
import {
  approveRequestAction,
  markDraftReviewedAction,
  recordPortalSubmissionAction,
  requestApprovalAction,
  returnForChangesAction,
  submitRequestAction,
  mailToIoAction,
  recordForwardedAction,
} from "@/features/requests/actions";
import { sendFromGmailAction } from "@/features/case/actions";
import { GmailStatus } from "./gmail-status";
import type { RequestDetail } from "@/server/services/correspondence";
import { copyText, newId } from "@/lib/browser";

const newKey = newId;

export function WorkflowPanel({ d, userRole }: { d: RequestDetail; userRole: "OFFICER" | "SUPERVISOR" | "DEVELOPER" }) {
  const [dialog, setDialog] = useState<null | "approval" | "approve" | "return" | "submit" | "portal" | "reviewed" | "mailio" | "forwarded" | "gmail">(null);
  const [fwdAt, setFwdAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState("");
  const [portalRef, setPortalRef] = useState("");
  const [showBlockers, setShowBlockers] = useState(false);
  const idempotencyKey = useRef(newKey());
  const toast = useToast();
  const reqApproval = useServerAction(requestApprovalAction);
  const approve = useServerAction(approveRequestAction);
  const ret = useServerAction(returnForChangesAction);
  const submit = useServerAction(submitRequestAction);
  const portal = useServerAction(recordPortalSubmissionAction);
  const reviewed = useServerAction(markDraftReviewedAction);
  const mailIo = useServerAction(mailToIoAction);
  const forwarded = useServerAction(recordForwardedAction);
  // v1 delivery: approved requests are mailed to the PS IO's mailbox and the IO forwards them.
  const viaIo = d.delivery.viaIo;
  // Gmail (prototype): sent from the linked Gmail account to the address the officer types.
  const viaGmail = d.gmail.on;
  const [gmailTo, setGmailTo] = useState(d.gmail.to);
  const sendGmail = useServerAction(sendFromGmailAction);
  const close = () => {
    setDialog(null);
    setNote("");
    setPortalRef("");
    setFwdAt("");
  };
  // With Gmail the officer types the address, so the directory entry's verification is not a blocker.
  const blockers = d.readinessReasons.filter((r) => !/Confirm the final submission check/.test(r) && !(viaGmail && /not verified in the directory|demonstration directory entry/.test(r)));
  const hash = d.contentHash.slice(0, 12);
  const isPortal = d.channel === "PORTAL";
  const sentStatuses = ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE", "REJECTED"];

  let body: React.ReactNode = null;
  if (d.status === "DRAFT") {
    body = (
      <>
        <p className="text-body text-ink-2">
          Next step: send version {d.currentVersionNo} for approval{d.route ? ` by a ${d.route.approvalRole === "SUPERVISOR" ? "supervisor" : "officer"}` : ""}. Approval applies to this exact version.
        </p>
        <Button variant="primary" className="w-full" icon={<ShieldCheck aria-hidden="true" />} onClick={() => setDialog("approval")}>
          Request approval
        </Button>
      </>
    );
  } else if (d.status === "AWAITING_APPROVAL") {
    body = d.canApprove ? (
      <>
        <p className="text-body text-ink-2">
          Version {d.currentVersionNo} by {d.current.author} is waiting for your approval. Content fingerprint <span className="font-mono text-label text-ink">{hash}</span>.
        </p>
        <Button variant="primary" className="w-full" icon={<BadgeCheck aria-hidden="true" />} onClick={() => setDialog("approve")}>
          Approve version {d.currentVersionNo}
        </Button>
        <Button variant="secondary" className="w-full" icon={<Undo2 aria-hidden="true" />} onClick={() => setDialog("return")}>
          Return for changes
        </Button>
      </>
    ) : (
      <InlineAlert tone="info" title={`Waiting for approval of version ${d.currentVersionNo}`}>
        {userRole === "SUPERVISOR" && d.isAuthor ? "You prepared this version, so another supervisor must approve it." : "A supervisor must approve this exact version before it can be submitted."}
      </InlineAlert>
    );
  } else if ((d.status === "APPROVED" || d.status === "SUBMISSION_FAILED") && viaGmail) {
    body = (
      <>
        {d.lastFailure ? (
          <InlineAlert tone="danger" title="The last send from Gmail failed">
            {d.lastFailure.error}
          </InlineAlert>
        ) : null}
        <p className="text-body text-ink-2">
          Version {d.approvedVersionNo} approved{d.activeApproval ? ` by ${d.activeApproval.by}` : ""}. Type the address and it is sent from {d.gmail.account ?? "the linked Gmail account"}.
        </p>
        <FormField label="Send to" hint="Several addresses: separate them with commas.">
          <Input type="text" inputMode="email" autoComplete="off" value={gmailTo} onChange={(e) => setGmailTo(e.target.value)} placeholder="nodal.officer@bank.in" />
        </FormField>
        {showBlockers && blockers.length ? (
          <InlineAlert tone="warning" title="It cannot go yet" role="alert">
            <ul className="list-disc pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
        <Button variant="primary" className="w-full" icon={<Send aria-hidden="true" />} disabled={!gmailTo.trim() || !d.gmail.connected} onClick={() => (blockers.length ? setShowBlockers(true) : setDialog("gmail"))}>
          {d.status === "SUBMISSION_FAILED" ? "Send from Gmail again" : "Send from Gmail"}
        </Button>
      </>
    );
  } else if ((d.status === "APPROVED" || d.status === "SUBMISSION_FAILED") && viaIo) {
    body = (
      <>
        {d.lastFailure ? (
          <InlineAlert tone="danger" title="The mail to the IO failed">
            {d.lastFailure.error}
          </InlineAlert>
        ) : null}
        <p className="text-body text-ink-2">
          {d.delivery.handedOverAt ? (
            <>
              Mailed to {d.delivery.handedOverTo} <DateTime iso={d.delivery.handedOverAt} />. Forward it to {d.recipient.organisation} ({d.recipient.address}) from your mailbox, then mark it as forwarded.
            </>
          ) : (
            <>
              Version {d.approvedVersionNo} approved{d.activeApproval ? ` by ${d.activeApproval.by}` : ""}. Mail it to the IO mailbox ({d.delivery.ioMailbox}) to forward, or send it from your mail program; then mark it as forwarded.
            </>
          )}
        </p>
        {showBlockers && blockers.length ? (
          <InlineAlert tone="warning" title="It cannot go yet" role="alert">
            <ul className="list-disc pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
        <Button variant={d.delivery.handedOverAt ? "secondary" : "primary"} className="w-full" icon={<Send aria-hidden="true" />} onClick={() => (blockers.length ? setShowBlockers(true) : setDialog("mailio"))}>
          {d.delivery.handedOverAt ? "Mail to the IO again" : "Mail to the IO"}
        </Button>
        <Button variant={d.delivery.handedOverAt ? "primary" : "secondary"} className="w-full" icon={<BadgeCheck aria-hidden="true" />} onClick={() => (blockers.length ? setShowBlockers(true) : setDialog("forwarded"))}>
          Mark as forwarded
        </Button>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-label">
          <a className="font-medium text-action hover:underline" href={`mailto:${encodeURIComponent(d.recipient.address)}?subject=${encodeURIComponent(d.current.subject)}&body=${encodeURIComponent(d.current.body)}`}>
            Open in mail app
          </a>
          <button type="button" className="font-medium text-action hover:underline" onClick={async () => setCopied(await copyText(`To: ${d.recipient.address}\nSubject: ${d.current.subject}\n\n${d.current.body}`))}>
            {copied ? "Copied" : "Copy the draft"}
          </button>
          <a className="font-medium text-action hover:underline" href={`/api/requests/${d.id}/eml`} download>
            Email file (.eml)
          </a>
        </div>
      </>
    );
  } else if (d.status === "APPROVED" || d.status === "SUBMISSION_FAILED") {
    body = (
      <>
        {d.lastFailure ? (
          <InlineAlert tone="danger" title="The last simulated submission failed">
            {d.lastFailure.error}
          </InlineAlert>
        ) : null}
        <p className="text-body text-ink-2">
          Version {d.approvedVersionNo} approved{d.activeApproval ? ` by ${d.activeApproval.by}` : ""}. {isPortal ? "Submit it on the provider portal, then record the portal's reference." : "Submitting uses a simulation adapter: nothing leaves this computer."}
        </p>
        {showBlockers && blockers.length ? (
          <InlineAlert tone="warning" title="Submission is blocked" role="alert">
            <ul className="list-disc pl-4">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </InlineAlert>
        ) : null}
        <Button
          variant="primary"
          className="w-full"
          icon={isPortal ? <Upload aria-hidden="true" /> : <Send aria-hidden="true" />}
          onClick={() => {
            if (blockers.length) setShowBlockers(true);
            else setDialog(isPortal ? "portal" : "submit");
          }}
        >
          {isPortal ? "Record portal submission" : d.status === "SUBMISSION_FAILED" ? "Retry submission" : "Submit request"}
        </Button>
      </>
    );
  } else if (["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE"].includes(d.status)) {
    body = (
      <>
        <p className="text-body text-ink-2">
          Sent <DateTime iso={d.submittedAt} />.{d.externalReference ? <> Reference <span className="font-mono text-label text-ink">{d.externalReference}</span>.</> : null}
          {d.followUpAt ? (
            <>
              {" "}
              Follow up from <DateTime iso={d.followUpAt} mode="date" /> (station setting, not a legal deadline).
            </>
          ) : null}
        </p>
        <Button asChild variant="secondary" className="w-full">
          <Link href={`/cases/${d.caseId}/requests?inbox=1&from=file&requestId=${d.id}`}>
            <Upload aria-hidden="true" />
            Import a response
          </Link>
        </Button>
      </>
    );
  } else if (sentStatuses.includes(d.status)) {
    body = <p className="text-body text-ink-2">{d.status === "REJECTED" ? "The recipient rejected this request. Prepare a new request if another route applies." : "All requested items are answered. The request is closed."}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {d.needsReview && !sentStatuses.includes(d.status) ? (
        <InlineAlert
          tone="warning"
          title="Source information changed"
          action={
            <Button size="sm" variant="secondary" onClick={() => setDialog("reviewed")}>
              Mark as reviewed
            </Button>
          }
        >
          {d.needsReviewReason} Check the draft before it is submitted.
        </InlineAlert>
      ) : null}
      {d.recipient.unaddressed && !sentStatuses.includes(d.status) ? (
        <InlineAlert tone="warning" title="No addressee yet">
          This draft is for {d.recipient.unaddressed}, which is not known yet. Edit and print it as it is; it is approved and sent once the missing detail is recorded and the draft is addressed from Next actions, which also says how to find it.
        </InlineAlert>
      ) : !viaGmail && d.recipient.verificationStatus !== "VERIFIED" && !sentStatuses.includes(d.status) ? (
        <InlineAlert tone="warning" title="Recipient not verified">
          {d.recipient.verificationNote ?? "This directory entry has not been verified."} Submission stays blocked until a supervisor verifies it in Settings.
        </InlineAlert>
      ) : null}
      {body}
      <GmailStatus requestId={d.id} g={d.gmail} canWrite sent={sentStatuses.includes(d.status)} />
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-label text-ink-2">Letter for printing:</span>
        <a className="text-label font-medium text-action hover:underline" href={`/api/requests/${d.id}/letter?format=pdf`} download>
          Download PDF
        </a>
        <span aria-hidden="true" className="text-ink-3">·</span>
        <a className="text-label font-medium text-action hover:underline" href={`/api/requests/${d.id}/letter?format=docx`} download>
          Download Word
        </a>
        <span className="text-label text-ink-3">
          {["APPROVED", ...sentStatuses].includes(d.status)
            ? "On the station letterhead, as approved."
            : d.recipient.unaddressed
              ? "Marked DRAFT until the addressee is recorded."
              : d.recipient.verificationStatus !== "VERIFIED"
                ? "Marked DRAFT until the address is verified."
                : d.needsReview
                  ? "Marked DRAFT until it is checked."
                  : "Ready to print: the address is verified. Approval is needed only to send it from here."}
        </span>
      </div>

      <ConfirmationDialog
        open={dialog === "approval"}
        onOpenChange={(o) => !o && close()}
        title={`Send ${d.reference} for approval?`}
        description={`Version ${d.currentVersionNo} will be locked for review. If you edit it afterwards, the request returns to draft.`}
        confirmLabel="Request approval"
        onConfirm={async () => (await reqApproval.run([d.id, d.version], { success: "Sent for approval" })).ok}
      />
      <ConfirmationDialog
        open={dialog === "approve"}
        onOpenChange={(o) => !o && close()}
        title={`Approve version ${d.currentVersionNo} of ${d.reference}?`}
        description={`You approve this exact content (fingerprint ${hash}) for ${d.recipient.organisation}. Any later edit withdraws the approval.`}
        confirmLabel={`Approve version ${d.currentVersionNo}`}
        onConfirm={async () => (await approve.run([d.id, d.version, note], { success: "Request approved" })).ok}
      >
        <FormField label="Approval note" optionalLabel>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </ConfirmationDialog>
      <ConfirmationDialog
        open={dialog === "return"}
        onOpenChange={(o) => !o && close()}
        title={`Return ${d.reference} for changes?`}
        description="The request goes back to draft. Your note is shown to the officer and kept in the history."
        confirmLabel="Return for changes"
        onConfirm={async () => (await ret.run([d.id, d.version, note], { success: "Returned for changes" })).ok}
      >
        <FormField label="What needs to change" required error={ret.fieldErrors.note}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </ConfirmationDialog>
      <ConfirmationDialog
        open={dialog === "submit"}
        size="md"
        onOpenChange={(o) => !o && close()}
        title={`Submit ${d.reference} to ${d.recipient.organisation}?`}
        description="Final check before sending. This build uses a simulation adapter: no real email, bank, telecom or provider system is contacted."
        confirmLabel="Submit request"
        onConfirm={async () => {
          const r = await submit.run([d.id, d.version, idempotencyKey.current], { toastError: true });
          if (r.ok) {
            idempotencyKey.current = newKey();
            toast(
              r.data.outcome === "FAILED"
                ? { tone: "danger", message: "The simulated submission failed. Nothing was sent. The reason is shown on the request." }
                : { tone: "success", message: `Submitted through the simulation adapter. Reference ${r.data.externalReference}.` },
            );
          }
          return r.ok;
        }}
      >
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-body">
          <dt className="text-ink-3">Recipient</dt>
          <dd className="text-ink">
            {d.recipient.name}
            <span className="block text-label text-ink-2">{d.recipient.address}</span>
          </dd>
          <dt className="text-ink-3">Channel</dt>
          <dd className="text-ink">{channelText(d.channel, d.gmail)}</dd>
          <dt className="text-ink-3">Approved version</dt>
          <dd className="text-ink">
            Version {d.approvedVersionNo}
            {d.activeApproval ? `, approved by ${d.activeApproval.by}` : ""}
          </dd>
          <dt className="text-ink-3">Fingerprint</dt>
          <dd className="font-mono text-label text-ink">{hash}</dd>
          <dt className="text-ink-3">Requested items</dt>
          <dd className="text-ink">{d.items.length}</dd>
          <dt className="text-ink-3">Attachments</dt>
          <dd className="text-ink">{d.current.attachmentIds.length}</dd>
        </dl>
      </ConfirmationDialog>
      <ConfirmationDialog
        open={dialog === "gmail"}
        size="md"
        onOpenChange={(o) => !o && close()}
        title={`Send ${d.reference} from Gmail?`}
        description={`It goes from ${d.gmail.account ?? "the linked Gmail account"} to ${gmailTo.trim()}, exactly as approved (version ${d.approvedVersionNo}), with ${d.current.attachmentIds.length ? `${d.current.attachmentIds.length} attachment(s)` : "no attachments"}. This is logged.`}
        confirmLabel="Send from Gmail"
        onConfirm={async () => {
          const r = await sendGmail.run([d.id, d.version, null, gmailTo, idempotencyKey.current], { toastError: true });
          if (r.ok) {
            idempotencyKey.current = newKey();
            toast(r.data.outcome === "SUCCEEDED" ? { tone: "success", message: `Sent from Gmail to ${gmailTo.trim()}. It is in that account's Sent folder.` } : { tone: "danger", message: r.data.outcome === "FAILED" ? r.data.error : "It was not sent." });
          }
          return r.ok;
        }}
      />
      <ConfirmationDialog
        open={dialog === "mailio"}
        size="md"
        onOpenChange={(o) => !o && close()}
        title={`Mail ${d.reference} to the IO to forward?`}
        description={`It goes to ${d.delivery.ioMailbox}, with where to forward it (${d.recipient.address}) at the top. Nothing goes to ${d.recipient.organisation} until it is forwarded.`}
        confirmLabel="Mail to the IO"
        onConfirm={async () => {
          const r = await mailIo.run([d.id, d.version, idempotencyKey.current], { toastError: true });
          if (r.ok) {
            idempotencyKey.current = newKey();
            toast(r.data.outcome === "HANDED_OVER" ? { tone: "success", message: `Mailed to ${r.data.to}${r.data.transport === "SIMULATED" ? " (simulated: kept in T-CYBER)" : ""}. Forward it, then mark it as forwarded.` } : { tone: "danger", message: r.data.outcome === "FAILED" ? r.data.error : "It could not be mailed." });
          }
          return r.ok;
        }}
      />
      <ConfirmationDialog
        open={dialog === "forwarded"}
        onOpenChange={(o) => !o && close()}
        title={`Mark ${d.reference} as forwarded to ${d.recipient.organisation}?`}
        description={`Record that it was sent to ${d.recipient.address} from your mailbox. Its follow-up dates start from then.`}
        confirmLabel="Mark as forwarded"
        onConfirm={async () => (await forwarded.run([d.id, d.version, fwdAt || null, note || null], { success: "Recorded as forwarded" })).ok}
      >
        <div className="flex flex-col gap-3">
          <FormField label="Forwarded at" optionalLabel hint="Leave empty for now." error={forwarded.fieldErrors.forwardedAt}>
            <Input type="datetime-local" value={fwdAt} onChange={(e) => setFwdAt(e.target.value)} />
          </FormField>
          <FormField label="Note" optionalLabel hint="For example, the mailbox it was sent from.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
          </FormField>
        </div>
      </ConfirmationDialog>
      <ConfirmationDialog
        open={dialog === "portal"}
        onOpenChange={(o) => !o && close()}
        title={`Record portal submission of ${d.reference}?`}
        description={`Submit the approved version on ${d.recipient.address}, then enter the reference the portal shows. Nothing is submitted automatically.`}
        confirmLabel="Record submission"
        onConfirm={async () => (await portal.run([d.id, d.version, portalRef], { success: "Portal submission recorded" })).ok}
      >
        <FormField label="Portal reference" required error={portal.fieldErrors.portalReference}>
          <Input value={portalRef} onChange={(e) => setPortalRef(e.target.value)} autoComplete="off" />
        </FormField>
      </ConfirmationDialog>
      <ConfirmationDialog
        open={dialog === "reviewed"}
        onOpenChange={(o) => !o && close()}
        title={`Mark ${d.reference} as reviewed?`}
        description="Confirm that the draft is still accurate after the source change. Edit the draft instead if anything needs to change."
        confirmLabel="Mark as reviewed"
        onConfirm={async () => (await reviewed.run([d.id, d.version, note], { success: "Marked as reviewed" })).ok}
      >
        <FormField label="Review note" optionalLabel>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </ConfirmationDialog>
    </div>
  );
}
