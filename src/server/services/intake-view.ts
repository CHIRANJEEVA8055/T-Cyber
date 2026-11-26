import { formatDayMonthIST } from "@/domain/time";
import type { Tone } from "@/domain/standing";
import { canWriteCase } from "@/domain/permissions";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";

/**
 * Intake & evidence (design: Intake artboard): the documents the case was opened from, with every detail the
 * reader found marked where it was found, and the check of each one. Only what the officer confirms is applied.
 */

export type MarkKind = "acct" | "phone" | "plat" | "amt" | "unc";
const MARK: Record<string, MarkKind> = { BANK_ACCOUNT: "acct", IFSC: "acct", UPI_ID: "acct", PERSON_NAME: "phone", PHONE: "phone", EMAIL: "plat", PLATFORM_PROFILE: "plat", WEBSITE: "plat", IP_ADDRESS: "plat", AMOUNT: "amt", TXN_REFERENCE: "amt" };
const GROUP: Record<string, "people" | "money" | "contact" | "online"> = { PERSON_NAME: "people", BANK_ACCOUNT: "money", IFSC: "money", UPI_ID: "money", AMOUNT: "money", TXN_REFERENCE: "money", PHONE: "contact", EMAIL: "contact", PLATFORM_PROFILE: "online", WEBSITE: "online", IP_ADDRESS: "online" };
const NAME: Record<string, string> = { PERSON_NAME: "Name", BANK_ACCOUNT: "Account", IFSC: "IFSC", UPI_ID: "UPI ID", AMOUNT: "Amount", TXN_REFERENCE: "Reference", PHONE: "Mobile", EMAIL: "Email", PLATFORM_PROFILE: "Profile", WEBSITE: "Website", IP_ADDRESS: "IP address" };
const CAT: Record<string, string> = { FIR_COPY: "FIR", COMPLAINT: "NCRP receipt", SCREENSHOT: "Screenshots", TRANSACTION_RECORD: "Receipts", OTHER: "Document" };

