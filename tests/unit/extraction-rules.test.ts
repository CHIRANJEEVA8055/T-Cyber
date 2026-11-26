import { describe, expect, it } from "vitest";
import { extractFromLines, extractFromTable, parseCsv } from "@/domain/extraction";

const line = (text: string, lineNo = 1, page = 1) => ({ page, line: lineNo, row: null, text });

describe("extractFromLines", () => {
  it("extracts the FIR reference with its source location", () => {
    const [c] = extractFromLines([line("FIR No. 1/2026 registered at Cyber Crime PS (Demo)", 3, 1)]).filter(
      (x) => x.field === "FIR_REFERENCE",
    );
    expect(c).toMatchObject({ originalValue: "1/2026", page: 1, line: 3, uncertainty: "NONE" });
    expect(c?.structured).toEqual({ number: 1, year: 2026 });
  });

  it("extracts masked beneficiary account numbers and marks them as masked", () => {
    const out = extractFromLines([line("Rs. 10,00,000 transferred to beneficiary A/c No. XXXXXXXX4821, IFSC DEMA0001234")]);
    const acct = out.find((c) => c.field === "BANK_ACCOUNT");
    expect(acct).toMatchObject({ originalValue: "XXXXXXXX4821", uncertainty: "MASKED" });
    expect(acct?.roleHint).toBe("Reported beneficiary account");
    expect(out.find((c) => c.field === "IFSC")?.originalValue).toBe("DEMA0001234");
    expect(out.find((c) => c.field === "AMOUNT")?.structured).toEqual({ amountMinor: "100000000" });
  });

  it("preserves leading zeros exactly as written", () => {
    const acct = extractFromLines([line("Credited to A/c No. 004512000068 on the same day")]).find(
      (c) => c.field === "BANK_ACCOUNT",
    );
    expect(acct?.originalValue).toBe("004512000068");
    expect(acct?.normalizedValue).toBe("004512000068");
  });

  it("records the character span of each candidate for source highlighting", () => {
    const text = "Contact number used by caller: +91-XXXXXX4512";
    const phone = extractFromLines([line(text)]).find((c) => c.field === "PHONE");
    expect(phone).toBeDefined();
    expect(text.slice(phone!.charStart!, phone!.charEnd!)).toBe("+91-XXXXXX4512");
    expect(phone?.roleHint).toBe("Contact used by the caller / alleged fraudster");
  });

  it("does not guess a role when the line gives no basis", () => {
    const phone = extractFromLines([line("Phone: +91-98480-12345")]).find((c) => c.field === "PHONE");
    expect(phone?.roleHint ?? null).toBeNull();
    expect(phone?.uncertainty).toBe("AMBIGUOUS_ROLE");
  });

  it("separates emails from UPI handles", () => {
    const out = extractFromLines([line("Paid via UPI to demo.trader.a@okdemo; replies came from advisor.desk@tradeprime-demo.example.invalid")]);
    expect(out.find((c) => c.field === "UPI_ID")?.originalValue).toBe("demo.trader.a@okdemo");
    expect(out.find((c) => c.field === "EMAIL")?.originalValue).toBe("advisor.desk@tradeprime-demo.example.invalid");
  });

  it("extracts IPv4 addresses only when every octet is valid", () => {
    const out = extractFromLines([line("Login from IP 203.0.113.45 and version 1.2.3.999")]);
    expect(out.filter((c) => c.field === "IP_ADDRESS").map((c) => c.originalValue)).toEqual(["203.0.113.45"]);
  });

  it("flags amounts with malformed grouping instead of guessing", () => {
    const amt = extractFromLines([line("an amount of Rs. 1,00,00 was mentioned")]).find((c) => c.field === "AMOUNT");
    expect(amt?.uncertainty).toBe("UNCERTAIN_CHARACTERS");
    expect(amt?.structured).toBeUndefined();
  });

  it("extracts labelled names with a role hint from the label", () => {
    const person = extractFromLines([line("Name of complainant: Demo Victim K. Suresh (synthetic)")]).find(
      (c) => c.field === "PERSON_NAME",
    );
    expect(person?.originalValue).toBe("Demo Victim K. Suresh");
    expect(person?.roleHint).toBe("Complainant");
  });

  it("extracts date-times as IST and transaction references", () => {
    const out = extractFromLines([line("On 03-10-2026 11:42 hrs, UTR No. DEMOUTR0001 was generated")]);
    expect(out.find((c) => c.field === "DATE_TIME")?.structured).toEqual({ iso: "2026-10-03T06:12:00.000Z" });
    expect(out.find((c) => c.field === "TXN_REFERENCE")?.originalValue).toBe("DEMOUTR0001");
  });

  it("returns nothing for text with no recognisable identifiers", () => {
    expect(extractFromLines([line("The complainant stated the events in detail.")])).toEqual([]);
  });
});

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas and escaped quotes", () => {
    expect(parseCsv('a,b,c\n"1,000","say ""hi""",x\r\n')).toEqual([
      ["a", "b", "c"],
      ["1,000", 'say "hi"', "x"],
    ]);
  });
});

