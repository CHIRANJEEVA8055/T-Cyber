import type { Db } from "../db";
import { istInputToUtc } from "@/domain/time";

/**
 * The approved sources the assistants answer from. These are ILLUSTRATIVE SUMMARIES written for this
 * demonstration, not the issued texts: each says so, and the issued document is always the authority. Section
 * numbers are the ones the assistants cite. Bharatiya Sakshya Adhiniyam 2023 s. 63 and the provider pages are real
 * sources summarised in plain words; the SOP, the I4C guide and the two circulars are stand-ins for the station's
 * own copies, which a station would load in their place.
 */
const ILLUSTRATIVE = "Illustrative summary for this demonstration. The issued document is the authority; check it before acting.";

interface DocInput {
  title: string;
  docNumber: string;
  issuingBody: string;
  jurisdiction: string;
  version: string;
  effectiveFrom: string;
  status: "CURRENT" | "SUPERSEDED";
  summary: string;
  reviewNote?: string;
  sections: { ref: string; heading: string; text: string; topics: string[] }[];
}

async function doc(db: Db, d: DocInput, supersededById: string | null = null) {
  return db.knowledgeDocument.create({
    data: {
      title: d.title,
      docNumber: d.docNumber,
      issuingBody: d.issuingBody,
      jurisdiction: d.jurisdiction,
      version: d.version,
      effectiveFrom: istInputToUtc(d.effectiveFrom)!,
      status: d.status,
      supersededById,
      summary: `${d.summary} ${ILLUSTRATIVE}`,
      reviewNote: d.reviewNote ?? null,
      isSynthetic: true,
      category: /Adhiniyam|Sanhita/.test(d.title) || /BSA/.test(d.docNumber) ? "LAW" : /provider|platform polic/i.test(d.title) ? "PROVIDER" : /circular/i.test(d.title) || /^Cir/i.test(d.docNumber) ? "CIRCULAR" : "SOP",
      publishedAt: istInputToUtc(d.effectiveFrom)!,
      sections: { create: d.sections.map((s, i) => ({ sectionRef: s.ref, heading: s.heading, text: s.text, topicsJson: JSON.stringify(s.topics), sortOrder: i })) },
    },
  });
}

