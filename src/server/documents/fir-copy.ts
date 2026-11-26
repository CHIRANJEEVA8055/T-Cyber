import { listOf, type ManualFir } from "@/contracts/manual-fir";
import { formatInr, parseRupeesToMinor } from "@/domain/money";
import { buildDocumentPdf, type DocLine } from "./document-pdf";
import { formatSections } from "@/domain/legal-sections";

/**
 * A printable copy of an FIR typed in by hand, laid out in the order of the CCTNS FIR form so it reads like one.
 * It says on every page that it was prepared from details entered by hand and is not the CCTNS copy: it carries no
 * signatures, and nothing in it is added beyond what the officer entered. Names the FIR gives the accused are
 * printed as stated, never as established.
 */

export interface FirCopyContext {
  stationName: string;
  district: string;
  preparedBy: string;
  preparedAt: Date;
  investigatingOfficer: string;
  /** The station's investigation vertical, with what it rests on ("Investment Frauds · Trading, from the facts: …"). */
  vertical: string | null;
}

const dmy = (iso: string) => iso.replace(/^(\d{4})-(\d{2})-(\d{2})/, "$3-$2-$1");
const dmyhm = (local: string) => dmy(local).replace("T", " ") + (local.includes("T") ? " hrs" : "");
const stamp = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(/\//g, "-").replace(",", "") + " hrs";
const NOT = "Not entered";

export function preparedFirLines(v: ManualFir, ctx: FirCopyContext): DocLine[] {
  const out: DocLine[] = [];
  const item = (n: string, label: string, value?: string | null) => out.push({ text: `${n}. ${label}: ${value || NOT}`, gapBefore: 6 });
  const sub = (label: string, value?: string | null) => out.push({ text: `${label}: ${value || NOT}`, indent: 18 });
  const subIf = (label: string, value?: string | null) => value && out.push({ text: `${label}: ${value}`, indent: 18 });

  out.push({ text: "FIRST INFORMATION REPORT", align: "center", bold: true, size: 14 });
  out.push({ text: `FIR No. ${v.firNumber}/${v.firYear} · ${ctx.stationName}, ${ctx.district}`, align: "center", bold: true, size: 11, gapBefore: 2 });
  out.push({ text: `Prepared from details entered by hand in T-CYBER by ${ctx.preparedBy} on ${stamp(ctx.preparedAt)}. This is not the CCTNS copy of the FIR and carries none of its signatures; check it against the registered FIR.`, size: 9, gapBefore: 8 });

  item("1", "District", ctx.district);
  sub("Police Station", ctx.stationName);
  sub("Year", v.firYear);
  sub("FIR No.", v.firNumber);
  sub("Date and time of FIR", `${dmy(v.registeredOn)} ${v.registeredTime} hrs`);
  item("2", "Acts & Section(s)", v.sections ? formatSections(v.sections) : v.sections);
  item("3", "Occurrence of offence", v.occurredFrom || v.occurredTo ? `${v.occurredFrom ? `from ${dmyhm(v.occurredFrom)}` : "start not entered"}${v.occurredTo ? ` to ${dmyhm(v.occurredTo)}` : ""}` : null);
  subIf("General Diary reference, entry no.", v.gdEntry);
  item("4", "Place of occurrence", v.place);

  const [c, ...others] = v.victims;
  item("5", "Complainant / Informant", c!.name);
  sub("Father's / husband's name", c!.relative);
  sub("Age", c!.age ? `${c!.age} years` : null);
  sub("Occupation", c!.occupation);
  sub("Address", c!.address);
  sub("Mobile", c!.mobile);
  sub("Email", c!.email);
  others.forEach((o, i) => {
    out.push({ text: `Victim ${i + 2}: ${o.name}`, indent: 18, gapBefore: 4 });
    for (const [k, val] of [["Father's / husband's name", o.relative], ["Age", o.age ? `${o.age} years` : undefined], ["Occupation", o.occupation], ["Address", o.address], ["Mobile", o.mobile], ["Email", o.email]] as const) if (val) out.push({ text: `${k}: ${val}`, indent: 36 });
  });

  const accused = v.accused.filter((a) => Object.values(a).some(Boolean));
  const legacy = [v.suspectPhones && `Phone numbers: ${v.suspectPhones}`, v.suspectProfiles && `Profiles or pages: ${v.suspectProfiles}`, v.suspectOther && `Emails or other accounts: ${v.suspectOther}`].filter(Boolean) as string[];
  item("6", "Details of known / suspected / unknown accused", accused.length || legacy.length ? (accused.length === 1 ? "one entry" : accused.length ? `${accused.length} entries` : "as below") : "None entered");
  accused.forEach((a, i) => {
    out.push({ text: `Accused ${i + 1}: ${a.name ? `stated to be "${a.name}" (as the complaint gives it; not verified)` : "name not known"}`, indent: 18, gapBefore: 4 });
    for (const [k, val] of [["Phone numbers", a.phones], ["Email addresses", a.emails], ["Accounts or UPI IDs", a.accounts], ["Profiles, websites or apps", a.profiles], ["Address", a.address]] as const) if (val) out.push({ text: `${k}: ${listOf(val).join(", ")}`, indent: 36 });
  });
  for (const l of legacy) out.push({ text: l, indent: 18 });

  item("7", "Reasons for delay in reporting", v.delayReason);

  const pays = v.payments.filter((p) => p.amount);
  item("8", "Particulars of properties (payments)", pays.length ? (pays.length === 1 ? "one payment" : `${pays.length} payments`) : "None entered");
  let total = 0n;
  pays.forEach((p, i) => {
    const amt = parseRupeesToMinor(p.amount);
    if (amt.ok) total += amt.value;
    const payer = v.victims[Number(p.payer ?? 0)]?.name ?? c!.name;
    const from = p.fromAccount || p.fromBank ? ` from ${p.fromAccount ? `account ${p.fromAccount}` : "an account"}${p.fromBank ? ` (${p.fromBank})` : ""}` : "";
    const to = p.to ? ` to ${p.to}${p.toIfsc || p.toBank ? ` (${[p.toIfsc ? `IFSC ${p.toIfsc.toUpperCase()}` : "", p.toBank ?? ""].filter(Boolean).join(", ")})` : ""}` : " to an account not entered";
    const when = p.paidOn ? `${dmy(p.paidOn)}${p.paidTime ? ` ${p.paidTime} hrs` : ""}: ` : "";
    out.push({ text: `(${i + 1}) ${when}${amt.ok ? formatInr(amt.value) : p.amount} paid by ${payer}${from}${to} by ${p.mode}${p.reference ? `, reference ${p.reference}` : ""}.`, indent: 18 });
  });
  item("9", "Total value of property", pays.length ? formatInr(total) : null);
  item("10", "NCRP acknowledgement", v.ack);

  out.push({ text: "11. First information contents:", gapBefore: 8, bold: true });
  for (const para of v.narrative.split(/\n{2,}/)) out.push({ text: para.trim(), gapBefore: 4 });

  item("12", "Investigating officer", ctx.investigatingOfficer);
  if (ctx.vertical) out.push({ text: `Investigation vertical in T-CYBER: ${ctx.vertical}.`, size: 9, gapBefore: 10 });
  return out;
}

export function preparedFirPdf(v: ManualFir, ctx: FirCopyContext): Buffer {
  return buildDocumentPdf(preparedFirLines(v, ctx), {
    title: `FIR ${v.firNumber}/${v.firYear} (prepared from details entered by hand)`,
    producer: "T-CYBER",
    watermark: null,
    footer: `FIR ${v.firNumber}/${v.firYear} - prepared from details entered by hand; not the CCTNS copy`,
  });
}
