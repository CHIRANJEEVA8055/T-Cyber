import { emailProvider, isVictimOwned } from "@/domain/providers";
import { formatInr } from "@/domain/money";
import { formatDateIST, formatDayMonthIST, formatTimeIST } from "@/domain/time";
import type { Tone } from "@/domain/standing";
import { canReadCase, canWriteCase } from "@/domain/permissions";
import { shortRank } from "@/lib/cn";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { loadCaseForUser } from "../auth/access";
import { now } from "../clock";
import { calendarDays, shortOrg } from "./dashboard";
import { parseAttributes } from "./facts";
import { shownId } from "@/domain/identifiers";

/**
 * People & identifiers (design: People artboard): who is in the case, which numbers and accounts belong to them,
 * and how sure the records are. Composed by rules from entities, relationships, requests and sources. What a
 * record said and what an officer noted are kept apart and labelled.
 */

const plain = (s: string) => s.replace(/\s*\(synthetic\)$/, "");
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const lcFirst = (s: string) => (/^[A-Z](?![A-Z0-9])/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const ITEM: Record<string, string> = { STATEMENT: "statement", KYC: "KYC", ATM_DETAILS: "ATM details", CDR: "CDR", SUBSCRIBER_DETAILS: "CAF", ACCOUNT_DETAILS: "account details", BENEFICIARY_DETAILS: "beneficiary details", IMEI: "IMEI", HOLD_CONFIRMATION: "hold", PRESERVATION_CONFIRMATION: "preservation", BALANCE_CONFIRMATION: "balance", IP_LOGS: "session logs", LINKED_CONTACTS: "linked contacts" };
/** "Bank A" stays; "Dating platform" reads "the dating platform". */
const orgName = (org: string) => {
  const o = shortOrg(org);
  return /^(Bank\b|[A-Z]{2,})/.test(o) ? o : `the ${o.charAt(0).toLowerCase()}${o.slice(1)}`;
};
const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];

export type IdGroup = "phone" | "account" | "online";
const GROUP: Record<string, IdGroup> = { PHONE: "phone", BANK_ACCOUNT: "account", UPI_ID: "account", WALLET: "account", EMAIL: "online", PLATFORM_PROFILE: "online", WEBSITE: "online", IP_ADDRESS: "online", DEVICE: "phone" };
export const KIND_LABEL: Record<string, string> = { PHONE: "Phone", BANK_ACCOUNT: "Bank account", UPI_ID: "UPI ID", WALLET: "Wallet", EMAIL: "Email", PLATFORM_PROFILE: "Online profile", WEBSITE: "Website", IP_ADDRESS: "IP address", DEVICE: "Device", PERSON: "Person" };

/** A placeholder in place of a name ("P2", "Victim 1", "Person P3"): the name is not known yet. */
const PLACEHOLDER_P = /^(?:Person\s+)?P(\d+)$/i;
const isPlaceholderName = (l: string) => PLACEHOLDER_P.test(l) || /^Victim\s*\d+$/i.test(l) || /^(?:unknown|not known|name not known)$/i.test(l.trim());

/** The details an officer entered for a person (kept apart from what any record said). */
export interface PersonDetails {
  name: string | null;
  relative: string | null;
  age: string | null;
  gender: string | null;
  address: string | null;
  occupation: string | null;
  notes: string | null;
  by: string | null;
  at: string | null;
}
export function officerDetails(raw: unknown): PersonDetails {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  return { name: str("name"), relative: str("relative"), age: str("age"), gender: str("gender"), address: str("address"), occupation: str("occupation"), notes: str("notes"), by: str("by"), at: str("at") };
}

/** "Mobile 9876543287", "Account 50100234474471 · Bank A", "Profile “Anvi_K”": always in full. */
export function identifierName(e: { kind: string; value: string; attributesJson: string }): string {
  const a = parseAttributes(e.attributesJson) as { bank?: string };
  switch (e.kind) {
    case "PHONE":
      return `Mobile ${shownId(e.value)}`;
    case "BANK_ACCOUNT":
      return `Account ${shownId(e.value)}${a.bank ? ` · ${a.bank}` : ""}`;
    case "UPI_ID":
      return `UPI ${e.value}`;
    case "PLATFORM_PROFILE":
      return `Profile “${e.value}”`;
    case "EMAIL": {
      const [local, domain] = e.value.split("@");
      return `Email ${local ?? ""}${domain !== undefined ? `@${domain}` : ""}`;
    }
    case "IP_ADDRESS":
      return `IP ${e.value}`;
    case "WEBSITE":
      return `Website ${e.value}`;
    default:
      return e.value;
  }
}

