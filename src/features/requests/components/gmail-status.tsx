"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resyncGmailAction } from "@/features/case/actions";
import type { GmailDraftView } from "@/server/gmail/view";

const time = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** One line on a draft: where its Gmail copy stands, with the one fix that applies. */
export function GmailStatus({ requestId, g, canWrite, sent }: { requestId: string; g: GmailDraftView; canWrite: boolean; sent: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (!g.on || sent) return null;
  const resync = () =>
    start(async () => {
      setMsg(null);
      const res = await resyncGmailAction(requestId);
      if (!res.ok) setMsg(res.error);
      else {
        setMsg(res.data.outcome === "pulled" ? "Brought in the edit made in Gmail." : res.data.outcome === "created" ? "Saved in Gmail's Drafts." : "Gmail and T-CYBER match.");
        router.refresh();
      }
    });
  const text = !g.connected || g.note
    ? `Gmail is not connected, so this draft is not in Gmail yet. ${g.note ?? ""}`
    : g.missing
      ? `This draft is no longer in Gmail's Drafts (sent or deleted there).`
      : g.error
        ? `Could not update the Gmail draft: ${g.error}`
        : g.inGmail
          ? `In the Drafts of ${g.account}${g.syncedAt ? `, checked ${time(g.syncedAt)}` : ""}. Edits in either place are copied to the other.`
          : g.beforeLink
            ? `Not in Gmail yet: it was written before Gmail was connected, so it goes to the Drafts of ${g.account} when it is next edited. Press "Put it in Gmail" to add it now.`
            : `Being saved to the Drafts of ${g.account} (within a few seconds).`;
  const warn = !g.connected || !!g.note || g.missing || !!g.error;
  return (
    <p role="status" style={{ margin: "8px 0 0", fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", color: warn ? "var(--c-orange)" : "var(--c-mut)" }}>
      <span style={{ flex: "1 1 240px" }}>{msg ?? text}</span>
      {canWrite && g.connected && !g.note ? (
        <button className="btn" type="button" onClick={resync} aria-busy={pending} style={{ minHeight: 32, padding: "0 10px", fontSize: 13 }}>
          {pending ? "Checking…" : g.missing ? "Put it back in Gmail" : g.beforeLink ? "Put it in Gmail" : "Check Gmail now"}
        </button>
      ) : null}
    </p>
  );
}
