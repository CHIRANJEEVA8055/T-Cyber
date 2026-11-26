import { buildPdf, type PdfLine } from "../documents/pdf-writer";
import type { DemoTimeline } from "./timeline";

/**
 * Synthetic demonstration documents. Every name, number, bank and address is fictional; phone numbers are masked
 * at source, email addresses use the reserved example.invalid domain and IP addresses come from the documentation
 * ranges. The facts the application shows are produced by reading these documents, so they must contain them.
 */

export interface SyntheticFile {
  fileName: string;
  buffer: Buffer;
}

const banner: PdfLine[] = [
  { text: "SYNTHETIC DEMONSTRATION DOCUMENT - NOT A REAL RECORD", bold: true, size: 9 },
  { text: "All names, numbers, banks and addresses are fictional. Phone numbers are masked.", size: 9 },
];
const SYNTH = "This is a synthetic message created for demonstration. It is not a real communication.";

// ── FIR 412/2026 ─────────────────────────────────────────────────────────────────────────────────────────────

/** Identifiers of the worked example, as the documents record them. */
export const F412 = {
  ack: "33710260048816",
  v1Phone: "+91-XXXXXXXX19",
  v2Phone: "+91-XXXXXXXX27",
  phone87: "+91-XXXXXXXX87",
  phone41: "+91-XXXXXXXX41",
  accountA: "XXXXXXXXXXXX4471",
  accountB: "XXXXXXXXXXXX2093",
  accountC: "XXXXXXXXXXXX7715",
  ifscA: "BNKA0001234",
  ifscB: "BNKB0000711",
  ifscC: "BNKC0004410",
  upiP1: "p1.trade@okbnka",
  upiV1: "v1.synthetic@okbnkv",
  upiV2: "v2.synthetic@okbnkv",
  utrV1: "630184620214",
  utrV2: "63018462?8?7",
  utrV2Bank: "BAUPI0099814",
  email: "anvi.k.statements@example.invalid",
  profile: "Anvi_K",
  ip: "203.0.113.42",
  holdB: "BB/412/0908",
  holdC: "BC/412/0411",
} as const;

