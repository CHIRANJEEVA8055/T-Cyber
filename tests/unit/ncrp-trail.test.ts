import { describe, expect, it } from "vitest";
import { readTrailRows } from "@/domain/ncrp-trail";

// Synthetic values only, in the layout of the NCRP "money trail" (action taken by banks) export.
const HEAD = ["S No.", "Acknowledgement No.", "Transaction Id / UTR Number", "Layer", "Account No./ (Wallet /PG/PA) Id", "Action Taken By bank", "Bank/(Wallet /PG/PA) / Merchant / Insurance", "Account No", "Ifsc Code", "Cheque No", "MID", "TID", "Approval Code", "Merchant Name", "Transaction Date", "Transaction ID / UTR Number", "Transaction Amount", "Reference No", "Remarks", "Date of Action", "Action Taken By bank", "Action Taken By (Name)", "Action Taken By (Email)", "Branch Location", "Branch Manager Name & Contact Details", "Put on hold Amount", "Disputed Amount"];
const row = (o: Record<number, string>) => HEAD.map((_, i) => o[i] ?? "");

describe("reading an NCRP money-trail export", () => {
  const rows = [
    ["National Cyber Crime Reporting Portal - Money Trail"],
    [],
    HEAD,
    row({ 0: "1", 1: "31911250012345", 2: "UTRV0001", 3: "1", 4: "XXXXXXXX2093", 5: "Money Transfer to", 6: "Bank B", 7: "50100999887766", 8: "BKCC0001234", 14: "05-11-2026 10:32:00", 15: "UTRO0002", 16: "30,000.00", 26: "70000" }),
    row({ 0: "2", 1: "31911250012345", 2: "UTRV0001", 3: "1", 4: "XXXXXXXX2093", 5: "Transaction put on hold", 6: "Bank B", 14: "05-11-2026", 25: "₹ 20,000", 26: "70000" }),
    row({ 0: "3", 1: "31911250012345", 3: "2", 4: "50100999887766", 5: "Withdrawal through ATM", 6: "Bank C", 11: "ATM-KKP-01", 14: "06/11/2026 21:14", 16: "20000", 23: "Kukatpally" }),
    row({ 0: "4", 1: "31911250012345", 3: "2", 4: "50100999887766", 5: "Old Transaction", 6: "Bank C" }),
    row({ 0: "5", 3: "x", 5: "Money Transfer to" }),
  ];
  const r = readTrailRows(rows);

  it("finds the header row and the columns it knows", () => {
    expect(r.headerRow).toBe(3);
    expect(r.columns.map((c) => c.role)).toEqual(expect.arrayContaining(["layer", "fromAccount", "action", "toAccount", "toIfsc", "occurredAt", "utr", "amount", "holdAmount", "victimUtr", "disputed", "ack"]));
    expect(r.acks).toEqual(["31911250012345"]);
  });

  it("reads a transfer, a hold and an ATM withdrawal with their layers, amounts and times", () => {
    const [t, h, atm, other] = r.rows;
    expect(t).toMatchObject({ line: 4, layer: 1, action: "TRANSFER", from: { account: "XXXXXXXX2093", bank: "Bank B" }, to: { account: "50100999887766", ifsc: "BKCC0001234" }, utr: "UTRO0002", amountMinor: 3000000n, victimUtr: "UTRV0001", disputedMinor: 7000000n });
    expect(t!.occurredAt).toBe("2026-11-05T05:02:00.000Z");
    expect(h).toMatchObject({ action: "HOLD", holdMinor: 2000000n, to: null });
    expect(atm).toMatchObject({ layer: 2, action: "ATM", amountMinor: 2000000n, place: "Kukatpally", terminal: "ATM-KKP-01" });
    expect(atm!.occurredAt).toBe("2026-11-06T15:44:00.000Z");
    expect(other).toMatchObject({ action: "OTHER", actionText: "Old Transaction" });
  });

  it("lists rows it could not use, with the reason, instead of guessing", () => {
    expect(r.skipped).toEqual([{ line: 8, reason: "No account number in the row." }]);
  });

  it("refuses a sheet that is not a money trail", () => {
    expect(() => readTrailRows([["Name", "Phone"], ["A", "1"]])).toThrow(/does not look like an NCRP money-trail export/);
  });
});
