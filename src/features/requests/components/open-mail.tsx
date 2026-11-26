"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { C } from "@/components/design/tokens";
import { DesignModal, ModalTitle } from "@/components/design/modal";
import { MailWindow, type MailHandle } from "./mail-window";

/** Opens a request in the mail window (every part editable in place, Preview and Send), from its own page. */
export function OpenMailButton({ requestId, label = "Open the mail" }: { requestId: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const handle = useRef<MailHandle | null>(null);
  const close = async () => {
    try {
      await handle.current?.close();
    } finally {
      setOpen(false);
      router.refresh();
    }
  };
  return (
    <>
      <button className="btn primary" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="mail" size={16} /> {label}
      </button>
      <DesignModal open={open} onClose={() => void close()} scope="scr-requests" maxWidth={880} title={label}>
        {open ? (
          <MailWindow
            requestId={requestId}
            handle={handle}
            onSent={() => router.refresh()}
            onDiscarded={() => {
              setOpen(false);
              router.refresh();
            }}
            head={(v) => (
              <div style={{ padding: "24px 68px 20px 28px", display: "flex", flexDirection: "column", gap: 8, borderBottom: `1px solid ${C.line}` }}>
                <span className="lbl">{v ? v.reference : "Mail"}</span>
                <ModalTitle style={{ fontSize: 20 }}>{v ? (v.sent ? `Sent to ${v.org}` : `Mail to ${v.org}`) : "Opening the mail…"}</ModalTitle>
                <p className="sec" style={{ margin: 0, fontSize: 14 }}>
                  {v?.editable ? "Every part is editable here and saved as you type. Preview shows it as it goes; Send checks every field first." : "As it was sent."}
                </p>
              </div>
            )}
          />
        ) : null}
      </DesignModal>
    </>
  );
}
