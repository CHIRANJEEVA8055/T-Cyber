import { getDb } from "../src/server/db";
import type { SessionUser } from "../src/server/auth/session";
import { getAppConfig } from "../src/server/config";
import { updateDraftTx } from "../src/server/services/requests";
import { recordAudit } from "../src/server/audit";
import { caseRefKey, coreRef, formatRequestRef, refVariants, reminderRef } from "../src/domain/request-ref";
import { normalizeIdentifier } from "../src/domain/identifiers";
import { formatSections } from "../src/domain/legal-sections";

/**
 * Moves every request to the reference that names its kind and its case: R.REQ-412/2026-002 (P. preservation,
 * R. records, H. hold, U. release; R.REQ-412/2026-002-R1 for a reminder). Run it after any change to the format:
 * npx tsx scripts/migrate-request-refs.ts  (add --dry-run to only list the changes)
 *  - the oldest reference (REQ-2026-0275) is kept as the request's legacy reference, and a reply quoting the form
 *    without the letter (REQ-412/2026-002) is matched by its core, so earlier mail still finds its request; what was
 *    sent is not changed;
 *  - an unsent draft gets a new version whose text quotes the new reference, shows its identifiers in full instead
 *    of their last digits and writes the case's sections section-first ("318(4) BNS"); the version history keeps
 *    the old wording;
 *  - the next actions' own wording (titles, questions, reasons) quotes the new references too ("R-01" included);
 *  - each change is in the case's audit log. Running it again changes nothing.
 */
const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];
const dry = process.argv.includes("--dry-run");