export function fir412Pdf(T: DemoTimeline): SyntheticFile {
  const p1: PdfLine[] = [
    ...banner,
    { text: "FIRST INFORMATION REPORT (copy in English)", bold: true, size: 13, gapBefore: 8 },
    { text: "FIR No. 412/2026", bold: true, gapBefore: 4 },
    { text: "Police Station: PS Madhapur, Cyberabad (synthetic)" },
    { text: `Date and time of registration: ${T.docTime(-7, "11:40")} hrs` },
    { text: `Complaint reference: NCRP acknowledgement ${F412.ack} dated ${T.doc(-7)}` },
    { text: "Sections of law: BNS 318(4), IT Act 66D" },
    { text: "1. Complainant", bold: true, gapBefore: 6 },
    { text: "Name of complainant: Victim 1 (synthetic)" },
    { text: `Complainant's own mobile number: ${F412.v1Phone}` },
    { text: "Address: Madhapur, Hyderabad (synthetic)" },
    { text: "2. Occurrence", bold: true, gapBefore: 6 },
    { text: `Period of occurrence: ${T.docTime(-12, "21:14")} hrs to ${T.docTime(-7, "10:42")} hrs` },
    { text: "Place of occurrence: online, at the complainant's residence in Madhapur" },
  ];
  const p2: PdfLine[] = [
    ...banner,
    { text: "FIR No. 412/2026 (continued)", bold: true, gapBefore: 8 },
    { text: "3. Brief facts", bold: true, gapBefore: 6 },
    { text: `On ${T.doc(-15)} the complainant received a match on a dating application from a profile named "${F412.profile}".` },
    { text: `The conversation moved to WhatsApp, where the person messaged her from ${F412.phone87}.` },
    { text: "The person promised returns from a crypto investment plan and shared an email address" },
    { text: `${F412.email} for "statements".` },
    { text: `As instructed, the complainant paid to A/c No. ${F412.accountA}, IFSC ${F412.ifscA}, in the name of P1,` },
    { text: `through the UPI ID ${F412.upiP1}. The person called from ${F412.phone87} to confirm the payment.` },
    { text: "Second victim: Victim 2 (synthetic), introduced to the plan by the same person, paid into the same account." },
    { text: "4. Payments reported", bold: true, gapBefore: 6 },
    { text: `(a) ${T.docTime(-7, "10:42")} hrs: Rs. 60,000 paid by Victim 1 to A/c No. ${F412.accountA}, IFSC ${F412.ifscA}` },
    { text: `    (Bank A) by UPI, UPI reference ${F412.utrV1}` },
    { text: `(b) ${T.docTime(-7, "10:55")} hrs: Rs. 40,000 paid by Victim 2 to the same account by UPI,` },
    { text: `    UPI reference ${F412.utrV2} (two characters not legible in the receipt)` },
    { text: "Total amount lost: Rs. 1,00,000", bold: true },
    { text: "5. Documents produced: payment receipts (pages 3 and 4), WhatsApp chat export, NCRP acknowledgement.", gapBefore: 6 },
    { text: "Signature of complainant: (synthetic)        Registering officer: SI Krishna (synthetic)", gapBefore: 10 },
  ];
  const p3: PdfLine[] = [
    ...banner,
    { text: "FIR No. 412/2026 - Annexure: receipt 1 of 2", bold: true, gapBefore: 8 },
    { text: `UPI app screenshot, ${T.docTime(-7, "10:41")}.` },
    { text: `From: ${F412.upiV1} (Victim 1)` },
    { text: `Paid Rs. 60,000 to P1, UPI ID ${F412.upiP1}.` },
    { text: `UPI reference ${F412.utrV1}. Status: Success.` },
  ];
  const p4: PdfLine[] = [
    ...banner,
    { text: "FIR No. 412/2026 - Annexure: receipt 2 of 2", bold: true, gapBefore: 8 },
    { text: `Photo of a phone screen, Victim 2, ${T.docTime(-7, "10:55")}.` },
    { text: `From: ${F412.upiV2} (Victim 2)` },
    { text: `Paid Rs. 40,000 to the same UPI ID, ${F412.upiP1}.` },
    { text: `UPI reference ${F412.utrV2}. Two characters are hidden by screen glare; a clearer copy has been requested.` },
  ];
  return { fileName: "FIR_412_2026.pdf", buffer: buildPdf([{ lines: p1 }, { lines: p2 }, { lines: p3 }, { lines: p4 }], { title: "FIR 412/2026 (synthetic)" }) };
}

export function chatExport412(T: DemoTimeline): SyntheticFile {
  const m = (off: number, hhmm: string, who: string, text: string) => `${T.doc(off).replace(/-/g, "/")}, ${hhmm} - ${who}: ${text}`;
  const lines = [
    "SYNTHETIC DEMONSTRATION CHAT EXPORT - NOT A REAL RECORD",
    `WhatsApp chat with "Anvi" (${F412.phone87}), exported by Victim 1`,
    m(-12, "21:14", "Anvi", `Join the premium plan today, 18% monthly. I will send the statement to your mail from ${F412.email}`),
    m(-12, "21:20", "Victim 1", "How does it work?"),
    m(-12, "21:31", "Anvi", "You add funds, our desk trades crypto for you. Withdraw any time."),
    m(-11, "10:05", "Anvi", "Good morning. Today's returns were 2.1%."),
    m(-11, "19:48", "Anvi", "My friend's plan already doubled. Do not miss this."),
    m(-10, "09:12", "Anvi", "Sending you the plan brochure."),
    m(-10, "09:13", "Anvi", "<Media omitted>"),
    m(-9, "20:02", "Victim 1", "Can my friend also join?"),
    m(-9, "20:05", "Anvi", "Yes, the same account. I will guide her."),
    m(-8, "18:40", "Anvi", "Slots close tomorrow morning."),
    m(-7, "10:30", "Victim 1", "Ready to pay."),
    m(-7, "10:32", "Anvi", `Send to this account only: ${F412.accountA}, ${F412.ifscA}, name P1.`),
    m(-7, "10:43", "Victim 1", "Paid 60,000. Screenshot sent."),
    m(-7, "10:44", "Anvi", "Received. Your statement will come by mail."),
    m(-6, "08:02", "Anvi", "Your friend's payment is done too."),
    m(-6, "11:15", "Victim 1", "I want to withdraw."),
    m(-6, "11:40", "Anvi", "Withdrawal fee 30,000 first."),
    m(-6, "12:05", "Victim 1", "Why? Please return my money."),
  ];
  return { fileName: "WhatsApp_chat_Anvi.txt", buffer: Buffer.from(`${lines.join("\n")}\n`) };
}

