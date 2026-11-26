import { describe, expect, it } from "vitest";
import { compareAccounts, readCallRecords, readDocumentLines, readNarration, readStatement, selectable, type CaseKnowledge } from "@/domain/file-reading";
import { normalizeIdentifier } from "@/domain/identifiers";

// Synthetic records only: made-up accounts, numbers and names.
const ist = (s: string) => new Date(`${s}+05:30`);
const id = (id: string, kind: string, value: string, label: string, victim = false) => ({ id, kind, value, normalized: normalizeIdentifier(kind, value), label, victim });
const know: CaseKnowledge = {
  ids: [id("vic", "BANK_ACCOUNT", "30001234567", "Complainant's account", true), id("acctB", "BANK_ACCOUNT", "50100012342093", "Account B"), id("sus", "PHONE", "9876500041", "Caller's mobile"), id("comp", "PHONE", "9123400030", "Complainant's mobile", true)],
  txns: [{ id: "t1", fromId: "vic", toId: "acctB", amountMinor: 7_000_000n, occurredAt: ist("2026-11-05T10:30:00"), reference: "412345678901", kind: "VICTIM_PAYMENT" }],
  windowFrom: ist("2026-11-05T10:00:00"),
  windowTo: ist("2026-11-05T11:00:00"),
};

const statement = [
  ["EXAMPLE BANK LTD"],
  ["Statement of Account"],
  ["Account Name : RAMESH TRADERS"],
  ["Account No : 50100012342093", "", "IFSC : EXMP0001234"],
  ["Statement From : 01/11/2026 To : 15/11/2026"],
  [],
  ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["02/11/26", "UPI-SURESH-suresh@okexample-412300000001-RENT", "412300000001", "02/11/26", "", "1,200.00", "5,200.00"],
  ["05/11/26 10:32", "IMPS-412345678901-COMPLAINANT", "412345678901", "05/11/26", "", "70,000.00", "75,200.00"],
  ["05/11/26 11:05", "IMPS/P2A/412345678999/60200099887766/OTHERBANK", "412345678999", "05/11/26", "40,000.00", "", "35,200.00"],
  ["05/11/26 12:40", "ATM WDL/HYDERABAD/S1AW12345", "", "05/11/26", "20,000.00", "", "15,200.00"],
  ["05/11/26 14:10", "UPI-MULE TWO-mule2@ybl-412399999999-PAY", "412399999999", "05/11/26", "15,000.00", "", "200.00"],
  ["07/11/26", "POS PURCHASE GROCERY", "", "07/11/26", "150.00", "", "50.00"],
];

