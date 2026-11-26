import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { describeTrail, importNcrpTrail, readTrailFile } from "@/server/services/ncrp-trail";

/** The NCRP money-trail export added to a case: accounts, layers, transfers, withdrawals and holds. Synthetic data. */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const CSV = [
  "S No.,Acknowledgement No.,Transaction Id / UTR Number,Layer,Account No./ (Wallet /PG/PA) Id,Action Taken By bank,Bank/(Wallet /PG/PA) / Merchant / Insurance,Account No,Ifsc Code,TID,Transaction Date,Transaction ID / UTR Number,Transaction Amount,Branch Location,Put on hold Amount,Disputed Amount",
  "1,31911250099001,UTRNCRPV01,1,'771100223344,Money Transfer to,Test Bank One,'882200334455,SBIN0001234,,05-11-2026 10:32,UTRNCRPO01,\"40,000.00\",,,90000",
  "2,31911250099001,UTRNCRPV01,1,'771100223344,Transaction put on hold,Test Bank One,,,,05-11-2026 11:00,,,,\"25,000\",90000",
  "3,31911250099001,,2,'882200334455,Withdrawal through ATM,Test Bank Two,,,ATM-T-9,06-11-2026 21:14,,15000,Ameerpet,,",
  "4,31911250099001,,2,'882200334455,Money Transfer to,Test Bank Two,7766@okaxis,,,06-11-2026 22:00,UTRNCRPO02,5000,,,",
  "5,31911250099001,,2,,Money Transfer to,Test Bank Two,,,,,,,,,",
].join("\n");
const file = { fileName: "ncrp-trail.csv", buffer: Buffer.from(CSV, "utf8") };
let caseId = "";

beforeAll(async () => {
  caseId = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("NCRP money-trail export", () => {
  it("is read and summed up before anything is stored", () => {
    const p = describeTrail(readTrailFile(file.fileName, file.buffer));
    expect(p).toMatchObject({ rowCount: 4, layers: [1, 2], accounts: 3, transfers: { count: 2 }, holds: { count: 1, total: "₹25,000" }, cash: { count: 1, total: "₹15,000" }, acks: ["31911250099001"] });
    expect(p.skipped).toEqual([{ line: 6, reason: "No account number in the row." }]);
    expect(p.rows[0]!.text).toMatch(/^771100223344 \(Test Bank One\) sent ₹40,000 to 882200334455/);
  });

  it("refuses an old .xls or an unrelated sheet plainly", () => {
    expect(() => readTrailFile("trail.xls", Buffer.from("x"))).toThrow(/save it as \.xlsx/);
    expect(() => readTrailFile("x.csv", Buffer.from("Name,Phone\nA,1"))).toThrow(/does not look like an NCRP money-trail export/);
  });

  it("adds the accounts, layered transfers, the ATM withdrawal and the hold to the case, traced to their rows", async () => {
    const r = await importNcrpTrail(db, await user("officer1"), caseId, file);
    expect(r).toMatchObject({ accountsAdded: 3, transfers: 2, cashWithdrawals: 1, holds: 1, victimPayments: 1 });
    expect(r.notes).toContain("Row 6: No account number in the row.");
    const onward = await db.transaction.findFirstOrThrow({ where: { caseId, reference: "UTRNCRPO01" }, include: { fromEntity: true, toEntity: true } });
    expect(onward).toMatchObject({ layer: 2, kind: "ONWARD_TRANSFER", status: "REPORTED_ON_NCRP", amountMinor: 4000000n });
    expect(onward.fromEntity.value).toBe("771100223344");
    expect(onward.toEntity.value).toBe("882200334455");
    const upi = await db.transaction.findFirstOrThrow({ where: { caseId, reference: "UTRNCRPO02" }, include: { toEntity: true } });
    expect(upi).toMatchObject({ layer: 3 });
    expect(upi.toEntity.kind).toBe("UPI_ID");
    const cash = await db.transaction.findFirstOrThrow({ where: { caseId, kind: "CASH_WITHDRAWAL", reference: "ATM-T-9" } });
    expect(cash).toMatchObject({ layer: 3, amountMinor: 1500000n });
    expect(await db.locationObservation.count({ where: { caseId, locationText: "ATM, Ameerpet" } })).toBe(1);
    const hold = await db.hold.findFirstOrThrow({ where: { caseId, holdKey: { startsWith: "NCRP:" } } });
    expect(hold).toMatchObject({ status: "CONFIRMED_HELD", confirmedAmountMinor: 2500000n, bankReference: "NCRP ack 31911250099001" });
    const ev = await db.evidenceItem.findUniqueOrThrow({ where: { id: r.evidenceId } });
    expect(ev.category).toBe("TRANSACTION_RECORD");
    expect(await db.sourceAssertion.count({ where: { evidenceId: r.evidenceId, subjectType: "TRANSACTION", subjectId: onward.id, row: 2 } })).toBe(1);
    const victimPay = await db.transaction.findFirstOrThrow({ where: { caseId, reference: "UTRNCRPV01" } });
    expect(victimPay).toMatchObject({ kind: "VICTIM_PAYMENT", layer: 1, amountMinor: 9000000n });
  });

  it("adds nothing new when the same export is added again", async () => {
    const before = await db.transaction.count({ where: { caseId } });
    const r = await importNcrpTrail(db, await user("officer1"), caseId, file);
    expect(r).toMatchObject({ accountsAdded: 0, transfers: 0, cashWithdrawals: 0, holds: 0, victimPayments: 0 });
    expect(await db.transaction.count({ where: { caseId } })).toBe(before);
  });

  it("is refused for a case the officer cannot work on", async () => {
    const outsider = await db.user.findFirstOrThrow({ where: { role: "OFFICER", assignments: { none: { caseId } } } });
    await expect(importNcrpTrail(db, await user(outsider.username), caseId, file)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