export function ncrpAck412(T: DemoTimeline): SyntheticFile {
  const text = [
    "SYNTHETIC DEMONSTRATION DOCUMENT - NOT A REAL RECORD",
    "National Cybercrime Reporting Portal acknowledgement (synthetic)",
    `Acknowledgement number: ${F412.ack}`,
    `Date of complaint: ${T.docTime(-7, "11:02")} hrs`,
    "Category: Online financial fraud - Investment scam",
    "Complainant: Victim 1 (synthetic)",
    "Amount reported: Rs. 60,000",
    `Suspect account: A/c No. ${F412.accountA}`,
    "Status: forwarded to PS Madhapur, Cyberabad",
  ].join("\n");
  return { fileName: `NCRP_acknowledgement_${F412.ack}.txt`, buffer: Buffer.from(`${text}\n`) };
}

/** Bank A's statement of Account A: rows 12 and 14 are the victims' payments, 18 and 19 the onward transfers. */
export function bankAStatement412(T: DemoTimeline): SyntheticFile {
  const r = (off: number, time: string, desc: string, ref: string, acct: string, ifsc: string, bank: string, debit: string, credit: string) =>
    [T.doc(off), time, desc, ref, acct, ifsc, bank, debit, credit].join(",");
  const rows = [
    "Txn Date,Txn Time,Description,UTR/RRN,Counterparty A/c,Counterparty IFSC,Counterparty Bank,Debit,Credit",
    r(-14, "11:05", "Cash deposit", "", "", "", "", "", "500.00"),
    r(-13, "19:40", "UPI P2M grocery", "UPI88010", "", "", "", "149.40", ""),
    r(-13, "20:02", "UPI credit refund", "UPI88011", "", "", "", "", "49.40"),
    r(-12, "09:15", "UPI P2M recharge", "UPI88015", "", "", "", "199.00", ""),
    r(-11, "08:30", "UPI credit", "UPI88021", "", "", "", "", "100.00"),
    r(-11, "14:12", "UPI P2M food", "UPI88022", "", "", "", "52.20", ""),
    r(-10, "18:25", "UPI P2M transport", "UPI88027", "", "", "", "48.00", ""),
    r(-9, "07:55", "UPI credit", "UPI88031", "", "", "", "", "50.00"),
    r(-9, "21:10", "UPI P2M pharmacy", "UPI88035", "", "", "", "49.60", ""),
    r(-8, "12:00", "UPI P2M recharge", "UPI88040", "", "", "", "0.60", ""),
    r(-7, "10:42", "UPI credit", F412.utrV1, "", "", "", "", "60000.00"),
    r(-7, "10:43", "SMS alert charges", "", "", "", "", "2.36", ""),
    r(-6, "09:15", "UPI credit", F412.utrV2Bank, "", "", "", "", "40000.00"),
    r(-6, "23:40", "Account maintenance charges", "", "", "", "", "118.00", ""),
    r(-6, "23:40", "GST on charges", "", "", "", "", "21.24", ""),
    r(-6, "23:52", "Cheque book issue charges", "", "", "", "", "59.00", ""),
    r(-5, "00:31", "IMPS outward", "BA2026110400318", F412.accountB, F412.ifscB, "Bank B", "70000.00", ""),
    r(-5, "00:33", "IMPS outward", "BA2026110400322", F412.accountC, F412.ifscC, "Bank C", "30000.00", ""),
  ];
  return { fileName: "BankA_statement_XXXX4471.csv", buffer: Buffer.from(`${rows.join("\n")}\n`) };
}