export async function getPeopleView(db: Db, user: SessionUser, caseId: string, at = now()) {
  const kase = await loadCaseForUser(db, user, caseId, "read");
  const writer = canWriteCase(user, { stationId: kase.stationId, assignedUserIds: kase.assignments.map((a) => a.userId) });
  const [entities, roles, relationships, claims, transactions, holds, requests, locations, assertions, users, audits] = await Promise.all([
    db.entity.findMany({ where: { caseId }, orderBy: [{ discoveryPhase: "asc" }, { discoveredAt: "asc" }] }),
    db.partyRole.findMany({ where: { caseId } }),
    db.relationship.findMany({ where: { caseId }, orderBy: { discoveredAt: "asc" } }),
    db.victimClaim.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    db.transaction.findMany({ where: { caseId }, orderBy: { occurredAt: "asc" } }),
    db.hold.findMany({ where: { caseId } }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { subjects: true, items: true, recipient: true }, orderBy: { createdAt: "asc" } }),
    db.locationObservation.findMany({ where: { caseId }, orderBy: [{ eventAt: "desc" }] }),
    db.sourceAssertion.findMany({ where: { caseId }, include: { evidence: { select: { title: true, category: true, response: { select: { request: { select: { category: true, recipient: { select: { organisation: true } } } } } } } } }, orderBy: { createdAt: "asc" } }),
    db.user.findMany({ where: { stationId: kase.stationId }, select: { id: true, displayName: true, rank: true } }),
    db.auditEvent.findMany({ where: { caseId, action: "entity.officer_entry_added" }, select: { objectId: true, actorId: true } }),
  ]);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const label = (id: string) => plain(byId.get(id)?.label ?? "an unknown party");
  // Where a fact came from: its own source first; for an identifier, else the replies, then the FIR, that
  // recorded something about it (a transfer to it, a link to it).
  const related = (id: string) => {
    const rels = new Set(relationships.filter((r) => r.fromEntityId === id || r.toEntityId === id).map((r) => r.id));
    const txns = new Set(transactions.filter((t) => t.fromEntityId === id || t.toEntityId === id).map((t) => t.id));
    const found = assertions.filter((a) => a.stance !== "CONTRADICTS" && ((a.subjectType === "RELATIONSHIP" && rels.has(a.subjectId)) || (a.subjectType === "TRANSACTION" && txns.has(a.subjectId))));
    return found.find((a) => a.evidence.response) ?? found.find((a) => a.evidence.category === "FIR_COPY") ?? found[0];
  };
  const firstSource = (type: string, id: string) => assertions.find((a) => a.subjectType === type && a.subjectId === id && a.stance !== "CONTRADICTS") ?? (type === "ENTITY" ? related(id) : undefined);
  const sourceText = (type: string, id: string, officer = false) => {
    if (officer) return "Your entry";
    const a = firstSource(type, id);
    if (!a) return "Recorded by an officer";
    const org = a.evidence.response?.request?.recipient.organisation;
    if (org) return `From ${orgName(org)}’s ${a.evidence.response?.request?.category === "PRESERVATION" ? "preservation receipt" : "reply"}`;
    if (a.evidence.category === "FIR_COPY") return "From the FIR";
    if (/chat|whatsapp/i.test(a.evidence.title)) return "From the chat export";
    if (a.evidence.category === "COMPLAINT") return "From the NCRP complaint";
    return `From ${a.evidence.title}`;
  };
  const entryBy = new Map(audits.map((a) => [a.objectId, a.actorId]));
  const who = (id: string | null | undefined) => {
    if (id === user.id) return "you";
    const u = users.find((x) => x.id === id);
    return u ? `${shortRank(u.rank)} ${u.displayName}` : "an officer";
  };

  /** A holder named by a bank's KYC record, as against one named only in the FIR or by an officer. */
  const isKyc = (r: { id: string; statement: string }) => !/^The FIR\b/i.test(r.statement) && (/KYC record|per bank KYC|KYC:/i.test(r.statement) || /reply$/.test(sourceText("RELATIONSHIP", r.id)));

  // --- People ---------------------------------------------------------------------------------
  // Each person has a short code: V1, V2… for the victims (the complainant is V1), P1, P2… for everyone else (a
  // placeholder label like "P2" keeps its number). The card shows the name once a record or an officer gives it:
  // "P. Kiran (P1)", "Suresh (V1)"; until then "Person P1", "Victim 1".
  const persons = entities.filter((e) => e.kind === "PERSON");
  const rolesOf = (id: string) => roles.filter((x) => x.entityId === id).map((x) => x.role);
  const claimOf = (id: string) => claims.find((c) => c.victimEntityId === id && c.status === "ACTIVE");
  const isVictimPerson = (e: (typeof persons)[number]) => { const r = rolesOf(e.id); return r.includes("VICTIM") || r.includes("COMPLAINANT") || !!claimOf(e.id); };
  const code = new Map<string, string>();
  const victimsInOrder = persons.filter(isVictimPerson).sort((a, b) => Number(!rolesOf(a.id).includes("COMPLAINANT")) - Number(!rolesOf(b.id).includes("COMPLAINANT")));
  victimsInOrder.forEach((e, i) => code.set(e.id, `V${i + 1}`));
  const others0 = persons.filter((e) => !isVictimPerson(e));
  const taken = new Set(others0.map((e) => PLACEHOLDER_P.exec(plain(e.label))?.[1]).filter((x): x is string => !!x).map(Number));
  let nextP = 1;
  for (const e of others0) {
    const own = PLACEHOLDER_P.exec(plain(e.label))?.[1];
    if (own) code.set(e.id, `P${Number(own)}`);
    else {
      while (taken.has(nextP)) nextP++;
      taken.add(nextP);
      code.set(e.id, `P${nextP}`);
    }
  }
  const people = persons.map((e) => {
    const r = rolesOf(e.id);
    const claim = claimOf(e.id);
    const holderOf = relationships.filter((x) => x.type === "REGISTERED_TO" && x.toEntityId === e.id);
    const isVictim = isVictimPerson(e);
    const attrs = parseAttributes(e.attributesJson);
    const officer = officerDetails(attrs.officer);
    let sub: string;
    let what: string;
    if (r.includes("COMPLAINANT")) sub = "Complainant";
    else if (isVictim) sub = `Added ${formatDayMonthIST(e.discoveredAt)}`;
    else if (holderOf.length) {
      const fromKyc = holderOf.some(isKyc);
      const phones = holderOf.filter((h) => byId.get(h.fromEntityId)?.kind === "PHONE");
      const accts = holderOf.filter((h) => byId.get(h.fromEntityId)?.kind !== "PHONE");
      const phoneName = (id: string) => { const x = byId.get(id); return x ? identifierName(x) : label(id); };
      sub = [accts.length ? `${fromKyc ? "KYC holder" : "Named holder"} of ${list(accts.map((h) => label(h.fromEntityId)))}` : null, phones.length ? `Subscriber of ${list(phones.map((h) => phoneName(h.fromEntityId)))}` : null].filter(Boolean).join(" · ");
    } else sub = e.caseRole ? plain(e.caseRole) : "Named in the case";
    if (claim) {
      const linkedComplaint = claim.basis && /NCRP/i.test(claim.basis);
      what = `Paid ${formatInr(claim.lossAmountMinor)}.${e.verificationStatus === "CORROBORATED" ? " Identity verified." : linkedComplaint ? " Linked NCRP complaint." : ""}`;
    } else if (holderOf.length) {
      const h = holderOf[0]!;
      const src = sourceText("RELATIONSHIP", h.id);
      what = !isKyc(h) ? `${/^The FIR/i.test(h.statement) || src === "From the FIR" ? "From the FIR only" : "Named, not from a bank record"}. Bank KYC not yet received.` : `${src.replace(/^From /, "Reported by ").replace(/’s reply$/, "")}. Not shown to control it.`;
    } else what = e.officerEntry ? (e.caseRole ?? "Your entry") : (e.verificationNote ?? "No record has said more yet.");

    // The name: what a record (or the officer's own entry of the person) says first, else the officer's later note.
    const c = code.get(e.id)!;
    const recordName = isPlaceholderName(plain(e.label)) ? null : plain(e.label);
    const name = recordName ?? officer.name ?? null;
    const nameFrom = recordName ? sourceText("ENTITY", e.id, e.officerEntry) : officer.name ? `Entered by ${who(officer.by)}` : null;
    const display = name ? `${name} (${c})` : isVictim ? `Victim ${c.slice(1)}` : `Person ${c}`;

    // The card: what the records say about the person, what is linked to them, and the officer's own details.
    const facts: { k: string; v: string; src: string | null }[] = [];
    // Only what a record (or the officer's own entry of the person) said; the officer's later details are listed apart.
    if (recordName) facts.push({ k: "Name", v: recordName, src: nameFrom });
    const caseRole = e.caseRole && !/^victim \(as stated/i.test(e.caseRole) ? plain(e.caseRole).replace(/\.$/, "") : null;
    const roleWords = [r.includes("COMPLAINANT") ? "Complainant" : null, isVictim && !r.includes("COMPLAINANT") ? "Victim" : null, r.includes("ACCOUNT_HOLDER_ON_RECORD") ? "Account holder on record" : null].filter((x): x is string => !!x && !(caseRole ?? "").toLowerCase().includes(x.toLowerCase()));
    const roleText = [...roleWords, caseRole].filter((x): x is string => !!x);
    if (roleText.length) facts.push({ k: "In this case", v: roleText.join(". "), src: null });
    if (claim) {
      const paid = transactions.filter((t) => t.claimId === claim.id && t.kind === "VICTIM_PAYMENT");
      facts.push({ k: "Paid", v: `${formatInr(claim.lossAmountMinor)}${paid.length ? ` in ${paid.length} ${paid.length === 1 ? "payment" : "payments"}${paid[0] ? `, from ${formatDateIST(paid[0].occurredAt)}` : ""}` : ""}`, src: claim.basis ?? null });
    }
    for (const h of holderOf) {
      const id = byId.get(h.fromEntityId);
      if (!id) continue;
      const bank = (parseAttributes(id.attributesJson) as { bank?: string }).bank;
      facts.push({ k: id.kind === "PHONE" ? "Subscriber of" : isKyc(h) ? "KYC holder of" : "Named holder of", v: `${GROUP[id.kind] ? identifierName(id) : plain(id.label)}${id.kind === "BANK_ACCOUNT" && !/\d{4}/.test(id.label) ? ` (${plain(id.label)})` : ""}${bank && id.kind !== "BANK_ACCOUNT" ? ` · ${bank}` : ""}`, src: /^The FIR\b/i.test(h.statement) ? "From the FIR" : sourceText("RELATIONSHIP", h.id) });
    }
    const heldIds = holderOf.map((h) => h.fromEntityId);
    for (const l of locations.filter((x) => x.observationType === "KYC_ADDRESS" && x.entityId && heldIds.includes(x.entityId))) {
      const bank = (parseAttributes(byId.get(l.entityId!)?.attributesJson ?? "{}") as { bank?: string }).bank;
      facts.push({ k: "Declared address", v: plain(l.locationText), src: `As declared${bank ? ` to ${bank}` : ""}; an address on a form, not a sighting` });
    }
    if (e.verificationStatus === "CORROBORATED") facts.push({ k: "Identity", v: "Verified", src: e.verificationNote ?? null });
    else if (e.verificationNote && !claim && !holderOf.length) facts.push({ k: "Note", v: e.verificationNote, src: null });

    // What is linked: the numbers and accounts the person holds, and a victim's own accounts the money left from.
    const own = claim ? transactions.filter((t) => t.claimId === claim.id && t.kind === "VICTIM_PAYMENT").map((t) => t.fromEntityId) : [];
    const linked = [...new Set([...heldIds, ...own])].filter((id) => GROUP[byId.get(id)?.kind ?? ""]);
    const statementIds = relationships.filter((x) => x.fromEntityId === e.id || x.toEntityId === e.id).map((x) => x.id);

    return {
      id: e.id,
      /** The victim or complainant (listed after the people the investigation is about). */
      victim: isVictim,
      code: c,
      initials: c,
      name,
      nameFrom,
      label: display,
      sub,
      what,
      officerEntry: e.officerEntry ? `Added by ${who(entryBy.get(e.id))}` : null,
      card: {
        facts,
        linked,
        statementIds,
        officer: { ...officer, alias: e.nickname, belongsTo: e.belongsTo, by: officer.by ? who(officer.by) : null },
        version: e.updatedAt.toISOString(),
      },
    };
  });

  // --- Identifiers ----------------------------------------------------------------------------
  const others = await db.entity.findMany({
    where: { caseId: { not: caseId }, case: { stationId: kase.stationId }, kind: { in: entities.filter((e) => GROUP[e.kind]).map((e) => e.kind) }, normalizedValue: { in: entities.map((e) => e.normalizedValue) } },
    select: { kind: true, normalizedValue: true, case: { select: { id: true, firNumber: true, firYear: true, referenceType: true, complaintRef: true, stationId: true, assignments: { select: { userId: true } } } } },
  });
  const victimsPaidInto = (id: string) => new Set(transactions.filter((t) => t.kind === "VICTIM_PAYMENT" && t.toEntityId === id).map((t) => t.fromEntityId)).size;

  // Where each identifier stands in the money trail: level 1 received the victim's money directly, level 2 got it
  // from a level-1 account, and so on (the transaction layers). A number or UPI ID linked to such an account by a
  // record stands at that account's level, marked as linked. The victim's own accounts are not levelled.
  const victimOwn = (e: (typeof entities)[number]) => isVictimOwned({ caseRole: e.caseRole, attributes: parseAttributes(e.attributesJson), belongsTo: e.belongsTo }) || /(complainant|victim(?: \d+)?)'?s own\b/i.test(e.caseRole ?? "");
  const ownLevel = new Map<string, number>();
  for (const t of transactions) {
    const to = byId.get(t.toEntityId);
    if (!to || victimOwn(to) || t.kind === "CASH_WITHDRAWAL") continue;
    ownLevel.set(to.id, Math.min(ownLevel.get(to.id) ?? Infinity, t.layer));
  }
  const trailOf = (e: (typeof entities)[number]): { level: number; linkedTo: string | null } | null => {
    if (victimOwn(e)) return null;
    const own = ownLevel.get(e.id);
    if (own !== undefined) return { level: own, linkedTo: null };
    let best: { level: number; linkedTo: string } | null = null;
    for (const r of relationships) {
      if (r.type !== "LINKED_IDENTIFIER" || r.status === "DISPUTED") continue;
      const other = r.fromEntityId === e.id ? r.toEntityId : r.toEntityId === e.id ? r.fromEntityId : null;
      const l = other ? ownLevel.get(other) : undefined;
      if (other && l !== undefined && (!best || l < best.level)) best = { level: l, linkedTo: identifierName(byId.get(other)!) };
    }
    return best;
  };
  /** Which side of the case it is on: the victim's, the accused's (named so, or the money reached it), or not known. */
  const sideOf = (e: (typeof entities)[number], trail: { level: number } | null): "VICTIM" | "ACCUSED" | "OTHER" => {
    if (victimOwn(e)) return "VICTIM";
    if (e.belongsTo === "SUSPECT" || trail || /beneficiar|fraudster|accused|suspect|mule|caller|scammer|impersonat|used by the|collection handle/i.test(e.caseRole ?? "")) return "ACCUSED";
    return "OTHER";
  };
  const rows = entities
    .filter((e) => GROUP[e.kind])
    .map((e) => {
      const a = parseAttributes(e.attributesJson) as Record<string, string>;
      const reqs = requests.filter((r) => r.subjects.some((s) => s.entityId === e.id));
      const hold = holds.find((h) => h.accountEntityId === e.id);
      const inflow = transactions.filter((t) => t.toEntityId === e.id && t.kind === "ONWARD_TRANSFER");
      const ownNumber = /(complainant|victim(?: \d+)?)'?s own\b/i.test(e.caseRole ?? "") || e.belongsTo === "VICTIM";
      const ip = locations.find((l) => l.entityId === e.id && l.observationType === "IP_LOGIN") ?? (e.kind === "IP_ADDRESS" ? locations.find((l) => l.observationType === "IP_LOGIN") : undefined);
      // What it is in this case, in one line.
      let what = plain(e.caseRole ?? KIND_LABEL[e.kind] ?? e.kind);
      if (e.kind === "BANK_ACCOUNT" && victimsPaidInto(e.id) > 0) what = victimsPaidInto(e.id) === 2 ? "Where both victims sent the money" : victimsPaidInto(e.id) > 2 ? `Where ${victimsPaidInto(e.id)} victims sent the money` : "Where the victim sent the money";
      else if (e.kind === "BANK_ACCOUNT" && inflow.length) what = `Received ${formatInr(inflow.reduce((s, t) => s + t.amountMinor, 0n))} from ${list([...new Set(inflow.map((t) => label(t.fromEntityId)))])}`;
      const regTo = relationships.find((r) => r.type === "LINKED_IDENTIFIER" && r.fromEntityId === e.id && byId.get(r.toEntityId)?.kind === "BANK_ACCOUNT" && /registered mobile/i.test(r.statement));
      if (e.kind === "PHONE" && regTo) what = `Registered number for ${label(regTo.toEntityId)}`;
      if (e.kind === "IP_ADDRESS" && ip) what = `Login IP in ${sourceText("ENTITY", e.id).replace(/^From /, "")}`;
      const missingKyc = reqs.some((r) => r.items.some((i) => i.itemType === "KYC" && (i.status === "PENDING" || i.status === "NOT_PROVIDED")) && ["PARTIAL_RESPONSE"].includes(r.status));
      const whatSub = [sourceText("ENTITY", e.id, e.officerEntry), e.kind === "PHONE" && !a.provider && !ownNumber ? "provider not yet known" : null, missingKyc ? "KYC still missing" : null, ip && !ip.eventAt ? "missing the port and exact time needed to identify a subscriber" : null]
        .filter(Boolean)
        .join(" · ");

      // Requests about it.
      const reqText = reqs.filter((r) => !r.parentRequestId).map((r) => {
        const seq = r.reference;
        const got = r.items.filter((i) => i.status === "RECEIVED").length;
        if (UNSENT.includes(r.status)) return `${seq} drafted`;
        if (r.status === "COMPLETE_RESPONSE") return `${seq} in`;
        if (r.status === "PARTIAL_RESPONSE") return `${seq} · ${got} of ${r.items.length} in`;
        return `${seq} sent ${r.submittedAt ? formatDayMonthIST(r.submittedAt) : ""}`.trim();
      });
      const reqSub = (() => {
        const open = reqs.filter((r) => !r.parentRequestId);
        if (!open.length) return ip && !ip.eventAt ? "Needs the port and exact time first" : "No request drafted";
        const last = open.at(-1)!;
        const what = [...new Set(last.items.map((i) => ITEM[i.itemType]).filter(Boolean))].join(", ");
        const reminder = reqs.find((r) => r.parentRequestId);
        const bits = [what];
        if (UNSENT.includes(last.status)) bits.push(last.status === "AWAITING_APPROVAL" ? "with the approver" : "needs your approval");
        if (hold?.status === "CONFIRMED_HELD" && open.some((r) => r.category === "HOLD")) bits.push("hold confirmed");
        if (reminder) bits.push(UNSENT.includes(reminder.status) ? "reminder drafted" : `reminder sent ${reminder.submittedAt ? formatDayMonthIST(reminder.submittedAt) : ""}`.trim());
        return bits.filter(Boolean).join(" · ");
      })();

      // Seen in other cases of the station (the FIR number only; details stay with that case's officers).
      const matches = others.filter((o) => o.kind === e.kind && o.normalizedValue === e.normalizedValue);
      const caseRefs = [...new Map(matches.map((m) => [m.case.id, m.case])).values()].map((c) => ({
        id: c.id,
        ref: c.referenceType === "FIR" && c.firNumber ? `FIR ${c.firNumber}/${c.firYear}` : `Complaint ${c.complaintRef ?? ""}`,
        canOpen: canReadCase(user, { stationId: c.stationId, assignedUserIds: c.assignments.map((x) => x.userId) }),
      }));

      // Status, from the records.
      const sentReq = reqs.find((r) => ["SUBMITTED", "ACKNOWLEDGED"].includes(r.status) && !r.parentRequestId);
      const preserved = reqs.find((r) => r.preservedUntil && r.preservedUntil > at);
      let status: { text: string; tone: Tone | "you" };
      if (e.officerEntry) status = { text: `Added by ${who(entryBy.get(e.id)) === "you" ? "you" : who(entryBy.get(e.id))}`, tone: "you" };
      else if (ownNumber) status = { text: "Victim’s own", tone: "neutral" };
      else if (hold?.status === "CONFIRMED_HELD" && (hold.confirmedAmountMinor ?? 0n) > 0n) status = { text: `${formatInr(hold.confirmedAmountMinor!)} held`, tone: "ok" };
      else if (hold && (hold.status === "RESTRICTION_CONFIRMED" || (hold.status === "CONFIRMED_HELD" && hold.confirmedAmountMinor === 0n))) status = { text: "Restricted, empty", tone: "neutral" };
      else if (hold?.status === "REQUESTED") status = { text: "Hold requested", tone: "wait" };
      else if (preserved) status = { text: "Preserved", tone: "ok" };
      else if (ip && !ip.eventAt) status = { text: "Incomplete", tone: "gap" };
      else if (sentReq) status = { text: `Waiting on ${shortOrg(sentReq.recipient.organisation)}`, tone: "wait" };
      else if (reqs.some((r) => UNSENT.includes(r.status)) || calendarDays(e.discoveredAt, at) <= 3) status = { text: "New lead", tone: "info" };
      else status = { text: "Reviewing", tone: "neutral" };

      const kv: [string, string][] =
        e.kind === "PHONE"
          ? [["Number", e.value], ["Provider", a.provider ?? "Not yet known"]]
          : e.kind === "BANK_ACCOUNT"
            ? [["Bank", a.bank ?? "Not yet known"], ["IFSC", a.ifsc ?? "Not recorded"]]
            : e.kind === "IP_ADDRESS"
              ? [["Address", e.value], ["Port and time", ip?.eventAt ? `${formatDateIST(ip.eventAt)}, ${formatTimeIST(ip.eventAt)}` : "Not given by the record"]]
              : e.kind === "WEBSITE"
                ? [["Address", e.value], ["Registrar", a.provider ?? a.registrar ?? "Not recorded"]]
                : e.kind === "EMAIL"
                  ? [["Address", e.value], ["Mail provider", a.provider ?? emailProvider(e.value)?.name ?? "Not recorded"]]
                  : [["Value", e.value], ["Platform", a.platform ?? a.provider ?? "Not recorded"]];
      // A name the FIR or complaint gave for it: shown as stated, with how a later record compares.
      if (typeof a.statedName === "string") {
        const c = a.statedNameCheck as { recordName?: string; verdict?: string; source?: string } | undefined;
        const verdict = c?.verdict === "MATCHES" ? "matches" : c?.verdict === "PROBABLY" ? "probably the same name, spelt differently" : c?.verdict === "DIFFERS" ? "a different name" : null;
        kv.push(["Stated to be", `“${a.statedName}” (${typeof a.statedNameBasis === "string" ? a.statedNameBasis.replace(/^As stated in /, "per ").replace(/; not verified$/, "") : "per the FIR"}, not verified)`]);
        kv.push(["Name on record", c?.recordName ? `${c.recordName}, per ${c.source ?? "a record"}: ${verdict}. A name on record does not show who used it.` : "Not received yet: the bank's KYC or the provider's records will be compared with it when they arrive."]);
      }
      const trail = trailOf(e);
      return {
        id: e.id,
        kind: e.kind,
        kindLabel: KIND_LABEL[e.kind] ?? e.kind,
        /** Its level in the money trail (1 = paid directly by the victim), and the account it is linked to when not its own. */
        trail,
        side: sideOf(e, trail),
        group: GROUP[e.kind]!,
        name: identifierName(e),
        nickname: e.nickname,
        alias: plain(e.label) !== e.value && !identifierName(e).includes(plain(e.label)) ? plain(e.label) : null,
        what,
        whatSub,
        requests: reqText.length ? reqText.join(" · ") : null,
        requestsSub: reqSub,
        requestList: reqs.map((r) => ({ id: r.id, title: `${r.reference} · ${r.recipient.organisation}`, sub: `${[...new Set(r.items.map((i) => ITEM[i.itemType] ?? i.label))].join(", ")} · ${UNSENT.includes(r.status) ? "not sent yet" : r.status === "COMPLETE_RESPONSE" ? "answered" : r.status === "PARTIAL_RESPONSE" ? "partly answered" : `sent ${r.submittedAt ? formatDayMonthIST(r.submittedAt) : ""}`}` })),
        alsoIn: caseRefs,
        status,
        belongsTo: e.belongsTo,
        officerEntry: e.officerEntry,
        // What requests about it are routed by: the bank of an account, the provider of anything online.
        routing: { bank: typeof a.bank === "string" ? a.bank : null, ifsc: typeof a.ifsc === "string" ? a.ifsc : null, provider: typeof a.provider === "string" ? a.provider : typeof a.registrar === "string" ? a.registrar : null },
        kv,
        source: sourceText("ENTITY", e.id, e.officerEntry),
        addedAt: e.discoveredAt.toISOString(),
        version: e.updatedAt.toISOString(),
      };
    });

  rows.sort((a, b) => Number(a.status.text === "Victim’s own") - Number(b.status.text === "Victim’s own"));
  // The investigation is about the accused: the people it is about come first, the victims after them.
  people.sort((a, b) => Number(a.victim) - Number(b.victim) || Number(a.code.slice(1)) - Number(b.code.slice(1)));

  // A person is named the same way everywhere on this page: "P. Kiran (P1)" once a name is known, else "P1".
  const shown = new Map(people.map((p) => [p.id, p.name ? p.label : plain(byId.get(p.id)!.label)]));
  const personLabel = (id: string) => shown.get(id) ?? label(id);

  // --- What the records say -------------------------------------------------------------------
  const disputed = new Set(assertions.filter((a) => a.stance === "CONTRADICTS" && a.subjectType === "RELATIONSHIP").map((a) => a.subjectId));
  const statements = relationships
    .filter((r) => r.type !== "LINKED_IDENTIFIER" || byId.get(r.fromEntityId)?.kind === "PHONE" || byId.get(r.toEntityId)?.kind === "PHONE")
    .map((r) => {
      const from = byId.get(r.fromEntityId);
      const to = byId.get(r.toEntityId);
      const src = /^The FIR\b/i.test(r.statement) ? "From the FIR" : sourceText("RELATIONSHIP", r.id);
      const name = (e: typeof from) => (e ? (e.kind === "PERSON" ? personLabel(e.id) : e.kind === "BANK_ACCOUNT" && !/\d{4}/.test(e.label) ? plain(e.label) : GROUP[e.kind] ? identifierName(e).replace(/ · .*$/, "") : plain(e.label)) : "Someone");
      let title = r.statement.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "");
      if (r.type === "REGISTERED_TO" && from?.kind === "PHONE") title = `${name(to)} is the subscriber on record of ${name(from)}`;
      else if (r.type === "REGISTERED_TO") title = isKyc(r) ? `${name(to)} is the KYC holder of ${name(from)}` : `${name(to)} is named as the holder of ${name(from)}`;
      else if (r.type === "LINKED_IDENTIFIER" && /registered mobile/i.test(r.statement)) title = `${name(from)} is registered to ${name(to)}`;
      const isDisputed = r.status === "DISPUTED" || disputed.has(r.id);
      const pill: { text: string; tone: Tone } = isDisputed
        ? { text: "Contradiction", tone: "gap" }
        : r.status === "CORROBORATED"
          ? { text: "Corroborated", tone: "ok" }
          : r.status === "UNVERIFIED" || src === "From the FIR"
            ? { text: "Unverified", tone: "wait" }
            : /(reply|receipt)$/.test(src)
              ? { text: "Record", tone: "ok" }
              : { text: "Reported", tone: "info" };
      const rest = r.statement.split(/(?<=\.)\s/).slice(1).join(" ");
      const sub = src === "From the FIR" ? `Only in the FIR.${rest ? ` ${rest}` : " A bank's KYC will confirm or contradict it."}` : `${src.replace(/^From /, "")}${r.discoveredAt ? `, as of ${formatDayMonthIST(r.discoveredAt)}` : ""}.${rest ? ` ${rest}` : ""}`;
      return { id: r.id, title, sub: sub.charAt(0).toUpperCase() + sub.slice(1), pill };
    });

  // --- Where anyone was seen ------------------------------------------------------------------
  const sightings = locations
    .filter((l) => l.observationType !== "IP_LOGIN" || l.eventAt)
    .map((l) => {
      const ent = l.entityId ? byId.get(l.entityId) : undefined;
      if (l.observationType === "KYC_ADDRESS") {
        const holder = ent ? relationships.find((r) => r.type === "REGISTERED_TO" && r.fromEntityId === ent.id) : undefined;
        const bank = ent ? (parseAttributes(ent.attributesJson) as { bank?: string }).bank : undefined;
        return { id: l.id, title: `${holder ? `${personLabel(holder.toEntityId)}’s` : "Declared"} address, ${plain(l.locationText).split(",")[0]}`, sub: `As declared${bank ? ` to ${bank}` : ""}${l.eventAt ? ` on ${formatDateIST(l.eventAt)}` : ""}. An address on a form, not a sighting.`, pill: { text: "Declared", tone: "neutral" as Tone } };
      }
      const days = l.eventAt ? calendarDays(l.eventAt, at) : null;
      const cctvAsked = requests.some((r) => r.category === "INFORMATION" && r.items.some((i) => i.itemType === "ATM_DETAILS") && !UNSENT.includes(r.status) && ent && r.subjects.some((s) => s.entityId === ent.id));
      return {
        id: l.id,
        title: `${l.observationType === "ATM_WITHDRAWAL" ? `ATM in ${plain(l.locationText).replace(/^ATM,\s*/, "")}` : plain(l.locationText)}${l.eventAt ? `, ${formatDayMonthIST(l.eventAt)} at ${formatTimeIST(l.eventAt).replace(" IST", "")}` : ""}`,
        sub: `${l.description}. Learned on ${formatDayMonthIST(l.receivedAt)}.${l.observationType === "ATM_WITHDRAWAL" ? (cctvAsked ? " The ATM details are asked for; footage is not yet requested." : " The exact ATM and any footage are not yet requested.") : ""}`,
        pill: { text: days === null ? "Time unknown" : days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"} old`, tone: "wait" as Tone },
      };
    });
  const cdrPending = requests.some((r) => r.items.some((i) => i.itemType === "CDR") && !["COMPLETE_RESPONSE"].includes(r.status));

  // --- Still to establish ---------------------------------------------------------------------
  const open: string[] = [];
  const holderAccounts = [...new Set(relationships.filter((r) => r.type === "REGISTERED_TO").map((r) => r.fromEntityId))];
  const controlled = new Set(relationships.filter((r) => (r.type === "CONTROLLED_BY" || r.type === "USED_BY") && r.status === "CORROBORATED").map((r) => r.fromEntityId));
  const unproven = holderAccounts.filter((id) => !controlled.has(id));
  if (unproven.length) open.push(`Who actually operated ${list(unproven.map(label))}`);
  for (const p of entities.filter((e) => e.kind === "PLATFORM_PROFILE" && !controlled.has(e.id) && e.belongsTo !== "VICTIM")) open.push(`Who was behind the “${p.value}” profile`);
  for (const a of assertions.filter((x) => x.stance === "CONTRADICTS" && x.subjectType === "TRANSACTION")) {
    const t = transactions.find((x) => x.id === a.subjectId);
    const victim = t?.claimId ? claims.find((c) => c.id === t.claimId) : undefined;
    if (t) open.push(`Why ${victim ? `${label(victim.victimEntityId)}’s` : "a"} payment ${/date/i.test(a.note ?? "") ? "date" : "record"} differs between the FIR and the bank`);
  }

  const counts = { all: rows.length, phone: rows.filter((r) => r.group === "phone").length, account: rows.filter((r) => r.group === "account").length, online: rows.filter((r) => r.group === "online").length };
  const deepest = Math.max(0, ...rows.map((r) => r.trail?.level ?? 0));
  return {
    caseId,
    canWrite: writer,
    people,
    rows,
    counts,
    /** The deepest level the money has been traced to (0 when no movement is recorded). */
    deepest,
    statements,
    sightings,
    sightingsNote: cdrPending ? "Phone locations will appear here once the call records arrive." : null,
    open: [...new Set(open)].map(lcFirst).map((s) => s.charAt(0).toUpperCase() + s.slice(1)),
  };
}
export type PeopleViewData = Awaited<ReturnType<typeof getPeopleView>>;
