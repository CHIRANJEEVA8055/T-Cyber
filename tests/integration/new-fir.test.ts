import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { sampleFirPdf } from "@/server/seed/documents";
import { makeTimeline } from "@/server/seed/timeline";
import { readFirCopy } from "@/server/services/fir-reading";
import { openCaseFromFir, openCaseManually } from "@/server/services/fir-open";
import { buildPdf } from "@/server/documents/pdf-writer";

const T = makeTimeline("2026-11-09");
const sample = () => {
  const f = sampleFirPdf(T);
  return { name: f.fileName, buffer: f.buffer };
};

describe("reading an FIR copy in the New FIR window", () => {
  it("reports each step as it finishes and returns the brief, the details and the first steps", async () => {
    const events: string[] = [];
    const r = await readFirCopy(sample(), (e) => events.push(`${e.key}:${e.status}`));
    expect(events).toEqual(["read:start", "read:done", "brief:start", "brief:done", "classify:start", "classify:done", "details:start", "details:done", "plan:start", "plan:done"]);
    // The sample states no MO and the model is off in tests: the rules place it, and say the model was not available.
    expect(r.brief!.mo).toMatchObject({ key: "INVESTMENT", basis: "FACTS" });
    expect(r.brief!.vertical.why).toMatch(/^The local model was not available; read by the rules from the facts/);
    // Sections only as the copy states them.
    expect(r.brief!.sections).toEqual({ text: "BNS 318(4), IT Act 66D", stated: true });
    expect(r).toMatchObject({ readable: true, how: "TEXT", language: "English", modelUsed: null, pages: 1 });
    expect(r.brief!.headline).toBe("Investment-app fraud with one victim.");
    expect(r.steps.map((s) => s.title)).toContain("Hold request to Bank D on XXXXXXXXXXXX8810");
  });

  it("says plainly that a Telugu copy needs the local model, and that it is not running", async () => {
    const telugu = { name: "fir_te.txt", buffer: Buffer.from("ప్రథమ సమాచార నివేదిక\nఫిర్యాదుదారు 02-11-2026న రూ. 60,000 చెల్లించారు\n") };
    const r = await readFirCopy(telugu);
    expect(r).toMatchObject({ readable: false, language: "Telugu" });
    expect(r.note).toMatch(/in Telugu.*local model/);
    expect(r.note).toMatch(/enter the details by hand/);
  });

  it("asks for page images when a PDF has no text and no images", async () => {
    const blank = buildPdf([{ lines: [] }], { title: "blank" });
    const r = await readFirCopy({ name: "scan.pdf", buffer: blank });
    expect(r.readable).toBe(false);
    expect(r.note).toMatch(/no text layer/);
  });
});