export function bankAReplyBody412(T: DemoTimeline, reference: string): string[] {
  return [
    "Dear Sir/Madam,",
    `With reference to your request ${reference} dated ${T.doc(-7)} in FIR 412/2026, please find attached the statement of account A/c No. ${F412.accountA} for ${T.doc(-15)} to ${T.doc(-1)}.`,
    `A debit freeze has been marked on the account; available balance Rs. 0.00 as on ${T.docTime(-1, "13:30")} hrs.`,
    `Registered mobile: ${F412.phone41}`,
    "Regards, Nodal Officer, Bank A (synthetic)",
    SYNTH,
  ];
}

export function bankBHoldBody412(T: DemoTimeline, reference: string): string[] {
  return [
    `With reference to your request ${reference} in FIR 412/2026, a lien of Rs. 50,000.00 has been marked on A/c No. ${F412.accountB} as on ${T.docTime(-1, "11:02")} hrs.`,
    `Hold reference no. ${F412.holdB}`,
    `Before the lien, a cash withdrawal of Rs. 20,000.00 was made at an ATM in Kukatpally on ${T.doc(-4)} at 21:14 hrs. The ATM ID is not available with this office.`,
    "Account holder name: P2",
    "Address as per KYC: Kukatpally, Hyderabad (synthetic)",
    `Account opened on: ${T.doc(-56)}`,
    "Nodal Officer, Bank B (synthetic), via CFCFRMS",
    SYNTH,
  ];
}

export function bankCHoldBody412(T: DemoTimeline, reference: string): string[] {
  return [
    `With reference to your request ${reference} in FIR 412/2026, Rs. 30,000.00 is held under lien on A/c No. ${F412.accountC} as on ${T.docTime(-1, "11:06")} hrs.`,
    `Hold reference no. ${F412.holdC}`,
    "Nodal Officer, Bank C (synthetic), via CFCFRMS",
    SYNTH,
  ];
}

/** Bank C's hold confirmation covering four FIRs from three stations, with no request reference. */
export function bankCMultiFir(T: DemoTimeline): SyntheticFile {
  const rows = [
    "FIR No,Police Station,Account No,Hold Amount,Hold Reference,Debit Freeze Date",
    `412/2026,PS Madhapur,${F412.accountC},30000.00,${F412.holdC},${T.doc(0)}`,
    `388/2026,PS Gachibowli,XXXXXXXXXXXX6612,12000.00,BC/388/0101,${T.doc(0)}`,
    "290/2026,PS Miyapur,XXXXXXXXXXXX9015,8500.00,BC/290/0077,",
    `155/2026,PS Gachibowli,XXXXXXXXXXXX3380,41000.00,BC/155/0310,${T.doc(0)}`,
  ];
  return { fileName: "BankC_hold_confirmation_4_FIRs.csv", buffer: Buffer.from(`${rows.join("\n")}\n`) };
}

export function preservationReceiptBody412(T: DemoTimeline, reference: string): string[] {
  return [
    `Your preservation request ${reference} concerning the profile "${F412.profile}" has been processed. Portal reference LE-88213.`,
    `The records of the account are preserved until ${T.doc(88)}.`,
    `Last login IP address: ${F412.ip}`,
    "Message content is not available from the provider.",
    "Law Enforcement Response Team, Dating platform (synthetic)",
    SYNTH,
  ];
}

