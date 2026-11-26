import { formatInr } from "@/domain/money";
import { formatDateTimeIST } from "@/domain/time";
import { computeLedger } from "@/domain/ledger";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { recordAudit } from "../audit";
import { now } from "../clock";
import { buildZip, type ZipEntry } from "../documents/zip";
import { readStoredFile, sha256 } from "../storage";
import { caseReference } from "./cases";

/**
 * The case file for a court or a handover: every stored original and derived text with its recorded hash and a
 * hash computed again at export, the money ledger, and the full audit log. Read access to the case is enough;
 * every export is itself recorded in the audit log.
 */

const csv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
const safe = (s: string) => s.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
const ist = (d: Date | null | undefined) => (d ? formatDateTimeIST(d) : "");
const minor = (v: bigint | null | undefined) => (v === null || v === undefined ? "unknown" : formatInr(v));

export async function buildCaseFile(db: Db, user: SessionUser, caseId: string) {
  const c = await loadCaseForUser(db, user, caseId, "read");
  const at = now();
  const [evidence, audit, users, claims, holds, allocations, refunds, transactions, requests] = await Promise.all([
    db.evidenceItem.findMany({ where: { caseId }, orderBy: [{ receivedAt: "asc" }, { uploadedAt: "asc" }] }),
    db.auditEvent.findMany({ where: { caseId }, orderBy: { at: "asc" } }),
    db.user.findMany({ select: { id: true, displayName: true, rank: true } }),
    db.victimClaim.findMany({ where: { caseId }, include: { victim: true }, orderBy: { createdAt: "asc" } }),
    db.hold.findMany({ where: { caseId }, include: { account: true }, orderBy: { createdAt: "asc" } }),
    db.allocation.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.refund.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.transaction.findMany({ where: { caseId }, include: { fromEntity: true, toEntity: true }, orderBy: { occurredAt: "asc" } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { recipient: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const who = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : id ? "Former user" : "System";
  };
  const ref = caseReference(c);
  const entries: ZipEntry[] = [];
  const manifest: (string | number | null)[][] = [["Path in this archive", "Title", "Category", "Derivation", "Derived from", "Received (IST)", "Size (bytes)", "SHA-256 recorded at intake", "SHA-256 computed at export", "Matches"]];
  const pathOf = new Map<string, string>();
  let mismatches = 0;
  let missing = 0;
  evidence.forEach((e, i) => {
    const dir = e.derivation === "ORIGINAL" ? "originals" : "derived";
    const path = `${dir}/${String(i + 1).padStart(3, "0")}_${safe(e.fileName)}`;
    pathOf.set(e.id, path);
    let buf: Buffer | null = null;
    try {
      buf = readStoredFile(e.storageKey);
    } catch {
      missing++;
    }
    const computed = buf ? sha256(buf) : null;
    const ok = computed !== null && computed === e.sha256;
    if (buf && !ok) mismatches++;
    if (buf) entries.push({ name: path, data: buf, modified: e.receivedAt });
    manifest.push([buf ? path : "(file missing from storage)", e.title, e.category, e.derivation, e.parentId ? (pathOf.get(e.parentId) ?? e.parentId) : "", ist(e.receivedAt), e.sizeBytes, e.sha256, computed ?? "not readable", ok ? "yes" : "NO"]);
  });

  const ledger = computeLedger({
    claims: claims.map((x) => ({ id: x.id, lossMinor: x.lossAmountMinor, status: x.status })),
    holds: holds.map((h) => ({ id: h.id, status: h.status, confirmedMinor: h.confirmedAmountMinor })),
    allocations: allocations.map((a) => ({ id: a.id, holdId: a.holdId, claimId: a.claimId, amountMinor: a.amountMinor, status: a.status })),
    refunds: refunds.map((r) => ({ id: r.id, claimId: r.claimId, amountMinor: r.amountMinor, status: r.status })),
    transactions: transactions.map((t) => ({ id: t.id, layer: t.layer, amountMinor: t.amountMinor, claimId: t.claimId, kind: t.kind })),
  });
  const ledgerText = [
    `Money ledger · ${ref}`,
    `As exported ${ist(at)}`,
    "",
    `Reported lost:            ${formatInr(ledger.totalLossMinor)}`,
    `Confirmed held:           ${formatInr(ledger.confirmedHeldMinor)}${ledger.unknownHoldCount ? ` (and ${ledger.unknownHoldCount} hold(s) of unknown amount)` : ""}`,
    `Confirmed returned:       ${formatInr(ledger.confirmedRefundsMinor)}`,
    `Neither held nor returned: ${minor(ledger.neitherReturnedNorSecuredMinor)}`,
    `Reconciliation:           ${ledger.reconciliation.status === "CONSISTENT" ? "consistent" : "needs reconciliation"}`,
    ...ledger.reconciliation.issues.map((i) => `  - ${i.message}`),
    "",
    "Claims",
    ...claims.map((x) => `  ${x.victim.label}: loss ${formatInr(x.lossAmountMinor)} · ${x.status.toLowerCase()}`),
    "",
    "Holds",
    ...holds.map((h) => `  ${h.account.label} (${h.account.value}): ${h.status.toLowerCase().replace(/_/g, " ")} · ${minor(h.confirmedAmountMinor)}${h.confirmedAsOf ? ` as of ${ist(h.confirmedAsOf)}` : ""}${h.expiresAt ? ` · lapses ${ist(h.expiresAt)}` : ""}`),
    "",
    "Allocations",
    ...(allocations.length ? allocations.map((a) => `  ${formatInr(a.amountMinor)} from hold ${holds.find((h) => h.id === a.holdId)?.account.label ?? a.holdId} to claim of ${claims.find((x) => x.id === a.claimId)?.victim.label ?? a.claimId} · ${a.status.toLowerCase()} · basis: ${a.basis}`) : ["  None recorded"]),
    "",
    "Refunds",
    ...(refunds.length ? refunds.map((r) => `  ${formatInr(r.amountMinor)} to ${claims.find((x) => x.id === r.claimId)?.victim.label ?? r.claimId} · ${r.status.toLowerCase().replace(/_/g, " ")}`) : ["  None recorded"]),
    "",
  ].join("\r\n");
  const txCsv = csv([["When (IST)", "From", "To", "Amount", "Channel", "Reference", "Kind", "Layer", "Status"], ...transactions.map((t) => [ist(t.occurredAt), `${t.fromEntity.label} (${t.fromEntity.value})`, `${t.toEntity.label} (${t.toEntity.value})`, formatInr(t.amountMinor), t.channel, t.reference, t.kind, t.layer, t.status])]);
  const reqCsv = csv([["Reference", "Category", "Recipient", "Address", "Status", "Submitted (IST)"], ...requests.map((r) => [r.reference, r.category, r.recipient.organisation, r.recipient.address, r.status, ist(r.submittedAt)])]);
  const auditCsv = csv([["When (IST)", "By", "Action", "Object", "Summary", "Corrects event"], ...audit.map((a) => [ist(a.at), who(a.actorId), a.action, `${a.objectType}${a.objectId ? ` ${a.objectId}` : ""}`, a.summary, a.correctsId])]);
  const readme = [
    `Case file · ${ref} · ${c.title}`,
    `${c.isDemo ? "SYNTHETIC DEMONSTRATION DATA: every name, number and document here is fictional.\r\n" : ""}Exported ${ist(at)} by ${shortRank(user.rank)} ${user.displayName}, ${user.stationName}.`,
    "",
    "Contents",
    "  originals/          every document as received, unchanged",
    "  derived/            text, translations and transcriptions made from an original (see manifest.csv)",
    "  manifest.csv        each file with the SHA-256 recorded when it arrived and the SHA-256 computed for this export",
    "  ledger.txt          the money position: lost, held, allocated, returned",
    "  transactions.csv    the money trail as recorded",
    "  requests.csv        requests sent from the case and their status",
    "  audit-log.csv       every recorded action on the case, in order",
    "",
    mismatches || missing
      ? `WARNING: ${mismatches} file(s) do not match the hash recorded at intake and ${missing} file(s) could not be read. See manifest.csv.`
      : "Every file matches the hash recorded when it arrived.",
    "To check a file yourself: sha256sum originals/<file> and compare with manifest.csv.",
    "",
  ].join("\r\n");
  const stamp = at;
  const all: ZipEntry[] = [
    { name: "README.txt", data: Buffer.from(readme, "utf8"), modified: stamp },
    { name: "manifest.csv", data: Buffer.from(csv(manifest), "utf8"), modified: stamp },
    { name: "ledger.txt", data: Buffer.from(ledgerText, "utf8"), modified: stamp },
    { name: "transactions.csv", data: Buffer.from(txCsv, "utf8"), modified: stamp },
    { name: "requests.csv", data: Buffer.from(reqCsv, "utf8"), modified: stamp },
    { name: "audit-log.csv", data: Buffer.from(auditCsv, "utf8"), modified: stamp },
    ...entries,
  ];
  const buffer = buildZip(all);
  await db.$transaction((tx) =>
    recordAudit(tx, { caseId, actorId: user.id, action: "case.exported", objectType: "Case", objectId: caseId, summary: `Case file downloaded: ${evidence.length} files, ledger and audit log${mismatches || missing ? ` (${mismatches + missing} file(s) failed the hash check)` : ""}`, detail: { files: evidence.length, mismatches, missing, sha256: sha256(buffer) } }),
  );
  return { fileName: `${safe(ref.replace(/\//g, "-")).replace(/ /g, "_")}_case_file.zip`, buffer, files: evidence.length, mismatches, missing };
}