async function main() {
  const db = getDb();
  const prefix = getAppConfig().requests.referencePrefix;
  const cases = await db.case.findMany({ include: { station: true, assignments: { include: { user: { include: { station: true } } } } }, orderBy: { createdAt: "asc" } });
  let renamed = 0;
  let redrafted = 0;
  let retitled = 0;
  for (const kase of cases) {
    const key = caseRefKey(kase);
    if (!key) continue;
    const requests = await db.request.findMany({ where: { caseId: kase.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    if (!requests.length) continue;
    // New references, in the order officers saw them: a request's serial is its caseSeq; reminders follow their parent.
    const next = new Map<string, string>();
    let maxSeq = Math.max(0, ...requests.map((r) => r.caseSeq ?? 0));
    const seqFix = new Map<string, number>();
    for (const r of requests.filter((x) => !x.parentRequestId)) {
      const seq = r.caseSeq ?? ++maxSeq;
      if (!r.caseSeq) seqFix.set(r.id, seq);
      next.set(r.id, formatRequestRef(prefix, key, seq, r.category));
    }
    const kids = new Map<string, number>();
    for (const r of requests.filter((x) => x.parentRequestId)) {
      const parent = next.get(r.parentRequestId!);
      if (!parent) continue;
      const n = (kids.get(r.parentRequestId!) ?? 0) + 1;
      kids.set(r.parentRequestId!, n);
      next.set(r.id, reminderRef(parent, n));
    }
    const io = kase.assignments.find((a) => a.role === "INVESTIGATING_OFFICER")?.user ?? kase.assignments[0]?.user;
    for (const r of requests) {
      let ref = next.get(r.id);
      if (!ref || r.reference === ref || r.reference === `${ref}-${kase.station.code}`) continue; // already moved
      const clash = await db.request.findFirst({ where: { OR: [{ reference: { in: refVariants(coreRef(ref, prefix)) } }, { legacyReference: { in: refVariants(coreRef(ref, prefix)) } }], NOT: { id: r.id } }, select: { id: true } });
      if (clash) ref = `${ref}-${kase.station.code}`;
      const old = r.reference;
      // Only a reference from before references named their case is kept as the legacy one; the form without the kind's
      // letter (REQ-412/2026-002) is still matched by its core.
      const legacy = r.legacyReference ?? (/^[A-Z]+-\d{4}-\d{4}$/.test(old) ? old : null);
      console.log(`${dry ? "[dry run] " : ""}${caseLabel(kase)}: ${old} → ${ref}`);
      renamed++;
      if (dry) continue;
      await db.$transaction(async (tx) => {
        await tx.request.update({ where: { id: r.id }, data: { reference: ref!, legacyReference: legacy, ...(seqFix.has(r.id) ? { caseSeq: seqFix.get(r.id)! } : {}) } });
        await recordAudit(tx, { caseId: kase.id, actorId: null, action: "request.reference_renamed", objectType: "Request", objectId: r.id, summary: `Reference ${old} is now ${ref} (references name the kind of request and its case: P. preservation, R. records, H. hold, U. release). A reply quoting ${old} is still matched to it.`, detail: { from: old, to: ref } });
      });
    }
    if (dry) continue;

    // Every earlier way the case's text names a request becomes its reference now: the legacy reference, the form
    // without the kind's letter (longest first, so a reminder's is replaced before its request's), and "R-01".
    const all = await db.request.findMany({ where: { caseId: kase.id }, select: { reference: true, legacyReference: true, caseSeq: true, parentRequestId: true } });
    const renames: [RegExp, string][] = [
      ...all.filter((x) => x.legacyReference).sort((a, b) => b.legacyReference!.length - a.legacyReference!.length).map((x) => [new RegExp(`(?<![\\w.])${esc(x.legacyReference!)}(?!\\d)`, "g"), x.reference] as [RegExp, string]),
      ...all
        .filter((x) => coreRef(x.reference, prefix) !== x.reference)
        .sort((a, b) => b.reference.length - a.reference.length)
        .map((x) => [new RegExp(`(?<![\\w.])${esc(coreRef(x.reference, prefix))}(?![\\w/]|-R\\d)`, "g"), x.reference] as [RegExp, string]),
      ...all.filter((x) => x.caseSeq && !x.parentRequestId).map((x) => [new RegExp(`\\bR-${String(x.caseSeq).padStart(2, "0")}\\b`, "g"), x.reference] as [RegExp, string]),
    ];
    const retext = (t: string | null) => (t === null ? null : renames.reduce((acc, [re, to]) => acc.replace(re, to), t));
    const tasks = await db.task.findMany({ where: { caseId: kase.id }, select: { id: true, title: true, question: true, relevance: true, statusReason: true, prerequisitesJson: true, priorityReason: true, completionNote: true, expectedClarification: true } });
    let n = 0;
    for (const t of tasks) {
      const next = { title: retext(t.title)!, question: retext(t.question)!, relevance: retext(t.relevance)!, statusReason: retext(t.statusReason), prerequisitesJson: retext(t.prerequisitesJson)!, priorityReason: retext(t.priorityReason)!, completionNote: retext(t.completionNote), expectedClarification: retext(t.expectedClarification)! };
      if (Object.entries(next).every(([k, v]) => v === (t as Record<string, unknown>)[k])) continue;
      await db.task.update({ where: { id: t.id }, data: { ...next, version: { increment: 1 } } });
      n++;
    }
    if (n) {
      await db.$transaction((tx) => recordAudit(tx, { caseId: kase.id, actorId: null, action: "task.references_renamed", objectType: "Case", objectId: kase.id, summary: `The wording of ${n} next ${n === 1 ? "action" : "actions"} now quotes the new request references.` }));
      retitled += n;
      console.log(`${caseLabel(kase)}: ${n} next ${n === 1 ? "action" : "actions"} reworded with the new references`);
    }
    if (!io) continue;

    // Unsent drafts' own text: every old reference of the case (their own, a reminder's parent) becomes the new one,
    // identifiers are written in full where only their last digits were shown, and the sections section-first.
    const entities = (await db.entity.findMany({ where: { caseId: kase.id, kind: { in: ["BANK_ACCOUNT", "PHONE", "UPI_ID", "WALLET"] } }, select: { value: true } })).map((e) => e.value);
    const sections = kase.legalSections?.trim() ?? "";
    const actor: SessionUser = { id: io.id, username: io.username, displayName: io.displayName, rank: io.rank, role: io.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: io.stationId, stationCode: io.station.code, stationName: io.station.name };
    for (const r of requests.filter((x) => UNSENT.includes(x.status))) {
      await db.$transaction(async (tx) => {
        const req = await tx.request.findUniqueOrThrow({ where: { id: r.id }, include: { items: { orderBy: { sortOrder: "asc" } }, subjects: { include: { entity: true } } } });
        const v = await tx.requestVersion.findUniqueOrThrow({ where: { requestId_versionNo: { requestId: r.id, versionNo: req.currentVersionNo } } });
        const fix = (text: string) => {
          let t = text;
          t = retext(t)!;
          t = unmask(t, req.subjects.map((x) => x.entity.value), entities);
          if (sections && formatSections(sections) !== sections) t = t.split(sections).join(formatSections(sections));
          return t;
        };
        const subject = fix(v.subject);
        const body = fix(v.body);
        const live = req.liveJson ? fix(req.liveJson) : null;
        if (live !== req.liveJson) await tx.request.update({ where: { id: r.id }, data: { liveJson: live } });
        if (subject === v.subject && body === v.body) return;
        await updateDraftTx(tx, actor, r.id, { expectedVersion: req.version, recipientId: v.recipientId, subject, body, scope: v.scope, periodFrom: v.periodFrom, periodTo: v.periodTo, items: req.items.map((i) => ({ label: i.label, itemType: i.itemType })), attachmentIds: JSON.parse(v.attachmentIdsJson) as string[], changeNote: `References renamed (${req.reference}); identifiers in full; sections written section-first`, lenient: true }, io.id);
        redrafted++;
        console.log(`${caseLabel(kase)}: ${req.reference} (unsent) given a new version with the new wording`);
      });
    }
  }
  console.log(dry ? `${renamed} references would be renamed.` : `${renamed} references renamed; ${redrafted} unsent drafts given a new version; ${retitled} next actions reworded.`);
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const caseLabel = (k: { referenceType: string; firNumber: number | null; firYear: number | null; complaintRef: string | null }) => (k.firNumber ? `FIR ${k.firNumber}/${k.firYear}` : `Complaint ${k.complaintRef}`);

/** "···4471" → the full value it stands for, when exactly one of the request's (or else the case's) values ends so. */
function unmask(text: string, preferred: string[], all: string[]): string {
  return text.replace(/·{2,}\s?([0-9A-Za-z]{2,6})\b/g, (m, tail: string) => {
    const ends = (v: string) => normalizeIdentifier("BANK_ACCOUNT", v).replace(/[^0-9A-Za-z]/g, "").toUpperCase().endsWith(tail.toUpperCase());
    const own = [...new Set(preferred.filter(ends))];
    if (own.length === 1) return own[0]!;
    const any = [...new Set(all.filter(ends))];
    return any.length === 1 ? any[0]! : m;
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