/** Call records of the number that messaged Victim 1: 1,214 rows, deterministic. */
export function cdr87(T: DemoTimeline): SyntheticFile {
  let seed = 412;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const daily = ["+91-XXXXXXXX41", "+91-XXXXXXXX63", "+91-XXXXXXXX08"];
  const others = Array.from({ length: 40 }, (_, i) => `+91-XXXXXXXX${String(10 + i * 2).padStart(2, "0")}`);
  const cells = ["CYB-MDP-0412A", "CYB-MDP-0412B", "CYB-KKP-0221C", "CYB-KKP-0221A", "CYB-GCB-0107B"];
  const rows: string[] = ["Call Date,Call Time,Calling Number,Called Number,Call Type,Duration (s),First Cell ID,IMEI"];
  const days = Array.from({ length: 19 }, (_, i) => -25 + i); // 15 Oct to 02 Nov when today is 09 Nov
  let n = 0;
  const pad = (v: number) => String(v).padStart(2, "0");
  for (const d of days) {
    const perDay = 64;
    for (let k = 0; k < perDay && n < 1214 - 2; k++) {
      const hh = 7 + Math.floor(rand() * 16);
      const mm = Math.floor(rand() * 60);
      const daily3 = k < 3 ? daily[k]! : null;
      const other = daily3 ?? others[Math.floor(rand() * others.length)]!;
      const outgoing = k < 3 || rand() > 0.45;
      rows.push([T.doc(d), `${pad(hh)}:${pad(mm)}:${pad(Math.floor(rand() * 60))}`, outgoing ? F412.phone87 : other, outgoing ? other : F412.phone87, rand() > 0.7 ? "SMS" : "VOICE", String(Math.floor(rand() * 600)), cells[Math.floor(rand() * cells.length)]!, "35XXXXXXXXXX614"].join(","));
      n++;
    }
  }
  rows.push([T.doc(-7), "10:36:12", F412.phone87, F412.v1Phone, "VOICE", "212", "CYB-KKP-0221C", "35XXXXXXXXXX614"].join(","));
  rows.push([T.doc(-7), "10:51:40", F412.phone87, F412.v1Phone, "VOICE", "95", "CYB-KKP-0221C", "35XXXXXXXXXX614"].join(","));
  return { fileName: "CDR_XXXX87.csv", buffer: Buffer.from(`${rows.join("\n")}\n`) };
}

export function caf87(T: DemoTimeline): SyntheticFile {
  const text = [
    "SYNTHETIC DEMONSTRATION DOCUMENT - NOT A REAL RECORD",
    "Customer Acquisition Form (summary)",
    `Mobile number: ${F412.phone87}`,
    "Subscriber name: Suresh K (synthetic)",
    "Address as per CAF: Kukatpally, Hyderabad (synthetic)",
    "ID proof type: Voter ID (number withheld in this copy)",
    `Activation date: ${T.doc(-28)}`,
    "Point of sale: retail outlet, Kukatpally (synthetic)",
  ].join("\n");
  return { fileName: "CAF_XXXX87.txt", buffer: Buffer.from(`${text}\n`) };
}

export function unicrossReplyBody412(T: DemoTimeline, reference: string): string[] {
  return [
    "Forwarded by the DD office to PS Madhapur.",
    `Sub: Reply to ${reference}, CDR and CAF, FIR 412/2026, mobile ${F412.phone87}`,
    `Please find enclosed the call detail records for ${T.doc(-25)} to ${T.doc(-7)} and the customer acquisition form.`,
    "IMEI history was not part of this reply.",
    "UNICROSS desk, Zonal ACP Madhapur (synthetic)",
    SYNTH,
  ];
}

export function npciAckBody412(reference: string): string[] {
  return [`Acknowledgement of your request ${reference} in FIR 412/2026. The request is under process.`, "UPI law-enforcement desk, NPCI (synthetic)", SYNTH];
}

// ── Other cases of the station ──────────────────────────────────────────────────────────────────────────────

export interface SimpleFir {
  number: number;
  registered: string; // "DD-MM-YYYY HH:MM"
  complaintRef: string | null;
  sections: string;
  complainant: string;
  facts: string[];
  payments: string[];
  total: string;
}

