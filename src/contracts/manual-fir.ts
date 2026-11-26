import { z } from "zod";
import { parseRupeesToMinor } from "@/domain/money";

/**
 * An FIR typed in by hand in the New FIR window (no copy, or a copy the reader cannot use). The fields follow the
 * CCTNS FIR form so any FIR can be entered: registration, acts and sections, occurrence, place, delay, the
 * complainant and other victims, the accused as the FIR describes them, the payments, and the first information.
 * Shared by the form (client) and the server, which checks it again.
 */

const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
// Digits, with X or * for a masked part, and an optional +91; spaces and dashes are allowed.
const PHONE = /^\+?[\dXx*][\dXx*\s-]{6,18}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const PAYMENT_MODES = ["UPI", "IMPS or NEFT", "RTGS", "Card", "Net banking", "Cash deposit", "Crypto or wallet", "Other"] as const;

export const manualVictimSchema = z.object({
  name: z.string().trim().min(2, "Enter the name as written in the FIR.").max(120),
  /** Father's or husband's name, as the FIR gives it. */
  relative: text(120),
  age: text(3),
  occupation: text(120),
  address: text(400),
  mobile: text(24),
  email: text(120),
});

export const manualAccusedSchema = z.object({
  /** The name the FIR gives the accused ("stated to be"): never treated as verified. */
  name: text(120),
  phones: text(400),
  emails: text(400),
  /** Bank accounts or UPI IDs, with the bank or IFSC where the FIR gives it. */
  accounts: text(600),
  /** Social-media profiles, handles, websites and app names. */
  profiles: text(600),
  address: text(400),
});

export const manualPaymentSchema = z.object({
  amount: z.string().trim().max(30),
  mode: z.string().trim().max(30),
  paidOn: text(10),
  paidTime: text(5),
  /** Which victim paid: the index into the victims list ("0" is the complainant). */
  payer: text(3),
  fromAccount: text(60),
  fromBank: text(120),
  to: text(120),
  toIfsc: text(20),
  toBank: text(120),
  reference: text(60),
});

export const manualFirSchema = z
  .object({
    firNumber: z.string().trim().regex(/^\d{1,6}$/, "Enter the FIR number (digits only)."),
    firYear: z.string().trim().regex(/^\d{4}$/, "Enter the year."),
    registeredOn: z.string().trim().regex(DATE, "Enter the date the FIR was registered."),
    registeredTime: z.string().trim().regex(TIME, "Enter the time the FIR was registered, as on the FIR."),
    gdEntry: text(40),
    sections: text(300),
    ack: text(40),
    occurredFrom: text(16),
    occurredTo: text(16),
    place: text(400),
    delayReason: text(1000),
    victims: z.array(manualVictimSchema).min(1, "Enter the complainant.").max(20),
    narrative: z.string().trim().min(20, "Enter the first information (the brief facts) as the FIR records it.").max(20000),
    payments: z.array(manualPaymentSchema).max(100).default([]),
    accused: z.array(manualAccusedSchema).max(30).default([]),
    // Older single-line fields, still accepted.
    suspectPhones: z.string().trim().max(400).default(""),
    suspectProfiles: z.string().trim().max(400).default(""),
    suspectOther: z.string().trim().max(400).default(""),
    moVertical: text(20),
    moSubtype: text(60),
  })
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    for (const k of ["occurredFrom", "occurredTo"] as const) if (v[k] && !DATETIME.test(v[k]!)) issue([k], "Enter a date and time.");
    if (v.occurredFrom && v.occurredTo && v.occurredFrom > v.occurredTo) issue(["occurredTo"], "The end of the occurrence is before its start.");
    const registered = `${v.registeredOn}T${v.registeredTime}`;
    if (v.occurredFrom && DATE.test(v.registeredOn) && v.occurredFrom > registered) issue(["occurredFrom"], "The occurrence starts after the FIR was registered. Check both.");
    v.victims.forEach((x, i) => {
      if (x.mobile && !PHONE.test(x.mobile)) issue(["victims", i, "mobile"], "Enter the mobile number as written, like +91 98XXXXXX10.");
      if (x.email && !EMAIL.test(x.email)) issue(["victims", i, "email"], "Enter an email address like name@domain.in.");
      if (x.age && !(/^\d{1,3}$/.test(x.age) && Number(x.age) > 0 && Number(x.age) < 120)) issue(["victims", i, "age"], "Enter the age in years.");
    });
    v.payments.forEach((p, i) => {
      const filled = Object.entries(p).some(([k, val]) => k !== "mode" && k !== "payer" && !!val);
      if (!filled) return;
      if (!p.amount) issue(["payments", i, "amount"], "Enter the amount paid, or remove this payment.");
      else if (!parseRupeesToMinor(p.amount).ok) issue(["payments", i, "amount"], "Enter the amount in rupees, like 48,000.");
      if (p.paidOn && !DATE.test(p.paidOn)) issue(["payments", i, "paidOn"], "Enter the date of the payment.");
      if (p.paidTime && !TIME.test(p.paidTime)) issue(["payments", i, "paidTime"], "Enter the time, like 14:30.");
      if (p.payer && !(Number(p.payer) >= 0 && Number(p.payer) < v.victims.length)) issue(["payments", i, "payer"], "Choose who paid.");
      if (p.toIfsc && !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(p.toIfsc)) issue(["payments", i, "toIfsc"], "Enter the 11-character IFSC, like SBIN0001234.");
    });
    v.accused.forEach((a, i) => {
      for (const ph of (a.phones ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)) if (!PHONE.test(ph)) issue(["accused", i, "phones"], `“${ph.slice(0, 24)}” does not look like a phone number. Separate numbers with commas.`);
      for (const em of (a.emails ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) if (!EMAIL.test(em)) issue(["accused", i, "emails"], `“${em.slice(0, 30)}” does not look like an email address.`);
    });
  });

export type ManualFirInput = z.input<typeof manualFirSchema>;
export type ManualFir = z.output<typeof manualFirSchema>;

/** Splits a list typed into one box ("a, b; c") into its items. */
export const listOf = (s: string | undefined) => (s ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