export async function seedKnowledge(db: Db) {
  await doc(db, {
    title: "CFCFRMS / NCRP SOP 2026",
    docNumber: "SOP 2026",
    issuingBody: "Ministry of Home Affairs",
    jurisdiction: "India",
    version: "2026.09",
    effectiveFrom: "2026-09-23T00:00",
    status: "CURRENT",
    summary: "How a financial cyber-fraud complaint moves from the NCRP portal or the 1930 helpline to the bank, the police station and the court.",
    sections: [
      { ref: "§1", heading: "Purpose and scope", text: "Sets out how a financial cyber-fraud complaint moves from the NCRP portal or the 1930 helpline to the bank, the police station and the court, and what each party must do. It applies to every reporting bank, wallet and payment intermediary on the CFCFRMS platform.", topics: ["scope", "cfcfrms", "ncrp"] },
      { ref: "§4", heading: "Reporting and the first hours", text: "A complaint logged on NCRP or through 1930 receives an acknowledgement number that follows the money through every hop. The receiving bank acts on the first hold request on the strength of that number alone; the FIR follows and is attached to the same record. For a fast-moving fraud the quick step is the hold through CFCFRMS, which does not wait for any platform.", topics: ["first-actions", "hold", "ncrp", "acknowledgement", "urgent", "fast"] },
      { ref: "§5.1", heading: "Hold", text: "A hold is a lien on a stated amount; the rest of the account keeps working. It follows from the NCRP acknowledgement alone. A hold on an empty account counts for nothing, so banks confirm the amount actually available, not the amount requested.", topics: ["hold", "lien", "amounts", "restriction-vs-hold"] },
      { ref: "§5.2", heading: "Restriction", text: "A restriction stops all debits on the account. The bank applies it on a written police request with the FIR when the account is shown to have received fraud proceeds in more than one complaint, or on its own risk finding. Confirm each hold and the amount actually available before relying on it.", topics: ["restriction", "debit-freeze", "restriction-vs-hold", "hold"] },
      { ref: "§5.3", heading: "Seizure", text: "Seizure needs a court order and transfers control of the money; it is not a bank action.", topics: ["seizure", "court", "restriction-vs-hold"] },
      { ref: "§6", heading: "Tracing through the layers", text: "Each beneficiary bank reports onward transfers from a held account within the stated period, so the investigating officer can place the next hold. Every hop is recorded against the same acknowledgement number.", topics: ["tracing", "layers", "onward-transfer", "hold"] },
      { ref: "§7.1", heading: "Restoration: one identified victim", text: "Where a single identified victim's money is held, restoration goes through the Money Restoration Module with the hold confirmation and the victim's bank proof attached.", topics: ["restoration", "refund", "single-victim"] },
      { ref: "§7.2", heading: "Restoration: disputed amount or claim", text: "Where the amount or the claim is disputed, the conditional routes apply and the dispute is recorded before any application is filed.", topics: ["restoration", "refund", "dispute"] },
      { ref: "§7.3", heading: "Restoration: more than one victim", text: "For more than one victim the multiple-victim process applies. Record every claim against the account with its supporting transaction. (b) Where claims exceed or compete for the held amount, the interim custody application goes through the jurisdictional court with the bank's confirmation attached. No fixed allocation formula between victims is prescribed; the officer records the basis chosen.", topics: ["restoration", "multiple-victims", "allocation", "mixed-funds", "court", "two-victims"] },
      { ref: "§8", heading: "Records and reporting", text: "Every request, confirmation and order is kept with the acknowledgement number, and the station reports held, restored and pending amounts monthly.", topics: ["records", "reporting"] },
    ],
  });
  await doc(db, {
    title: "Money Restoration Module guide",
    docNumber: "I4C MRM guide",
    issuingBody: "Indian Cyber Crime Coordination Centre (I4C)",
    jurisdiction: "India",
    version: "April 2026",
    effectiveFrom: "2026-04-01T00:00",
    status: "CURRENT",
    summary: "Filing for the release of held funds to a victim on the CFCFRMS platform.",
    sections: [
      { ref: "§1", heading: "What the module does", text: "The Money Restoration Module on the CFCFRMS platform lets the investigating officer file for the release of held funds to the victim without a separate paper application to the bank, and tracks the application until the credit is confirmed.", topics: ["restoration", "mrm", "refund"] },
      { ref: "§2", heading: "Who can apply and when", text: "The application needs an FIR, a confirmed hold with the bank's reference, and an identified victim whose claim matches a specific credit into the held account. Where more than one victim claims the same held amount, the court route in SOP 2026 §7.3 applies first.", topics: ["restoration", "eligibility", "multiple-victims"] },
      { ref: "§3", heading: "Documents to attach", text: "The FIR copy, the hold confirmation from the bank, the victim's bank proof and identity, and the court order where one was required. Each document is hashed on upload and the hash appears on the application.", topics: ["restoration", "documents", "hash"] },
      { ref: "§4", heading: "Bank confirmation and the court order", text: "The bank confirms the available amount inside the module. Where a court order is needed, the order is uploaded against the application and the bank acts on it directly; no separate letter is required.", topics: ["restoration", "court", "bank"] },
      { ref: "§5", heading: "Tracking and confirmation of credit", text: "The module shows the application's stage and the date the victim's bank confirmed the credit. Only that confirmation counts as money returned in the ledger.", topics: ["restoration", "credit", "returned"] },
    ],
  });
  const old = await doc(db, {
    title: "UNICROSS request circular, Cir. 09/2025",
    docNumber: "Cir. 09/2025",
    issuingBody: "Telangana Police",
    jurisdiction: "Telangana",
    version: "09/2025",
    effectiveFrom: "2025-06-15T00:00",
    status: "SUPERSEDED",
    summary: "In force 15 Jun 2025 to 29 Feb 2026. Kept so older requests can be read against the rules that applied to them.",
    sections: [
      { ref: "§1", heading: "Route", text: "Requests went from the station through the SDPO to UNICROSS, with replies to the SDPO office. This route no longer applies.", topics: ["unicross", "route", "cdr"] },
      { ref: "§2", heading: "Fields", text: "FIR number, the number, the period and a signed FIR copy. CAF was included by default; IMEI history was not a separate item.", topics: ["unicross", "cdr", "fields", "caf"] },
      { ref: "§3", heading: "Period", text: "The default period was 30 days around the offence, extendable with a reason.", topics: ["unicross", "cdr", "period"] },
    ],
  });
  const current = await doc(db, {
    title: "UNICROSS request circular, Cir. 14/2026",
    docNumber: "Cir. 14/2026",
    issuingBody: "Telangana Police",
    jurisdiction: "Telangana",
    version: "14/2026",
    effectiveFrom: "2026-03-01T00:00",
    status: "CURRENT",
    summary: "How call records and subscriber forms are requested through the Zonal ACP's UNICROSS desk. Supersedes Cir. 09/2025.",
    sections: [
      { ref: "§1", heading: "Route", text: "Requests for call records and subscriber forms go from the station to the Zonal ACP, who forwards them to UNICROSS. Replies come back through the DD mailbox, not to the officer directly, so the station mailbox is watched for them.", topics: ["unicross", "route", "cdr", "dd"] },
      { ref: "§2", heading: "Mandatory fields", text: "Five fields are mandatory: the FIR number and sections; the number, written in full; the period with the reason for it; whether the CAF and IMEI history are wanted; and a signed FIR copy. A request with a missing field is returned without processing.", topics: ["unicross", "cdr", "fields", "caf", "mandatory"] },
      { ref: "§3", heading: "Period and justification", text: "The default period is 45 days around the offence. A longer period needs a stated reason tied to the facts of the case, such as the first contact date in the complaint.", topics: ["unicross", "cdr", "period"] },
      { ref: "§4", heading: "Subscriber form and IMEI", text: "The CAF, the activation date and the ID proof type are supplied with the records when asked for. IMEI history is a separate line item and should be requested where handsets may have been changed.", topics: ["unicross", "caf", "imei", "subscriber"] },
      { ref: "§5", heading: "Turnaround and reminders", text: "The usual turnaround is 5 to 8 working days. A reminder goes through the same route after 8 days, quoting the original reference.", topics: ["unicross", "follow-up-interval", "reminder"] },
      { ref: "§6", heading: "What changed from Cir. 09/2025", text: "The route moved from the SDPO to the Zonal ACP, the default period grew from 30 to 45 days, and IMEI history became a separate item. The older circular is kept for requests sent before 1 Mar 2026.", topics: ["unicross", "changes"] },
    ],
  });
  await db.knowledgeDocument.update({ where: { id: old.id }, data: { supersededById: current.id } });
  await doc(db, {
    title: "Bharatiya Sakshya Adhiniyam 2023, s. 63 and Schedule",
    docNumber: "BSA 2023",
    issuingBody: "Act of Parliament",
    jurisdiction: "India",
    version: "2023",
    effectiveFrom: "2024-07-01T00:00",
    status: "CURRENT",
    summary: "The electronic-records certificate, summarised in plain words.",
    sections: [
      { ref: "s. 63", heading: "What section 63 covers", text: "Section 63 lets information in an electronic record be produced in court as a document, provided the conditions on the device and the process are met and a certificate in the form given in the Schedule accompanies it.", topics: ["electronic-records", "evidence", "bsa", "certificate"] },
      { ref: "s. 63(4)", heading: "The certificate", text: "The certificate is signed by the person in charge of the device or the management of the relevant activities, and by an expert. It identifies the electronic record and describes how it was produced.", topics: ["electronic-records", "certificate", "bsa", "part-a", "part-b"] },
      { ref: "Schedule", heading: "The certificate form", text: "The Schedule has two parts. Part A is signed by the person in charge of the device or process that produced the record, here the officer who received and stored the file. Part B is signed by an expert who confirms the record. Both identify the record and state its hash value and the algorithm used.", topics: ["electronic-records", "certificate", "schedule", "hash"] },
      { ref: "Use", heading: "When it is needed, and how the workspace helps", text: "Whenever a bank statement, email, chat export or call record obtained in the case is to be relied on in court. Every original received through intake or a reply is hashed at receipt and kept with its hash, and the audit log records who did what to it, so both parts can be drafted from those records at handover or charge sheet.", topics: ["electronic-records", "hash", "audit", "handover"] },
    ],
  });
  await doc(db, {
    title: "Provider law-enforcement policies",
    docNumber: "Provider policies",
    issuingBody: "Google, Meta/WhatsApp, Snap (as published)",
    jurisdiction: "Provider policies",
    version: "as published",
    effectiveFrom: "2026-01-01T00:00",
    status: "CURRENT",
    summary: "The providers' own published law-enforcement policies, summarised.",
    reviewNote: "Provider policies change. Check the live page for the current wording and the preservation period before relying on a figure in a request or an answer.",
    sections: [
      { ref: "Google", heading: "Google", text: "Requests go through the law-enforcement request system. A preservation request keeps specified existing records for a stated period, commonly 90 days and extendable; it produces nothing. Disclosure needs the applicable legal process and an exact account identifier. Emergency disclosure is considered only for an imminent risk of death or serious physical injury.", topics: ["provider", "preservation", "disclosure", "emergency", "google"] },
      { ref: "Meta and WhatsApp", heading: "Meta and WhatsApp", text: "Requests go through the law-enforcement records portal. Preservation and disclosure are separate submissions. Emergency disclosure is defined around imminent risk of death or serious injury, not financial loss. Message content is generally not produced.", topics: ["provider", "preservation", "disclosure", "emergency", "whatsapp", "meta"] },
      { ref: "Snap", heading: "Snap", text: "Requests go through the law-enforcement portal with a preservation step and a disclosure step. Only an exact username or identifier is accepted; display names are not.", topics: ["provider", "preservation", "disclosure", "snap"] },
      { ref: "Workspace", heading: "How the workspace treats them", text: "Preservation and disclosure are separate request types, so a preserved profile never shows as answered, and the expiry date of each preservation is tracked as a deadline.", topics: ["provider", "preservation", "disclosure", "deadline"] },
    ],
  });
}
