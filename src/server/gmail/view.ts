import { deliverySettings } from "../config";
import { gmailStatus, readToken } from "./oauth";

/** What a draft screen shows about its Gmail copy, and the To address to offer. Never includes a secret. */
export interface GmailDraftView {
  /** Delivery goes through Gmail (configuration delivery.mode "gmail" with gmail.enabled). */
  on: boolean;
  connected: boolean;
  account: string | null;
  /** Why it is not usable yet, in plain words (null when connected). */
  note: string | null;
  inGmail: boolean;
  /** Not in Gmail yet and not on its way: written before Gmail was connected (it goes there when next edited). */
  beforeLink: boolean;
  syncedAt: string | null;
  error: string | null;
  missing: boolean;
  /** The address to offer in the To box: the one typed before, else the verified directory address. */
  to: string;
}

/** Whether email goes out through the linked Gmail account, for labelling the email channel. Never includes a secret. */
export function gmailChannel(): { on: boolean; connected: boolean; account: string | null } {
  if (deliverySettings().mode !== "gmail") return { on: false, connected: false, account: null };
  const st = gmailStatus();
  return { on: true, connected: st.enabled && st.connected, account: st.connectedAs ?? st.account };
}

export function gmailDraftView(r: { updatedAt: Date; gmailDraftId: string | null; gmailSyncedAt: Date | null; gmailError: string | null; gmailTo: string | null; channel: string; recipient: { address: string; verificationStatus: string; isSynthetic: boolean; organisationType: string } }, isDemo: boolean): GmailDraftView {
  // Every request goes through Gmail when it is the delivery mode, a portal provider's too (the officer types where).
  const on = deliverySettings().mode === "gmail";
  const st = gmailStatus();
  const usableDirectory = !["UNADDRESSED", "MANUAL"].includes(r.recipient.organisationType) && r.recipient.verificationStatus === "VERIFIED" && (isDemo || !r.recipient.isSynthetic) && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(r.recipient.address);
  const missing = !!r.gmailError?.startsWith("MISSING");
  // The background sync takes drafts made or changed since the link was made (see syncAllWithGmail).
  const connectedAt = st.connected ? Date.parse(readToken()?.connectedAt ?? "") : NaN;
  return {
    on,
    connected: st.connected,
    account: st.connectedAs ?? st.account,
    note: st.enabled && st.connected ? null : st.note,
    inGmail: !!r.gmailDraftId && !missing,
    beforeLink: !r.gmailDraftId && !Number.isNaN(connectedAt) && r.updatedAt.getTime() < connectedAt,
    syncedAt: r.gmailSyncedAt?.toISOString() ?? null,
    error: r.gmailError ? r.gmailError.replace(/^MISSING: /, "") : null,
    missing,
    to: r.gmailTo ?? (usableDirectory ? r.recipient.address : ""),
  };
}