describe("reading a bank statement against the case", () => {
  it("keeps the complainant's payment and follows it out, leaving the other entries out", () => {
    const r = readStatement(statement, "acct-b-statement.xlsx", know)!;
    expect(r.kind).toBe("BANK_STATEMENT");
    expect(r.title).toBe("Bank statement of Account B");
    expect(r.total).toBe(6);
    expect(r.relevant).toBe(4);
    expect(r.leftOut).toMatch(/^2 entries have no link/);
    const types = r.proposals.map((p) => `${p.type}:${p.key}`);
    expect(types).toContain("CONFIRMS:R9:confirms");
    const out = r.proposals.find((p) => p.key === "R10:out");
    expect(out).toMatchObject({ type: "TRANSFER", from: { id: "acctB" }, amountMinor: "4000000", reference: "412345678999" });
    const acct = r.proposals.find((p) => p.type === "IDENTIFIER" && p.kind === "BANK_ACCOUNT");
    expect(acct).toMatchObject({ value: "60200099887766" });
    const cash = r.proposals.find((p) => p.type === "CASH");
    expect(cash).toMatchObject({ amountMinor: "2000000", place: "HYDERABAD", terminal: "S1AW12345" });
    const upi = r.proposals.find((p) => p.key === "R12:out");
    expect(upi?.text).toMatch(/₹10,000 of it is the complainant's money/);
    expect(r.proposals.some((p) => p.type === "IDENTIFIER" && p.value === "suresh@okexample")).toBe(false);
    expect(r.proposals.find((p) => p.type === "NAME")).toMatchObject({ name: "RAMESH TRADERS" });
    expect(r.insights.join(" ")).toMatch(/Balance after the last entry/);
  });

  it("adds nothing from a statement with no link to the case", () => {
    const rows = [["Account No : 11112222333344"], ["Date", "Narration", "Debit", "Credit"], ["01/11/2026", "SALARY", "", "50,000.00"], ["03/11/2026", "RENT UPI-x@ybl", "12,000.00", ""]];
    const r = readStatement(rows, "other.csv", know)!;
    expect(r.relevant).toBe(0);
    expect(r.proposals).toEqual([]);
    expect(r.summary).toMatch(/Nothing in this statement links to the FIR/);
  });

  it("a statement of a new account that paid a case account brings in that account", () => {
    const rows = [["Account No : 77778888999900"], ["Date", "Narration", "Debit", "Credit", "Ref No"], ["06/11/2026", "NEFT to 50100012342093", "5,000.00", "", "EXMPN52026110600001"]];
    const r = readStatement(rows, "new.csv", know)!;
    expect(r.proposals[0]).toMatchObject({ key: "S", type: "IDENTIFIER", value: "77778888999900" });
    expect(r.proposals.find((p) => p.type === "TRANSFER")).toMatchObject({ from: { key: "S" }, to: { id: "acctB" }, needs: ["S"] });
  });

  it("matches a masked account number by its last digits only when one case account fits", () => {
    expect(compareAccounts("XXXXXXXXXX2093", "50100012342093")).toBe("POSSIBLE");
    expect(compareAccounts("50100012342093", "50100012342093")).toBe("SAME");
    expect(compareAccounts("XXXX1111", "50100012342093")).toBeNull();
  });

  it("reads the other side of a narration", () => {
    const n = readNarration("UPI/DR/412345678901/RAVI/ravi.k@okexample/Payment");
    expect(n.upis).toEqual(["ravi.k@okexample"]);
    expect(n.digits).toContain("412345678901");
    // Hyphen-separated fields: the hyphen before the ID is not part of it.
    expect(readNarration("UPI-MULE TWO-mule.two@okbnkz-731900005678-PAY").upis).toEqual(["mule.two@okbnkz"]);
    expect(readNarration("Paid to ravi-k@okexample for goods").upis).toEqual(["ravi-k@okexample"]);
  });
});

describe("reading call records against the case", () => {
  const cdr = [
    ["CDR of target number 9876500041 from 01-11-2026 to 20-11-2026"],
    ["Target No", "B Party", "Date", "Time", "Duration", "Call Type", "IMEI", "First Cell ID", "First Cell Site Address"],
    ["9876500041", "9123400030", "05-11-2026", "10:01:00", "120", "OUT", "356789012345678", "40449-1234", "Madhapur, Hyderabad"],
    ["9876500041", "9000011111", "05-11-2026", "10:30:00", "30", "IN", "356789012345678", "40449-1234", "Madhapur, Hyderabad"],
    ["9876500041", "9123400030", "05-11-2026", "18:00:00", "60", "IN", "356789012345678", "40449-5678", "Kukatpally, Hyderabad"],
    ["9876500041", "9000022222", "20-11-2026", "09:00:00", "10", "OUT", "356789012345678", "40449-9999", "Gachibowli"],
  ];
  it("keeps contact with the case's numbers, the handset and the towers around the offence", () => {
    const r = readCallRecords(cdr, "cdr.xlsx", know)!;
    expect(r.kind).toBe("CALL_RECORDS");
    expect(r.title).toBe("Call records of Caller's mobile");
    const link = r.proposals.find((p) => p.type === "LINK" && p.rel === "CONTACTED");
    expect(link).toMatchObject({ a: { id: "sus" }, b: { id: "comp" } });
    expect(link?.text).toMatch(/in contact 2 times/);
    expect(r.proposals.find((p) => p.type === "IDENTIFIER" && p.kind === "DEVICE")).toMatchObject({ value: "356789012345678" });
    const places = r.proposals.filter((p) => p.type === "LOCATION").map((p) => (p.type === "LOCATION" ? p.place : ""));
    expect(places).toEqual(["Madhapur, Hyderabad, cell 40449-1234", "Kukatpally, Hyderabad, cell 40449-5678"]);
    expect(r.insights.join(" ")).toMatch(/not in the case, not added/);
  });
  it("adds nothing from the records of a number with no link to the case", () => {
    const rows = [cdr[1]!, ["9000033333", "9000044444", "05-11-2026", "10:01:00", "120", "OUT", "", "", ""]];
    const r = readCallRecords(rows, "x.csv", know)!;
    expect(r.proposals).toEqual([]);
    expect(r.summary).toMatch(/Nothing in these call records links to the FIR/);
  });
});

describe("reading a document against the case", () => {
  it("takes what is written next to a known account, and nothing far from it", () => {
    const lines = [
      "Reply to your letter about the account",
      "Account No: 50100012342093 is held by the customer below.",
      "Account holder name: Ramesh Kumar",
      "Registered mobile number 9988776655",
      "",
      "",
      "",
      "Branch helpline 9111111111",
    ].map((text, i) => ({ page: 1, line: i + 1, row: null, text }));
    const r = readDocumentLines(lines, "bank-letter.pdf", know);
    expect(r.proposals.find((p) => p.type === "MENTION")).toMatchObject({ entityId: "acctB" });
    expect(r.proposals.find((p) => p.type === "IDENTIFIER")).toMatchObject({ kind: "PHONE", value: expect.stringContaining("9988776655") });
    expect(r.proposals.find((p) => p.type === "NAME")).toMatchObject({ name: "Ramesh Kumar" });
    expect(r.proposals.some((p) => p.type === "IDENTIFIER" && p.value.includes("9111111111"))).toBe(false);
  });
  it("says so when a document has nothing to do with the case", () => {
    const r = readDocumentLines([{ page: 1, line: 1, row: null, text: "Circular about office timings. Call 9111111111." }], "circular.pdf", know);
    expect(r.proposals).toEqual([]);
    expect(r.summary).toMatch(/does not mention any account/);
  });
});

describe("choosing what to add", () => {
  it("drops what needs an item the officer left out", () => {
    const r = readStatement([["Account No : 77778888999900"], ["Date", "Narration", "Debit", "Credit", "Ref No"], ["06/11/2026", "NEFT to 50100012342093", "5,000.00", "", "EXMPN52026110600001"]], "new.csv", know)!;
    const transfer = r.proposals.find((p) => p.type === "TRANSFER")!;
    const { keep, dropped } = selectable(r.proposals, new Set([transfer.key]));
    expect(keep).toEqual([]);
    expect(dropped.map((p) => p.key)).toEqual([transfer.key]);
  });
});

describe("a statement that overlaps what the case already records", () => {
  it("confirms a recorded withdrawal instead of adding it again, and points to a card purchase", () => {
    const k: CaseKnowledge = { ...know, txns: [...know.txns, { id: "cash1", fromId: "acctB", toId: "cashE", amountMinor: 2_000_000n, occurredAt: ist("2026-11-05T12:41:00"), reference: null, kind: "CASH_WITHDRAWAL" }] };
    const rows = [...statement.slice(0, 11), ["05/11/26 15:00", "POS 4111XXXX1111 GROCERY MART", "", "05/11/26", "100.00", "", "100.00"]];
    const r = readStatement(rows, "acct-b.xlsx", k)!;
    expect(r.proposals.find((p) => p.key === "R11:confirms")).toMatchObject({ type: "CONFIRMS", transactionId: "cash1" });
    expect(r.proposals.some((p) => p.type === "CASH")).toBe(false);
    expect(r.insights.join(" ")).toMatch(/spent by card .* merchant's record/);
  });
});
