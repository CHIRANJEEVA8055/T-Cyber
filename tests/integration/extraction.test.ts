import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { buildPdf } from "@/server/documents/pdf-writer";
import { uploadEvidence } from "@/server/services/evidence";
import { reviewCandidate, addManualCandidate, applyReviewedCandidates, suggestLinks } from "@/server/services/extraction";

async function firWorld() {
  const w = await buildWorld();
  await w.db.recipient.update({ where: { id: w.recipient.id }, data: { ifscPrefix: "DEMA" } });
  const pdf = buildPdf([
    {
      lines: [
        { text: "FIR No. 7/2026" },
        { text: "Name of complainant: Demo Person One (synthetic)" },
        { text: "Contact number used by caller: +91-XXXXXX4512" },
        { text: "Rs. 10,00,000 transferred to beneficiary A/c No. XXXXXXXX4821, IFSC DEMA0001234" },
        { text: "Replies came from advisor.desk@tradeprime-demo.example.invalid" },
      ],
    },
  ]);
  const ev = await uploadEvidence(w.db, w.officer, w.kase.id, { fileName: "fir.pdf", buffer: pdf, category: "FIR_COPY", sourceDescription: "Test", receivedAt: new Date() }, { runExtraction: true });
  const candidates = await w.db.extractionCandidate.findMany({ where: { evidenceId: ev.id } });
  const find = (field: string) => candidates.find((c) => c.field === field)!;
  return { ...w, ev, candidates, find };
}