describe("extractFromTable", () => {
  it("turns recognised statement rows into transaction candidates with row references", () => {
    const rows = parseCsv(
      [
        "Txn Date,Description,Debit,Credit,UTR/RRN,Counterparty A/c,Counterparty IFSC",
        "03-10-2026 11:42,IMPS from victim,,\"10,00,000.00\",DEMOUTR0001,XXXXXXXX3390,DEMV0000001",
        "03-10-2026 13:05,IMPS onward,\"8,00,000.00\",,DEMOUTR0101,XXXXXXXX7714,DEMD0002222",
      ].join("\n"),
    );
    const result = extractFromTable(rows);
    expect(result.recognised).toBe(true);
    const txns = result.candidates.filter((c) => c.field === "TRANSACTION_ROW");
    expect(txns).toHaveLength(2);
    expect(txns[1]).toMatchObject({ row: 3, uncertainty: "MASKED" }); // counterparty account is masked in the source
    expect(txns[1]?.structured).toMatchObject({
      direction: "DEBIT",
      amountMinor: "80000000",
      counterpartyAccount: "XXXXXXXX7714",
      reference: "DEMOUTR0101",
      occurredAt: "2026-10-03T07:35:00.000Z",
    });
  });

  it("reads a bank's own statement layout: title rows first, its own headings, month names and an empty column", () => {
    const rows = [
      ["HDFC BANK LTD", "", "", "", "", ""],
      ["Statement of account for the period 01/10/2026 to 31/10/2026", "", "", "", "", ""],
      ["", "", "", "", "", ""],
      ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt."],
      ["03-Oct-2026", "IMPS-627611234567-RAMESH K-UTIB-XXXX9921", "627611234567", "03/10/26", "1,00,000.00", "0.00"],
      ["04/10/26", "NEFT CR-SALARY", "N2771234", "04/10/26", "", "45,000.00"],
    ];
    const result = extractFromTable(rows);
    expect(result.recognised).toBe(true);
    const txns = result.candidates.filter((c) => c.field === "TRANSACTION_ROW");
    expect(txns).toHaveLength(2);
    expect(txns[0]).toMatchObject({ row: 5 });
    expect(txns[0]?.structured).toMatchObject({ direction: "DEBIT", amountMinor: "10000000", reference: "627611234567", occurredAt: "2026-10-02T18:30:00.000Z" });
    expect(txns[1]?.structured).toMatchObject({ direction: "CREDIT", amountMinor: "4500000" });
  });

  it("reads the direction from a Dr/Cr column beside a single amount", () => {
    const rows = [
      ["Transaction Date", "Particulars", "UTR Number", "Amount", "Dr/Cr", "Beneficiary Account Number", "Beneficiary IFSC Code"],
      ["05-10-2026 14:02:11", "IMPS/P2A", "UTIBR52026100500", "2,50,000.00", "DR", "50100012346126", "HDFC0001234"],
    ];
    const t = extractFromTable(rows).candidates.find((c) => c.field === "TRANSACTION_ROW")!;
    expect(t.structured).toMatchObject({ direction: "DEBIT", amountMinor: "25000000", counterpartyAccount: "50100012346126", counterpartyIfsc: "HDFC0001234", reference: "UTIBR52026100500" });
  });

  it("reports unrecognised tables honestly instead of inventing columns", () => {
    const result = extractFromTable(parseCsv("foo,bar\n1,2\n"));
    expect(result.recognised).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/not recognised/i);
  });
});