export function simpleFirPdf(f: SimpleFir): SyntheticFile {
  const lines: PdfLine[] = [
    ...banner,
    { text: "FIRST INFORMATION REPORT (copy in English)", bold: true, size: 13, gapBefore: 8 },
    { text: `FIR No. ${f.number}/2026`, bold: true, gapBefore: 4 },
    { text: "Police Station: PS Madhapur, Cyberabad (synthetic)" },
    { text: `Date and time of registration: ${f.registered} hrs` },
    ...(f.complaintRef ? [{ text: `Complaint reference: NCRP acknowledgement ${f.complaintRef}` }] : []),
    { text: `Sections of law: ${f.sections}` },
    { text: `Name of complainant: ${f.complainant}`, gapBefore: 6 },
    { text: "Brief facts", bold: true, gapBefore: 6 },
    ...f.facts.map((text) => ({ text })),
    { text: "Payments reported", bold: true, gapBefore: 6 },
    ...f.payments.map((text) => ({ text })),
    { text: `Total amount lost: ${f.total}`, bold: true },
  ];
  return { fileName: `FIR_${f.number}_2026.pdf`, buffer: buildPdf([{ lines }], { title: `FIR ${f.number}/2026 (synthetic)` }) };
}

export function npciBeneficiaries377(T: DemoTimeline): SyntheticFile {
  const rows = [
    "UTR,Amount,Txn Date,Status,Beneficiary Account,Beneficiary IFSC,Beneficiary Bank,VPA",
    `377011820311,"1,10,000.00",${T.doc(-24)},Found,XXXXXXXXXXXX5150,BNKE0002010,Bank E,jobs.desk@okbnke`,
    `377011820322,"95,000.00",${T.doc(-24)},Found,XXXXXXXXXXXX8842,BNKF0000318,Bank F,jobs.desk2@okbnkf`,
    `377011820347,"1,25,000.00",${T.doc(-23)},Not found,,,,`,
    `377011820359,"80,000.00",${T.doc(-23)},Not found,,,,`,
  ];
  return { fileName: "NPCI_beneficiaries_FIR377.csv", buffer: Buffer.from(`${rows.join("\n")}\n`) };
}

/** A fresh FIR copy (not in the demonstration data) for trying the New FIR window end to end. */
export function sampleFirPdf(T: DemoTimeline): SyntheticFile {
  const p1: PdfLine[] = [
    ...banner,
    { text: "FIRST INFORMATION REPORT (copy in English)", bold: true, size: 13, gapBefore: 8 },
    { text: "FIR No. 421/2026", bold: true, gapBefore: 4 },
    { text: "Police Station: PS Madhapur, Cyberabad (synthetic)" },
    { text: `Date and time of registration: ${T.docTime(0, "10:05")} hrs` },
    { text: `Complaint reference: NCRP acknowledgement 33710260072290 dated ${T.doc(-1)}` },
    { text: "Sections of law: BNS 318(4), IT Act 66D" },
    { text: "Name of complainant: T. Ramesh (synthetic)" },
    { text: "Complainant's own mobile number: +91-XXXXXXXX33" },
    { text: `Period of occurrence: ${T.docTime(-4, "19:30")} hrs to ${T.docTime(-2, "11:20")} hrs` },
    { text: "3. Brief facts", bold: true, gapBefore: 6 },
    { text: "The complainant was added to a Telegram group about stock tips run by a profile named \"MarketMentor_Ravi\"." },
    { text: "The admin, who called from +91-XXXXXXXX52, asked him to invest through an app and promised 12% weekly returns." },
    { text: "4. Payments reported", bold: true, gapBefore: 6 },
    { text: `(a) ${T.docTime(-2, "11:20")} hrs: Rs. 65,000 paid by T. Ramesh to A/c No. XXXXXXXXXXXX8810, IFSC BNKD0005120` },
    { text: "    (Bank D) by IMPS, UTR No. 630289105544" },
    { text: "Total amount lost: Rs. 65,000", bold: true },
  ];
  return { fileName: "FIR_421_2026_sample.pdf", buffer: buildPdf([{ lines: p1 }], { title: "FIR 421/2026 (synthetic sample)" }) };
}