describe("extraction review", () => {
  it("proposes candidates with page and line references for review", async () => {
    const w = await firWorld();
    expect(w.find("PHONE")).toMatchObject({ page: 1, line: 3, status: "PENDING", uncertainty: "MASKED" });
    const ev = await w.db.evidenceItem.findUniqueOrThrow({ where: { id: w.ev.id } });
    expect(ev.reviewStatus).toBe("IN_REVIEW");
  });

  it("applies accepted identifiers as unverified facts with the source location", async () => {
    const w = await firWorld();
    await reviewCandidate(w.db, w.officer, w.find("PHONE").id, { action: "ACCEPT" });
    const result = await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    expect(result.applied).toBe(1);
    const phone = await w.db.entity.findFirstOrThrow({ where: { caseId: w.kase.id, kind: "PHONE" } });
    expect(phone).toMatchObject({ value: "+91-XXXXXX4512", verificationStatus: "UNVERIFIED", caseRole: "Contact used by the caller / alleged fraudster" });
    const src = await w.db.sourceAssertion.findFirstOrThrow({ where: { subjectType: "ENTITY", subjectId: phone.id } });
    expect(src).toMatchObject({ evidenceId: w.ev.id, page: 1, line: 3 });
    expect(src.locator).toBe("p. 1, line 3");
  });

  it("preserves the original value when the officer corrects a candidate", async () => {
    const w = await firWorld();
    await reviewCandidate(w.db, w.officer, w.find("EMAIL").id, { action: "CORRECT", correctedValue: "advisor.desk2@tradeprime-demo.example.invalid" });
    const c = await w.db.extractionCandidate.findUniqueOrThrow({ where: { id: w.find("EMAIL").id } });
    expect(c).toMatchObject({ status: "CORRECTED", originalValue: "advisor.desk@tradeprime-demo.example.invalid", correctedValue: "advisor.desk2@tradeprime-demo.example.invalid" });
    await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    expect(await w.db.entity.findFirst({ where: { caseId: w.kase.id, kind: "EMAIL", value: "advisor.desk2@tradeprime-demo.example.invalid" } })).not.toBeNull();
  });

  it("requires a reason to reject and never applies rejected candidates", async () => {
    const w = await firWorld();
    await expect(reviewCandidate(w.db, w.officer, w.find("EMAIL").id, { action: "REJECT" })).rejects.toThrow(/reason/i);
    await reviewCandidate(w.db, w.officer, w.find("EMAIL").id, { action: "REJECT", rejectReason: "Officer's own email" });
    await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    expect(await w.db.entity.count({ where: { caseId: w.kase.id, kind: "EMAIL" } })).toBe(0);
  });

  it("links to an existing identifier only on an exact normalised match and never duplicates it", async () => {
    const w = await firWorld();
    const suggestions = await suggestLinks(w.db, w.officer, w.find("BANK_ACCOUNT").id);
    expect(suggestions.map((s) => s.id)).toEqual([w.account.id]);
    await reviewCandidate(w.db, w.officer, w.find("BANK_ACCOUNT").id, { action: "ACCEPT", linkEntityId: w.account.id });
    await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    expect(await w.db.entity.count({ where: { caseId: w.kase.id, kind: "BANK_ACCOUNT" } })).toBe(1);
    expect(await w.db.sourceAssertion.count({ where: { subjectType: "ENTITY", subjectId: w.account.id } })).toBe(1);
  });

  it("names the bank from an IFSC on the same line using the routing directory", async () => {
    const w = await firWorld();
    await w.db.entity.delete({ where: { id: w.account.id } });
    await reviewCandidate(w.db, w.officer, w.find("BANK_ACCOUNT").id, { action: "ACCEPT", label: "Account A" });
    await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    const acct = await w.db.entity.findFirstOrThrow({ where: { caseId: w.kase.id, kind: "BANK_ACCOUNT" } });
    expect(acct.label).toBe("Account A");
    expect(JSON.parse(acct.attributesJson)).toMatchObject({ bank: "Demo Bank A", ifsc: "DEMA0001234" });
  });

  it("never merges people by name", async () => {
    const w = await firWorld();
    await reviewCandidate(w.db, w.officer, w.find("PERSON_NAME").id, { action: "ACCEPT", roleHint: "Complainant" });
    await addManualCandidate(w.db, w.officer, w.ev.id, { field: "PERSON_NAME", value: "Demo Person One (synthetic)", page: 1, line: 2, roleHint: "Witness" });
    await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    const people = await w.db.entity.findMany({ where: { caseId: w.kase.id, kind: "PERSON" } });
    expect(people).toHaveLength(2);
    const roles = await w.db.partyRole.findMany({ where: { caseId: w.kase.id } });
    expect(roles.map((r) => r.role).sort()).toEqual(["COMPLAINANT", "WITNESS"]);
  });

  it("is idempotent when applied twice", async () => {
    const w = await firWorld();
    await reviewCandidate(w.db, w.officer, w.find("PHONE").id, { action: "ACCEPT" });
    await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    const again = await applyReviewedCandidates(w.db, w.officer, w.ev.id, {});
    expect(again.applied).toBe(0);
    expect(await w.db.entity.count({ where: { caseId: w.kase.id, kind: "PHONE" } })).toBe(1);
  });

  it("requires the payer account before applying payment rows", async () => {
    const w = await buildWorld();
    const csv = Buffer.from('Date,Time,Amount,Mode,UTR/RRN,Beneficiary Account,Beneficiary IFSC,Beneficiary Bank\n03-10-2026,11:42,"10,00,000.00",IMPS,DEMOUTR0001,XXXXXXXX4821,DEMA0001234,Demo Bank A\n');
    const ev = await uploadEvidence(w.db, w.officer, w.kase.id, { fileName: "receipts.csv", buffer: csv, category: "TRANSACTION_RECORD", sourceDescription: "Test", receivedAt: new Date() }, { runExtraction: true });
    const row = await w.db.extractionCandidate.findFirstOrThrow({ where: { evidenceId: ev.id, field: "TRANSACTION_ROW" } });
    await reviewCandidate(w.db, w.officer, row.id, { action: "ACCEPT" });
    await expect(applyReviewedCandidates(w.db, w.officer, ev.id, {})).rejects.toThrow(/payments were made from/i);
    const victim = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "V", value: "V", normalizedValue: "person:x", discoveredAt: new Date() } });
    const claim = await w.db.victimClaim.create({ data: { caseId: w.kase.id, victimEntityId: victim.id, lossAmountMinor: 100000000n, basis: "t" } });
    const payer = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Victim account", value: "XXXXXXXX3390", normalizedValue: "XXXXXXXX3390", discoveredAt: new Date() } });
    await applyReviewedCandidates(w.db, w.officer, ev.id, { payerAccountEntityId: payer.id, claimId: claim.id });
    const t = await w.db.transaction.findFirstOrThrow({ where: { caseId: w.kase.id } });
    expect(t).toMatchObject({ kind: "VICTIM_PAYMENT", layer: 1, amountMinor: 100000000n, status: "REPORTED_BY_VICTIM", toEntityId: w.account.id, claimId: claim.id });
  });

  it("reports unsupported documents without proposing anything", async () => {
    const w = await buildWorld();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const ev = await uploadEvidence(w.db, w.officer, w.kase.id, { fileName: "screen.png", buffer: png, category: "SCREENSHOT", sourceDescription: "Test", receivedAt: new Date() }, { runExtraction: true });
    const run = await w.db.extractionRun.findFirstOrThrow({ where: { evidenceId: ev.id } });
    expect(run.status).toBe("NOT_SUPPORTED");
    expect(await w.db.extractionCandidate.count({ where: { evidenceId: ev.id } })).toBe(0);
  });
});