describe("opening the case", () => {
  it("creates the FIR case from the copy, keeps the original with its hash, and reads it for checking", async () => {
    const w = await buildWorld();
    const { caseId } = await openCaseFromFir(w.db, w.officer, sample());
    const kase = await w.db.case.findUniqueOrThrow({ where: { id: caseId }, include: { assignments: true, claims: { include: { victim: true } } } });
    expect(kase).toMatchObject({ firNumber: 421, firYear: 2026, title: "Investment-app fraud", legalSections: "BNS 318(4), IT Act 66D", complaintRef: "33710260072290" });
    expect(kase.assignments[0]).toMatchObject({ userId: w.officer.id, role: "INVESTIGATING_OFFICER" });
    expect(kase.claims.map((c) => [c.victim.label, c.lossAmountMinor])).toEqual([["T. Ramesh", 6500000n]]);
    const fir = await w.db.evidenceItem.findFirstOrThrow({ where: { caseId, category: "FIR_COPY" } });
    expect(fir.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await w.db.extractionCandidate.count({ where: { evidenceId: fir.id } })).toBeGreaterThan(5);
    expect(await w.db.auditEvent.count({ where: { caseId, action: "fir.read" } })).toBe(1);
    // Placed in a vertical when it opened, with the basis and the reason kept and logged.
    expect(kase).toMatchObject({ moVertical: "INVESTMENT", moBasis: "FACTS" });
    expect(kase.moReason).toMatch(/read by the rules from the facts/);
    expect(await w.db.auditEvent.count({ where: { caseId, action: "case.mo_classified" } })).toBe(1);
  });

  it("refuses an FIR number that already exists, naming the case", async () => {
    const w = await buildWorld();
    await openCaseFromFir(w.db, w.officer, sample());
    await expect(openCaseFromFir(w.db, w.officer, sample())).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("FIR 421/2026") });
  });

  it("opens a case typed in by hand, recording the payment from the complainant's unstated account", async () => {
    const w = await buildWorld();
    const { caseId } = await openCaseManually(w.db, w.officer, {
      firNumber: "430",
      firYear: "2026",
      registeredOn: "2026-11-09",
      registeredTime: "10:05",
      sections: "BNS 318(4), IT Act 66C",
      victims: [{ name: "K. Padma", mobile: "+91-XXXXXXXX44" }],
      narrative: "A caller posing as bank customer care asked for the OTP and money left her account.",
      payments: [{ amount: "48,000", mode: "IMPS or NEFT", paidOn: "2026-11-07", to: "XXXXXXXXXXXX6120 BNKE0002010", reference: "IMPS4300480001" }],
      suspectPhones: "+91-XXXXXXXX61",
    });
    const kase = await w.db.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(kase).toMatchObject({ firNumber: 430, title: "OTP fraud" });
    const txn = await w.db.transaction.findFirstOrThrow({ where: { caseId }, include: { fromEntity: true, toEntity: true } });
    expect(txn).toMatchObject({ amountMinor: 4800000n, channel: "IMPS", kind: "VICTIM_PAYMENT" });
    expect(txn.fromEntity.label).toBe("K. Padma's account (not stated)");
    expect(txn.toEntity.value).toBe("XXXXXXXXXXXX6120");
    expect(await w.db.entity.count({ where: { caseId, kind: "PHONE" } })).toBe(2);
    expect(kase.registeredAt?.toISOString()).toBe("2026-11-09T04:35:00.000Z");
  });

  it("takes any FIR's details by hand: occurrence, place, victims with their own accounts, accused as stated, and keeps a prepared copy", async () => {
    const w = await buildWorld();
    const { caseId } = await openCaseManually(w.db, w.officer, {
      firNumber: "432",
      firYear: "2026",
      registeredOn: "2026-11-09",
      registeredTime: "16:40",
      gdEntry: "21",
      sections: "BNS 318(4), 319(2); IT Act 66D",
      occurredFrom: "2026-11-01T09:00",
      occurredTo: "2026-11-06T18:00",
      place: "Online; the complainant was at home in Kondapur",
      delayReason: "The complainant waited for the promised refund before reporting.",
      victims: [
        { name: "R. Lakshmi", relative: "W/o R. Kumar", age: "41", occupation: "Teacher", address: "Kondapur, Hyderabad", mobile: "+91-XXXXXXXX17", email: "lakshmi@example.invalid" },
        { name: "R. Kumar", mobile: "+91-XXXXXXXX18" },
      ],
      narrative: "The complainant joined a WhatsApp group that offered share market trading tips and invested through an app that showed profits she could not withdraw.",
      payments: [
        { amount: "1,20,000", mode: "IMPS or NEFT", paidOn: "2026-11-02", paidTime: "11:15", payer: "0", fromAccount: "XXXXXXXX4401", fromBank: "State Bank of India", to: "XXXXXXXXXXXX7731", toIfsc: "BNKE0003010", toBank: "Bank E", reference: "IMPS4320001" },
        { amount: "30,000", mode: "UPI", paidOn: "2026-11-04", payer: "1", to: "trader.desk@okbank", reference: "430212345678" },
      ],
      accused: [{ name: "Arjun", phones: "+91-XXXXXXXX90", accounts: "XXXXXXXXXXXX7731 IFSC BNKE0003010", profiles: "https://trade-app.example.invalid" }],
      moVertical: "INVESTMENT",
      moSubtype: "Trading",
    });
    const kase = await w.db.case.findUniqueOrThrow({ where: { id: caseId }, include: { claims: { include: { victim: true } } } });
    expect(kase).toMatchObject({ moVertical: "INVESTMENT", moSubtype: "Trading", legalSections: "BNS 318(4), 319(2); IT Act 66D" });
    expect(kase.registeredAt?.toISOString()).toBe("2026-11-09T11:10:00.000Z");
    expect(kase.incidentStart?.toISOString()).toBe("2026-11-01T03:30:00.000Z");
    // Each victim's loss is what they paid.
    expect(kase.claims.map((c) => [c.victim.label, c.lossAmountMinor]).sort()).toEqual([["R. Kumar", 3000000n], ["R. Lakshmi", 12000000n]]);
    // The accused's name is kept as stated, never as established.
    const phone = await w.db.entity.findFirstOrThrow({ where: { caseId, kind: "PHONE", value: "+91-XXXXXXXX90" } });
    expect(phone.caseRole).toBe("Accused 1 in the FIR: phone number; stated to be “Arjun” (per the FIR, not verified)");
    expect(JSON.parse(phone.attributesJson)).toMatchObject({ statedName: "Arjun" });
    expect(await w.db.entity.count({ where: { caseId, kind: "BANK_ACCOUNT", value: "XXXXXXXXXXXX7731" } })).toBe(1);
    // The complainant's own account is recorded with its number, as hers.
    const txn = await w.db.transaction.findFirstOrThrow({ where: { caseId, reference: "IMPS4320001" }, include: { fromEntity: true } });
    expect(txn.fromEntity).toMatchObject({ value: "XXXXXXXX4401", belongsTo: "VICTIM" });
    expect(txn.occurredAt.toISOString()).toBe("2026-11-02T05:45:00.000Z");
    // Own email and numbers are noted as the victims' own.
    expect((await w.db.entity.findFirstOrThrow({ where: { caseId, kind: "EMAIL" } })).caseRole).toBe("Complainant's own email");
    // The prepared copy is kept, marked as prepared, and is never the signed FIR a request can attach.
    const copy = await w.db.evidenceItem.findFirstOrThrow({ where: { caseId, category: "FIR_COPY" } });
    expect(copy).toMatchObject({ derivation: "PREPARED", title: "FIR 432/2026 (prepared from details entered by hand)" });
    expect(await w.db.evidenceItem.count({ where: { caseId, category: "FIR_COPY", derivation: "ORIGINAL" } })).toBe(0);
  });

  it("prints the copy without opening a case, saying on it that it was prepared by hand", async () => {
    const w = await buildWorld();
    const before = await w.db.case.count();
    const { manualFirCopy } = await import("@/server/services/fir-open");
    const { parseDocument } = await import("@/server/documents/parse");
    const r = await manualFirCopy(w.officer, { firNumber: "433", firYear: "2026", registeredOn: "2026-11-09", registeredTime: "09:30", victims: [{ name: "S. Ravi" }], narrative: "A caller posing as customer care asked for the OTP and money was debited.", accused: [{ name: "Vikram", phones: "+91-XXXXXXXX55" }] });
    const text = (await parseDocument(r.buffer, "application/pdf")).segments.map((x) => x.text).join("\n");
    expect(r.fileName).toBe("FIR_433_2026_prepared.pdf");
    expect(text).toContain("FIRST INFORMATION REPORT");
    expect(text).toContain("Prepared from details entered by hand");
    expect(text).toContain("not the CCTNS copy");
    expect(text).toContain('stated to be "Vikram"');
    expect(text).toContain("A caller posing as customer care asked for the OTP");
    expect(text).toContain("OTP Frauds");
    expect(await w.db.case.count()).toBe(before);
  });

  it("checks the details an officer is likely to mistype, field by field", async () => {
    const w = await buildWorld();
    const err = await openCaseManually(w.db, w.officer, {
      firNumber: "434",
      firYear: "2026",
      registeredOn: "2026-11-09",
      registeredTime: "",
      occurredFrom: "2026-11-10T09:00",
      victims: [{ name: "P. Rao", email: "p.rao@", age: "300" }],
      narrative: "Short.",
      payments: [{ amount: "abc", mode: "UPI", toIfsc: "SBIN123" }],
      accused: [{ phones: "call me" }],
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "VALIDATION" });
    expect(Object.keys(err.fieldErrors)).toEqual(expect.arrayContaining(["registeredTime", "victims.0.email", "victims.0.age", "narrative", "payments.0.amount", "payments.0.toIfsc", "accused.0.phones"]));
    expect(await w.db.case.count({ where: { firNumber: 434 } })).toBe(0);
  });

  it("asks for the complainant's name before opening a case by hand", async () => {
    const w = await buildWorld();
    await expect(openCaseManually(w.db, w.officer, { firNumber: "431", firYear: "2026", registeredOn: "2026-11-09", registeredTime: "10:00", narrative: "", victims: [{ name: "" }] })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: expect.objectContaining({ "victims.0.name": expect.any(String) }) });
  });
});
