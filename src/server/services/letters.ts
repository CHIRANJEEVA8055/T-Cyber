import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { deliverySettings, getAppConfig } from "../config";
import { addressProblem, splitAddresses } from "@/domain/mail-check";
import { notFoundError } from "../errors";
import { now } from "../clock";
import { buildDocumentPdf, type DocLine } from "../documents/document-pdf";
import { buildDocx, type DocBlock } from "../documents/docx-writer";
import { formatSections } from "@/domain/legal-sections";
import { fileSafeRef } from "@/domain/request-ref";

/**
 * A request as a letter to print and send by hand or post, laid out like the station's notices: the letterhead, the
 * issuing office and date, the notice heading the station configures for that kind of request, To, Sub and Ref, and
 * the request's own wording exactly as drafted. It prints clean once it is ready to go: the addressee is known, the
 * address is verified, and nothing is waiting to be checked. Until then it is marked DRAFT on every page, with the
 * reason. Approval is not needed for the printed letter. Nothing is sent from here; the download is logged.
 */

const APPROVED = ["APPROVED", "SUBMISSION_FAILED", "SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"];
const ddmmyyyy = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).format(d).replace(/\//g, "-");

export interface Letter {
  title: string;
  fileStem: string;
  approved: boolean;
  /** Ready to print without the DRAFT mark (approved, or the address and details verified). */
  final: boolean;
  /** Why it is still marked DRAFT, when it is. */
  draftReason: string | null;
  letterhead: string[];
  office: string[];
  date: string;
  heading: string | null;
  to: string[];
  sub: string;
  ref: string;
  body: string[];
  footer: string;
}

export async function requestLetter(db: Db, user: SessionUser, requestId: string): Promise<Letter> {
  const req = await db.request.findUnique({
    where: { id: requestId },
    include: { recipient: true, approvals: { where: { decision: "APPROVED", invalidatedAt: null }, orderBy: { decidedAt: "desc" }, take: 1 } },
  });
  if (!req) throw notFoundError("request");
  const kase = await loadCaseForUser(db, user, req.caseId, "read");
  const saved = await db.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId, versionNo: req.currentVersionNo } } });
  // While the mail window has it open, the letter prints what is typed there (its working copy).
  const live = (() => {
    if (!req.liveJson || !["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"].includes(req.status)) return null;
    try {
      return JSON.parse(req.liveJson) as { subject: string; body: string };
    } catch {
      return null;
    }
  })();
  const v = { subject: live?.subject ?? saved.subject, body: live?.body ?? saved.body };
  const io = kase.assignments.find((a) => a.role === "INVESTIGATING_OFFICER");
  const officer = io ? await db.user.findUnique({ where: { id: io.userId } }) : null;
  const cfg = getAppConfig();
  const approved = APPROVED.includes(req.status) && req.approvedVersionNo === req.currentVersionNo;
  const approvedAt = approved ? (req.approvals[0]?.decidedAt ?? req.submittedAt ?? now()) : now();
  // The printed letter is final once its addressee is known and verified and nothing is waiting to be checked. With
  // Gmail, the address the officer typed is the addressee (it is their choice, as for the mail itself).
  const typed = deliverySettings().mode === "gmail" ? splitAddresses(req.gmailTo ?? "").filter((a) => !addressProblem(a)) : [];
  const unfilled = /\[[^\]\n]{0,120}(?:to be filled in|record the [^\]\n]{0,80})\]/i.test(v.body);
  const draftReason = approved
    ? null
    : unfilled
      ? "a line still to be filled in"
      : typed.length
        ? req.needsReview
          ? "to be checked before sending"
          : null
        : ["UNADDRESSED", "MANUAL"].includes(req.recipient.organisationType)
          ? "addressee to be filled in"
          : !kase.isDemo && req.recipient.isSynthetic && !["POLICE_UNIT", "NPCI"].includes(req.recipient.organisationType)
            ? "demonstration address: type the real address"
            : req.recipient.verificationStatus !== "VERIFIED"
              ? "address not verified"
              : req.needsReview
                ? "to be checked before sending"
                : null;
  const final = !draftReason;
  const rank = officer?.rank ?? user.rank;
  const title = /inspector|superintendent|commissioner/i.test(rank) ? `${rank} of Police` : rank;
  const caseRef = kase.firNumber ? `Crime No. ${kase.firNumber}/${kase.firYear}` : `Complaint ${kase.complaintRef ?? ""}`.trim();

  // "FIR 1439/2026 · preservation request · x@y.com · REQ-1439/2026-001" → "Preservation request, x@y.com".
  const subject = v.subject
    .replace(/^(?:FIR|Complaint)\s+[^·]+·\s*/i, "")
    .replace(/\s*·\s*(?:[A-Z]\.)?REQ-[\w/-]+\s*$/i, "")
    // "···2093" is a masked number, not a separator.
    .replace(/[·.…]{2,}\s?(\w+)/g, "ending $1")
    .replace(/\s+·\s+/g, ", ")
    .trim();
  // The letter prints its own To and salutation; the draft's opening lines up to "Sir/Madam," are not repeated.
  const lines = v.body.replace(/\r/g, "").split("\n");
  const salute = lines.findIndex((l) => /^\s*(?:sir\/madam|sir|madam|dear sir)\s*,?\s*$/i.test(l));
  const bodyLines = (salute >= 0 && salute <= 6 ? lines.slice(salute + 1) : lines).join("\n").trim().split(/\n{2,}/);

  // A draft written before its addressee was known prints a line to fill in, naming whom it is for.
  const blank = req.recipient.organisationType === "UNADDRESSED" ? (/\[([^\]]+): to be filled in\]/.exec(v.body)?.[1] ?? "the recipient").replace(/[·.…]{2,}\s?(\w+)/g, "ending $1") : null;
  const directoryTo = !["UNADDRESSED", "MANUAL", "TYPED"].includes(req.recipient.organisationType);
  const to = typed.length && !directoryTo
    ? ["To", `Email: ${typed.join(", ")}`]
    : typed.length
      ? ["To", req.recipient.name, ...(req.recipient.organisation && !req.recipient.name.includes(req.recipient.organisation) ? [req.recipient.organisation] : []), `Email: ${typed.join(", ")}`]
      : blank
        ? ["To", "The Nodal Officer,", `[${blank}: to be filled in]`]
        : ["To", req.recipient.name, ...(req.recipient.organisation && !req.recipient.name.includes(req.recipient.organisation) ? [req.recipient.organisation] : []), req.recipient.channel === "PORTAL" ? `Portal: ${req.recipient.address}` : `Email: ${req.recipient.address}`];
  return {
    title: `${req.reference} · ${subject || "Request"}`,
    fileStem: `${fileSafeRef(req.reference)}_${(blank ? "unaddressed" : req.recipient.organisation || "letter").replace(/[^\w]+/g, "_")}`.replace(/_+$/, ""),
    approved,
    final,
    draftReason,
    letterhead: cfg.station.letterhead,
    office: ["Office of the", `${title},`, `${cfg.station.name},`, `${cfg.station.district}.`],
    date: `Dated: ${ddmmyyyy(approvedAt)}`,
    heading: cfg.requests.noticeHeadings[req.category as keyof typeof cfg.requests.noticeHeadings] ?? null,
    to,
    sub: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} – Reg.`,
    ref: `${caseRef}${kase.legalSections ? `, U/Sec ${formatSections(kase.legalSections)}` : ""} of ${cfg.station.name}, ${cfg.station.district}. Our reference ${req.reference}.`,
    body: bodyLines,
    footer: `${req.reference} · version ${req.currentVersionNo}${approved ? ` · approved ${ddmmyyyy(approvedAt)}` : final ? (typed.length ? ` · to ${typed.join(", ")}` : ` · address verified${req.recipient.verifiedAt ? ` ${ddmmyyyy(req.recipient.verifiedAt)}` : ""}`) : ` · DRAFT, ${draftReason}`}`,
  };
}

export function letterPdf(l: Letter): Buffer {
  const out: DocLine[] = [];
  for (const h of l.letterhead) out.push({ text: h, align: "center", bold: true, size: 13 });
  out.push({ text: l.office[0]!, gapBefore: l.letterhead.length ? 10 : 0 });
  for (const o of l.office.slice(1)) out.push({ text: o });
  out.push({ text: l.date, align: "right", gapBefore: 4 });
  if (l.heading) out.push({ text: l.heading, align: "center", bold: true, size: 12, gapBefore: 8 });
  out.push({ text: l.to[0]!, gapBefore: 10 });
  for (const t of l.to.slice(1)) out.push({ text: t, indent: 18 });
  out.push({ text: "Sir/Madam,", gapBefore: 10 });
  out.push({ text: `Sub: ${l.sub}`, bold: true, gapBefore: 6, indent: 18 });
  out.push({ text: `Ref: ${l.ref}`, indent: 18 });
  out.push({ text: "* * *", align: "center", gapBefore: 4 });
  for (const para of l.body) {
    const rows = para.split("\n");
    rows.forEach((r, i) => {
      const item = /^\s*[-•*]\s+/.test(r);
      out.push({ text: item ? `- ${r.replace(/^\s*[-•*]\s+/, "")}` : r, indent: item ? 18 : 0, gapBefore: i === 0 ? 8 : 0 });
    });
  }
  return buildDocumentPdf(out, { title: l.title, producer: "T-CYBER request letter", watermark: l.final ? null : "DRAFT", footer: l.footer });
}

export function letterDocx(l: Letter): Buffer {
  const b: DocBlock[] = [];
  if (!l.final) b.push({ kind: "para", text: `DRAFT – ${l.draftReason}`, bold: true, color: "B42318", align: "center" });
  for (const h of l.letterhead) b.push({ kind: "para", text: h, align: "center", bold: true, size: 13 });
  b.push({ kind: "para", text: l.office.join("\n") });
  b.push({ kind: "para", text: l.date, align: "right" });
  if (l.heading) b.push({ kind: "para", text: l.heading, align: "center", bold: true, size: 12 });
  b.push({ kind: "para", text: l.to.join("\n") });
  b.push({ kind: "para", text: "Sir/Madam," });
  b.push({ kind: "para", text: `Sub: ${l.sub}`, bold: true, indent: 18 });
  b.push({ kind: "para", text: `Ref: ${l.ref}`, indent: 18 });
  b.push({ kind: "para", text: "* * *", align: "center" });
  for (const para of l.body) b.push({ kind: "para", text: para, align: "both" });
  b.push({ kind: "small", text: l.footer });
  return buildDocx(b, { title: l.title, author: "T-CYBER", created: now() });
}

/** The letter in the format asked for; the download is recorded against the case. */
export async function downloadLetter(db: Db, user: SessionUser, requestId: string, format: "pdf" | "docx"): Promise<{ fileName: string; buffer: Buffer; contentType: string }> {
  const l = await requestLetter(db, user, requestId);
  const req = await db.request.findUniqueOrThrow({ where: { id: requestId }, select: { caseId: true, reference: true } });
  await db.$transaction((tx) =>
    recordAudit(tx, { caseId: req.caseId, actorId: user.id, action: "request.letter_downloaded", objectType: "Request", objectId: requestId, summary: `${req.reference} downloaded as a ${format === "pdf" ? "PDF" : "Word"} letter${l.final ? (l.approved ? "" : " (address verified; not yet approved)") : ` (marked DRAFT: ${l.draftReason})`}` }),
  );
  return format === "pdf"
    ? { fileName: `${l.fileStem}.pdf`, buffer: letterPdf(l), contentType: "application/pdf" }
    : { fileName: `${l.fileStem}.docx`, buffer: letterDocx(l), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
}
