"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { MailWindow, type MailHandle } from "./mail-window";

/**
 * "New mail" on a case: a mail the officer writes themselves, to any address, with the case's files attached. It is
 * kept as one of the case's requests (with its own reference, added to the end of the subject), so the reply is
 * linked to it like any other. Nothing is kept until something is typed; closing the window keeps what was written.
 */
export function NewMailButton({ caseId, scope = "scr-main", primary = false }: { caseId: string; scope?: string; primary?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const handle = useRef<MailHandle | null>(null);
  const close = async () => {
    if (closing) return;
    setClosing(true);
    try {
      await handle.current?.close();
    } finally {
      setOpen(false);
      setClosing(false);
      router.refresh();
    }
  };
  return (
    <>
      <button className={`btn${primary ? " primary" : ""}`} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Write a mail yourself, to any address, from the linked mail account">
        <Icon name="mail" size={16} /> New mail
      </button>
      <DesignModal open={open} onClose={() => void close()} scope={scope} maxWidth={880} title="New mail">
        {open ? (
          <MailWindow
            requestId={null}
            caseId={caseId}
            handle={handle}
            onSent={() => router.refresh()}
            onDiscarded={() => {
              setOpen(false);
              router.refresh();
            }}
            head={(v) => (
              <div style={{ padding: "24px 68px 20px 28px", display: "flex", flexDirection: "column", gap: 8, borderBottom: `1px solid ${C.line}` }}>
                <span className="lbl">{v?.reference ? `New mail · ${v.reference}` : "New mail"}</span>
                <ModalTitle style={{ fontSize: 20 }}>{v?.sent ? "Mail sent" : "Write a mail"}</ModalTitle>
                <p className="sec" style={{ margin: 0, fontSize: 14 }}>
                  {v ? `For ${v.caseRef}. Saved as you type, as one of the case's requests; a reply that answers it in Gmail, or quotes its reference, is linked to it.` : "Preparing the mail…"}
                </p>
              </div>
            )}
          />
        ) : null}
      </DesignModal>
    </>
  );
}