describe("payments stated in text (FIR payment lines)", () => {
  const lines = [
    { page: 2, line: 4, row: null, text: "4. Payments reported by the complainant" },
    { page: 2, line: 5, row: null, text: "(a) 03-10-2026 11:42 hrs: Rs. 10,00,000 paid to A/c No. XXXXXXXX4821, IFSC DEMA0001234" },
    { page: 2, line: 6, row: null, text: "    (Demo Bank A) by IMPS, UTR No. DEMOUTR0001" },
    { page: 2, line: 11, row: null, text: "Total amount lost: Rs. 20,00,000" },
  ];

  it("reads a payment line as one payment with its date, amount, beneficiary, IFSC, mode and UTR", () => {
    const rows = extractFromLines(lines).filter((c) => c.field === "TRANSACTION_ROW");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      page: 2,
      line: 5,
      roleHint: "Payment reported by the complainant",
      normalizedValue: "DEMOUTR0001",
      structured: {
        occurredAt: "2026-10-03T06:12:00.000Z",
        amountMinor: "100000000",
        direction: "DEBIT",
        counterpartyAccount: "XXXXXXXX4821",
        counterpartyIfsc: "DEMA0001234",
        reference: "DEMOUTR0001",
        channel: "IMPS",
      },
    });
  });

  it("keeps the separate identifiers on the line and does not treat a stated total as a payment", () => {
    const c = extractFromLines(lines);
    expect(c.some((x) => x.field === "BANK_ACCOUNT" && x.originalValue === "XXXXXXXX4821")).toBe(true);
    expect(c.filter((x) => x.field === "TRANSACTION_ROW").every((x) => x.line !== 11)).toBe(true);
  });
});

describe("transaction references the copy does not show clearly", () => {
  const line = (text: string) => extractFromLines([{ page: 2, line: 9, row: null, text }]);

  it("reads a UPI reference with characters the receipt hides as uncertain, keeping the hidden characters unknown", () => {
    const ref = line("Paid Rs. 40,000 to the same UPI ID, UPI reference 63018462?8?7 (two characters not legible).").find((c) => c.field === "TXN_REFERENCE")!;
    expect(ref.originalValue).toBe("63018462?8?7");
    expect(ref.uncertainty).toBe("UNCERTAIN_CHARACTERS");
    expect(ref.uncertaintyNote).toMatch(/2 characters/);
  });

  it("reads a clear UPI reference as given", () => {
    const ref = line("Paid Rs. 60,000 by UPI, UPI reference 630184620214.").find((c) => c.field === "TXN_REFERENCE")!;
    expect(ref).toMatchObject({ originalValue: "630184620214", uncertainty: "NONE" });
  });
});

describe("reading the FIR 412/2026 wording", () => {
  const one = (text: string) => extractFromLines([{ page: 1, line: 1, row: null, text }]);

  it("reads a complainant named with a number, as synthetic victims are", () => {
    expect(one("Name of complainant: Victim 1 (synthetic)").find((c) => c.field === "PERSON_NAME")).toMatchObject({ originalValue: "Victim 1", roleHint: "Complainant" });
  });

  it("does not take an account the complainant paid to as her own", () => {
    expect(one("As instructed, the complainant paid to A/c No. XXXXXXXXXXXX4471, IFSC BNKA0001234, in the name of P1,").find((c) => c.field === "BANK_ACCOUNT")!.roleHint).toBe("Reported beneficiary account");
    expect(one("(a) 02-11-2026 10:42 hrs: Rs. 60,000 paid by Victim 1 to A/c No. XXXXXXXXXXXX4471").find((c) => c.field === "BANK_ACCOUNT")!.roleHint).toBe("Reported beneficiary account");
    expect(one("Complainant's own account: Bank V A/c No. XXXXXXXX3390").find((c) => c.field === "BANK_ACCOUNT")!.roleHint).toBe("Complainant's own account");
  });

  it("reads a UPI ID at the end of a sentence", () => {
    expect(one("Paid through the UPI ID p1.trade@okbnka. The person called back.").find((c) => c.field === "UPI_ID")?.originalValue).toBe("p1.trade@okbnka");
  });
});