export async function getIntakeView(db: Db, user: SessionUser, caseId: string) {
  const kase = await loadCaseForUser(db, user, caseId, "read");
  const writer = canWriteCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) });
  const docs = await db.evidenceItem.findMany({
    where: { caseId, derivation: "ORIGINAL", responseId: null, category: { notIn: ["EMAIL_MESSAGE", "BANK_RESPONSE", "TELECOM_RESPONSE", "PROVIDER_RESPONSE"] } },
    include: { segments: { orderBy: [{ page: "asc" }, { line: "asc" }, { row: "asc" }], take: 400 }, derived: { select: { id: true, derivation: true, segments: { orderBy: [{ page: "asc" }, { line: "asc" }], take: 400 } } } },
    orderBy: { receivedAt: "asc" },
  });
  docs.sort((a, b) => Number(b.category === "FIR_COPY") - Number(a.category === "FIR_COPY"));
  const ids = docs.map((d) => d.id);
  const [candidates, users, contradictions] = await Promise.all([
    db.extractionCandidate.findMany({ where: { caseId, evidenceId: { in: [...ids, ...docs.flatMap((d) => d.derived.map((x) => x.id))] } }, orderBy: [{ page: "asc" }, { line: "asc" }, { charStart: "asc" }] }),
    db.user.findMany({ where: { stationId: kase.stationId }, select: { id: true, displayName: true, rank: true } }),
    db.sourceAssertion.findMany({ where: { caseId, stance: "CONTRADICTS" }, include: { evidence: { select: { response: { select: { request: { select: { recipient: { select: { organisation: true } } } } } } } } } }),
  ]);
  const who = (id: string | null) => (id === user.id ? "you" : (() => { const u = users.find((x) => x.id === id); return u ? `${shortRank(u.rank)} ${u.displayName}` : "an officer"; })());

  const documents = docs.map((d) => {
    // A translated or transcribed copy is what the reader worked from; show that text with the original kept.
    const reading = d.derived.find((x) => x.derivation === "TRANSLATION" || x.derivation === "OCR_TEXT");
    const segs = reading?.segments.length ? reading.segments : d.segments;
    const sourceId = reading?.segments.length ? reading.id : d.id;
    const pages = new Set(segs.map((s) => s.page ?? 1)).size;
    const marks = candidates.filter((c) => c.evidenceId === sourceId && c.line !== null && c.charStart !== null && c.charEnd !== null && MARK[c.field]);
    return {
      id: d.id,
      tab: `${CAT[d.category] ?? d.title}${d.category === "FIR_COPY" && pages > 1 ? `, ${pages} pages` : ""}`,
      caption: `${d.fileName} · ${reading ? (reading.derivation === "TRANSLATION" ? "translated to English; the original is kept" : "transcribed from the scan") : "read from its own text"} · hash recorded`,
      lines: segs.slice(0, 400).map((s) => ({
        page: s.page,
        line: s.line,
        text: s.text,
        marks: marks
          .filter((c) => c.page === s.page && c.line === s.line && (c.row ?? null) === (s.row ?? null))
          .map((c) => ({ start: c.charStart!, end: c.charEnd!, kind: (c.uncertainty !== "NONE" && c.uncertainty !== "MASKED" ? "unc" : MARK[c.field]!) as MarkKind, id: c.id }))
          .filter((m) => m.end > m.start && m.end <= s.text.length)
          .sort((x, y) => x.start - y.start),
      })),
      truncated: segs.length >= 400,
    };
  });

  // What was found, grouped; dates, FIR numbers and table rows are read but not listed for checking.
  const listed = candidates.filter((c) => GROUP[c.field]);
  const seen = new Set<string>();
  const items = listed
    .filter((c) => {
      const k = `${c.field}:${c.normalizedValue ?? c.originalValue}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => {
      const uncertain = c.uncertainty !== "NONE" && c.uncertainty !== "MASKED";
      const value = c.correctedValue ?? c.originalValue;
      const status: { text: string; tone: Tone | "you" } =
        c.status === "ADDED"
          ? { text: `Added by ${who(c.reviewedById)}`, tone: "you" }
          : ["ACCEPTED", "CORRECTED"].includes(c.status) || c.appliedAt
            ? { text: c.status === "CORRECTED" ? "Corrected" : "Confirmed", tone: "ok" }
            : c.status === "REJECTED"
              ? { text: "Set aside", tone: "neutral" }
              : uncertain
                ? { text: "Uncertain", tone: "gap" }
                : c.field === "PERSON_NAME"
                  ? { text: "Check role", tone: "wait" }
                  : { text: "Check", tone: "wait" };
      const where = c.page ? `Page ${c.page}` : c.row ? `Row ${c.row}` : "In the document";
      return {
        id: c.id,
        group: GROUP[c.field]!,
        title: `${NAME[c.field]} ${value}${c.roleHint ? `, ${c.roleHint.charAt(0).toLowerCase()}${c.roleHint.slice(1)}` : ""}`,
        sub: `${where}. ${c.uncertaintyNote ?? (c.field === "PERSON_NAME" ? "Whose name it is is decided by you, not by the reader." : c.excerpt ? `“${c.excerpt.slice(0, 90)}”` : "Read cleanly.")}`,
        status,
        pending: c.status === "PENDING",
        evidenceId: c.evidenceId,
      };
    });
  const groups = [
    { key: "people", label: "People", items: items.filter((i) => i.group === "people") },
    { key: "money", label: "Money", items: items.filter((i) => i.group === "money") },
    { key: "contact", label: "Contact", items: items.filter((i) => i.group === "contact") },
    { key: "online", label: "Online", items: items.filter((i) => i.group === "online") },
  ];
  const notInFir = candidates.some((c) => c.field === "IP_ADDRESS") ? [] : [{ title: "IP addresses and devices", sub: "Expected from the platform later, not from the complainant." }];
  const pending = items.filter((i) => i.pending).length;
  const confirmed = items.filter((i) => i.status.tone === "ok" || i.status.tone === "you").length;
  const flags = contradictions
    .filter((a) => /dates this/i.test(a.note ?? ""))
    .map((a) => {
      const d = /dates this \w+ (\d{2} \w{3}) \d{4} here but (\d{2} \w{3})/.exec(a.note ?? "");
      const org = a.evidence.response?.request?.recipient.organisation?.split(",")[0];
      return d ? `${org ?? "A bank"} later dates a payment ${d[1]}, not ${d[2]} as the FIR has it. The FIR text is kept as written and the difference is flagged against both.` : null;
    })
    .filter((x): x is string => !!x);
  const fir = docs.find((d) => d.category === "FIR_COPY");
  return {
    caseId,
    canWrite: writer,
    hasFir: !!fir,
    firReceived: fir ? formatDayMonthIST(fir.receivedAt) : null,
    documents,
    groups,
    notInFir,
    summary: `${items.length} ${items.length === 1 ? "detail" : "details"} · ${confirmed} confirmed${pending ? ` · ${pending} to check` : ""}`,
    pending,
    flags,
    pendingDocIds: [...new Set(items.filter((i) => i.pending).map((i) => i.evidenceId))],
  };
}
export type IntakeViewData = Awaited<ReturnType<typeof getIntakeView>>;