describe("confirmClearCandidates", () => {
  it("confirms every clearly read item in one step, leaving people and flagged items for individual review", async () => {
    const { fir412Pdf } = await import("@/server/seed/documents");
    const { makeTimeline } = await import("@/server/seed/timeline");
    const fir1Pdf = () => fir412Pdf(makeTimeline("2026-11-09"));
    const { confirmClearCandidates } = await import("@/server/services/extraction");
    const w = await buildWorld();
    const ev = await uploadEvidence(w.db, w.officer, w.kase.id, { fileName: "fir.pdf", buffer: fir1Pdf().buffer, category: "FIR_COPY", sourceDescription: "Test", receivedAt: new Date() }, { runExtraction: true });
    const pending = await w.db.extractionCandidate.findMany({ where: { evidenceId: ev.id, status: "PENDING" } });
    const clear = pending.filter((c) => ["NONE", "MASKED"].includes(c.uncertainty) && c.field !== "PERSON_NAME");

    const r = await confirmClearCandidates(w.db, w.officer, ev.id);

    expect(r.confirmed).toBe(clear.length);
    expect(r.remaining).toBe(pending.length - clear.length);
    const after = await w.db.extractionCandidate.findMany({ where: { evidenceId: ev.id } });
    for (const c of after) {
      if (clear.some((x) => x.id === c.id)) expect(c).toMatchObject({ status: "ACCEPTED", reviewedById: w.officer.id });
      else expect(c.status).toBe("PENDING");
    }
    expect(after.filter((c) => c.field === "PERSON_NAME").every((c) => c.status === "PENDING")).toBe(true);
    const audit = await w.db.auditEvent.findFirstOrThrow({ where: { caseId: w.kase.id, action: "extraction.bulk_confirmed" } });
    expect(audit.summary).toContain(`${clear.length} items`);
  });

  it("refuses an officer without access to the case", async () => {
    const { fir412Pdf } = await import("@/server/seed/documents");
    const { makeTimeline } = await import("@/server/seed/timeline");
    const fir1Pdf = () => fir412Pdf(makeTimeline("2026-11-09"));
    const { confirmClearCandidates } = await import("@/server/services/extraction");
    const w = await buildWorld();
    const ev = await uploadEvidence(w.db, w.officer, w.kase.id, { fileName: "fir.pdf", buffer: fir1Pdf().buffer, category: "FIR_COPY", sourceDescription: "Test", receivedAt: new Date() }, { runExtraction: true });
    await expect(confirmClearCandidates(w.db, w.outsider, ev.id)).rejects.toThrow();
    expect(await w.db.extractionCandidate.count({ where: { evidenceId: ev.id, status: "ACCEPTED" } })).toBe(0);
  });
});
