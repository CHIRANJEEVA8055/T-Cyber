"use client";

import { useRef, useState } from "react";
import { BadgeCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FormField, Textarea } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { DataTable } from "@/components/app/data-table";
import { StatusBadge, Tag } from "@/components/app/status-badge";
import { DateTime } from "@/components/app/datetime";
import { Address } from "@/components/app/address";
import { recipientRole } from "@/lib/recipients";
import { channelText, REQUEST_CATEGORY_LABELS } from "@/lib/labels";
import { useServerAction } from "@/features/shared/use-action";
import { setRecipientVerificationAction } from "@/features/settings/actions";
import type { DirectoryEntryView } from "@/server/services/settings";

function VerifyDialog({ target, onClose }: { target: { entry: DirectoryEntryView; verify: boolean } | null; onClose: () => void }) {
  const [note, setNote] = useState("");
  // Removing verification blocks submissions, so Cancel takes focus first in that case.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const save = useServerAction(setRecipientVerificationAction);
  const close = () => {
    setNote("");
    save.reset();
    onClose();
  };
  const e = target?.entry;
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !save.pending && close()}>
      {target && e ? (
        <DialogContent
          title={target.verify ? `Mark ${e.name} as verified?` : `Mark ${e.name} as not verified?`}
          description={
            <>
              Address on file: <Address value={e.address} />
            </>
          }
          initialFocusRef={target.verify ? undefined : cancelRef}
          footer={
            <>
              <Button ref={cancelRef} variant="secondary" onClick={close} disabled={save.pending}>
                Cancel
              </Button>
              <Button
                variant={target.verify ? "primary" : "danger"}
                loading={save.pending}
                onClick={() => save.run([e.id, target.verify, note], { success: target.verify ? "Recipient marked as verified" : "Recipient marked as not verified", onSuccess: close })}
              >
                {target.verify ? "Mark as verified" : "Mark as not verified"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <InlineAlert tone={target.verify ? "info" : "warning"}>
              {target.verify
                ? "Requests to this address can be submitted once it is verified. Confirm it against an official, current source; the demonstration addresses are synthetic."
                : "Requests to this recipient cannot be submitted until it is verified again."}
            </InlineAlert>
            {save.error && !save.fieldErrors.note ? <InlineAlert tone="danger">{save.error}</InlineAlert> : null}
            <FormField label={target.verify ? "How the address was checked" : "Why it is no longer verified"} required error={save.fieldErrors.note} hint="Recorded with your name in the settings history." validate={(v) => (v.trim().length < 10 ? "Say how the address was checked, in at least 10 characters." : null)}>
              <Textarea rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={300} />
            </FormField>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function DirectoryView({ entries, canManage, gmail = null }: { entries: DirectoryEntryView[]; canManage: boolean; gmail?: { on: boolean; connected: boolean; account: string | null } | null }) {
  const [target, setTarget] = useState<{ entry: DirectoryEntryView; verify: boolean } | null>(null);
  const action = (e: DirectoryEntryView, className?: string) =>
    !canManage || !e.active ? null : e.verificationStatus === "VERIFIED" ? (
      <Button size="sm" variant="ghost" className={className} icon={<ShieldOff aria-hidden="true" />} onClick={() => setTarget({ entry: e, verify: false })}>
        Mark as not verified
      </Button>
    ) : (
      <Button size="sm" variant="secondary" className={className} icon={<BadgeCheck aria-hidden="true" />} onClick={() => setTarget({ entry: e, verify: true })}>
        Mark as verified
      </Button>
    );
  const verification = (e: DirectoryEntryView) => (
    <div className="flex flex-col gap-1">
      <StatusBadge kind="verification" value={e.verificationStatus} className="self-start" />
      {e.verificationNote ? <span className="text-label text-ink-2">{e.verificationNote}</span> : null}
      {e.verifiedAt ? (
        <span className="text-label text-ink-3">
          {e.verifiedBy ? `${e.verifiedBy}, ` : ""}
          <DateTime iso={e.verifiedAt} />
        </span>
      ) : null}
    </div>
  );
  return (
    <>
      <DataTable<DirectoryEntryView>
        caption="Recipient directory"
        rows={entries}
        rowKey={(e) => e.id}
        minWidth={900}
        cardBelow="lg"
        rowClassName={(e) => (e.active ? undefined : "opacity-60")}
        columns={[
          {
            key: "who",
            header: "Recipient",
            cell: (e) => (
              <div className="min-w-0">
                <p className="font-medium text-ink">{e.organisation}</p>
                <p className="text-label text-ink-2">{recipientRole(e.organisation, e.name)}</p>
                {!e.active ? <Tag className="mt-1">Removed from the configuration file</Tag> : null}
              </div>
            ),
          },
          {
            key: "route",
            header: "Channel and address",
            cell: (e) => (
              <div className="min-w-0">
                <p className="text-label text-ink-2">{channelText(e.channel, gmail)}</p>
                <p className="text-label text-ink">
                  <Address value={e.address} />
                </p>
                {e.ifscPrefix ? <p className="text-label text-ink-3">IFSC prefix {e.ifscPrefix}</p> : null}
              </div>
            ),
          },
          { key: "for", header: "Used for", cell: (e) => <span className="text-label text-ink-2">{e.categories.map((c) => REQUEST_CATEGORY_LABELS[c] ?? c).join(", ") || "Not set"}</span> },
          { key: "verified", header: "Verification", cell: verification },
          { key: "actions", header: <span className="sr-only">Actions</span>, cell: (e) => action(e) },
        ]}
        mobileCard={(e) => (
          <div className="flex flex-col gap-2">
            <div>
              <p className="text-body font-medium text-ink">{e.organisation}</p>
              <p className="text-label text-ink-2">{recipientRole(e.organisation, e.name)}</p>
              {!e.active ? <Tag className="mt-1">Removed from the configuration file</Tag> : null}
            </div>
            <div>
              <p className="text-label text-ink-2">{channelText(e.channel, gmail)}</p>
              <p className="text-label text-ink">
                <Address value={e.address} />
              </p>
            </div>
            {verification(e)}
            {action(e, "self-start")}
          </div>
        )}
      />
      <VerifyDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
