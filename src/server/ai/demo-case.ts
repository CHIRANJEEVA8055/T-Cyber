import { classifyCaseQuestion, findMentions } from "@/domain/assistant";
import { answerFromLibrary } from "@/domain/guidance";
import { formatInr } from "@/domain/money";
import { formatDateIST, formatDateTimeIST } from "@/domain/time";
import { IDENTIFIER_KIND_LABELS } from "@/contracts/case";
import type { AnswerItem, AnswerRef, CaseAnswer } from "@/contracts/assistant";
import type { GraphIdentityEdge, GraphMoneyEdge, GraphNode, GraphSource } from "@/contracts/graph";
import { citationLabel, evidenceHref } from "@/lib/evidence-href";
import { statusDef } from "@/lib/labels";
import type { CaseContext } from "./context";

export type CaseAnswerBody = Omit<CaseAnswer, "provider" | "question" | "asOf">;

const inr = (minor: string | bigint) => formatInr(typeof minor === "bigint" ? minor : BigInt(minor));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function referenceList() {
  const items: AnswerRef[] = [];
  return {
    items,
    add(label: string, href: string) {
      let r = items.find((i) => i.href === href);
      if (!r) {
        r = { ref: `R${items.length + 1}`, label, href };
        items.push(r);
      }
      return r.ref;
    },
  };
}
type Refs = ReturnType<typeof referenceList>;

function empty(): Pick<CaseAnswerBody, "steps" | "established" | "hypotheses" | "unknowns" | "suggestions" | "guidance"> {
  return { steps: [], established: [], hypotheses: [], unknowns: [], suggestions: [], guidance: null };
}

/** Builds the facts the rules draw on from one case context. */
function facts(ctx: CaseContext, R: Refs) {
  const base = `/cases/${ctx.caseId}`;
  const byId = new Map(ctx.graph.nodes.map((n) => [n.id, n]));
  const label = (id: string) => byId.get(id)?.label ?? "an unnamed record";
  const sourceRefs = (sources: GraphSource[], fallback: [string, string]) =>
    sources.length ? sources.slice(0, 2).map((s) => R.add(citationLabel(s.evidenceTitle, s.locator), evidenceHref(ctx.caseId, s.evidenceId, s.locator))) : [R.add(fallback[0], fallback[1])];
  const transfer = (t: GraphMoneyEdge) => `${inr(t.amountMinor)} from ${label(t.source)} to ${label(t.target)} on ${formatDateTimeIST(new Date(t.occurredAt))}`;
  const confirmedTransfer = (t: GraphMoneyEdge): AnswerItem => ({ text: `${transfer(t)}, confirmed by a bank record.`, refs: sourceRefs(t.sources, ["Transactions", `${base}/funds`]) });
  const reportedTransfer = (t: GraphMoneyEdge): AnswerItem => ({ text: `${transfer(t)} is reported by the victim and not yet confirmed by a bank.`, refs: sourceRefs(t.sources, ["Transactions", `${base}/funds`]) });
  const relationship = (r: GraphIdentityEdge): AnswerItem => ({ text: `As recorded: ${r.statement.replace(/\.+$/, "")}.`, refs: sourceRefs(r.sources, ["Identifiers and locations", `${base}/people`]) });
  const holderCaution = (r: GraphIdentityEdge): AnswerItem => ({
    text: `That ${label(r.target)} operated ${label(r.source)} or received the money is not established: being the holder on record does not by itself show who used the account.`,
    refs: sourceRefs(r.sources, ["Identifiers and locations", `${base}/people`]),
  });
  const holdsRef = () => R.add("Holds and allocations", `${base}/funds/holds`);
  const unknownHolds = (): AnswerItem[] => {
    const requested = ctx.graph.nodes.filter((n) => n.hold && !n.hold.heldMinor && !n.hold.amountUnknown && n.hold.requested);
    const unknownAmount = ctx.graph.nodes.filter((n) => n.hold?.amountUnknown);
    const out: AnswerItem[] = [];
    if (requested.length) out.push({ text: `The amount held in ${requested.map((n) => n.label).join(", ")} is not yet confirmed; a hold was requested. Unknown amounts are not counted as ₹0.`, refs: [holdsRef()] });
    for (const n of unknownAmount) out.push({ text: `${n.label}: a hold or restriction is confirmed but the amount is unknown, so it is not counted as ₹0.`, refs: [holdsRef()] });
    return out;
  };
  const taskRef = (t: { id: string; title: string }) => R.add(`Next action: ${t.title}`, `${base}/actions?task=${t.id}`);
  return { base, byId, label, sourceRefs, confirmedTransfer, reportedTransfer, relationship, holderCaution, holdsRef, unknownHolds, taskRef };
}

function guidanceFor(ctx: CaseContext, query: string): CaseAnswerBody["guidance"] {
  const g = answerFromLibrary(query, ctx.library);
  return g.kind === "INSUFFICIENT" ? null : { kind: g.kind, summary: g.summary, passages: g.passages };
}

const isHolderLink = (ctx: CaseContext, r: GraphIdentityEdge) => r.type === "REGISTERED_TO" && ctx.graph.nodes.find((n) => n.id === r.target)?.kind === "PERSON";

function money(ctx: CaseContext, R: Refs): CaseAnswerBody {
  const f = facts(ctx, R);
  const L = ctx.handover.money;
  const ledgerRef = R.add("Funds ledger", `${f.base}/funds`);
  const out = { intent: "MONEY" as const, ...empty() };
  out.established.push({ text: `Reported loss ${inr(L.totalLossMinor)} across ${plural(L.victimCount, "victim claim")}.`, refs: [ledgerRef] });
  out.established.push({ text: `Confirmed returned to victims: ${inr(L.confirmedRefundsMinor)}. Only refunds with a confirmed credit are counted.`, refs: [ledgerRef] });
  for (const n of ctx.graph.nodes.filter((x) => x.hold?.heldMinor)) out.established.push({ text: `${inr(n.hold!.heldMinor!)} confirmed held in ${n.label}${n.bank ? ` (${n.bank})` : ""}.`, refs: [f.holdsRef()] });
  if (BigInt(L.refundsInPipelineMinor) > 0n) out.established.push({ text: `${inr(L.refundsInPipelineMinor)} is authorised or initiated for return but not yet credited, so it is not counted as returned.`, refs: [R.add("Returns", `${f.base}/funds/returns`)] });
  const layers = new Map<number, { total: bigint; count: number }>();
  for (const t of ctx.graph.moneyEdges) {
    const l = layers.get(t.layer) ?? { total: 0n, count: 0 };
    layers.set(t.layer, { total: l.total + BigInt(t.amountMinor), count: l.count + 1 });
  }
  if (layers.size)
    out.established.push({
      text: `Transfers traced: ${[...layers.entries()]
        .sort(([a], [b]) => a - b)
        .map(([layer, v]) => `layer ${layer} ${inr(v.total)} in ${plural(v.count, "transfer")}`)
        .join("; ")}.`,
      refs: [R.add("Money flow graph", `${f.base}/graph`)],
    });
  out.hypotheses.push(...ctx.graph.moneyEdges.filter((t) => t.status !== "CONFIRMED_BY_BANK").map(f.reportedTransfer));
  out.unknowns.push(...f.unknownHolds());
  for (const issue of L.issues) out.unknowns.push({ text: `Needs reconciliation: ${issue}`, refs: [ledgerRef] });
  const summary =
    L.neitherMinor !== null
      ? (() => {
          const loss = BigInt(L.totalLossMinor);
          const held = BigInt(L.confirmedHeldMinor);
          const back = BigInt(L.confirmedRefundsMinor);
          const open = loss - held - back > 0n ? loss - held - back : 0n;
          return `${inr(L.confirmedHeldMinor)} of the ${inr(L.totalLossMinor)} reported lost is confirmed held, and ${inr(L.confirmedRefundsMinor)} is confirmed returned.${open > 0n ? ` ${inr(open.toString())} is neither held nor returned.` : ""}${held > 0n && L.neitherMinor === L.outstandingLossMinor ? " None of the held money is allocated to a victim yet." : ""}`;
        })()
      : `The ledger needs reconciliation, so the amount neither returned nor secured cannot be stated yet. ${inr(L.confirmedHeldMinor)} is confirmed held.`;
  out.suggestions.push({ label: "Open the funds ledger", href: `${f.base}/funds` }, { label: "Open holds and allocations", href: `${f.base}/funds/holds` });
  out.guidance = guidanceFor(ctx, "record hold amount bank confirms unknown");
  return { ...out, summary, references: R.items };
}

function supported(ctx: CaseContext, R: Refs): CaseAnswerBody {
  const f = facts(ctx, R);
  const out = { intent: "SUPPORTED" as const, ...empty() };
  out.established.push(...ctx.graph.moneyEdges.filter((t) => t.status === "CONFIRMED_BY_BANK").map(f.confirmedTransfer));
  for (const n of ctx.graph.nodes.filter((x) => x.hold?.heldMinor)) out.established.push({ text: `${inr(n.hold!.heldMinor!)} confirmed held in ${n.label}.`, refs: [f.holdsRef()] });
  const rels = ctx.graph.identityEdges.filter((r) => r.type !== "POTENTIALLY_ASSOCIATED_WITH" && (r.status === "ASSERTED" || r.status === "CORROBORATED"));
  out.established.push(...rels.map(f.relationship));
  out.hypotheses.push(...ctx.graph.moneyEdges.filter((t) => t.status !== "CONFIRMED_BY_BANK").map(f.reportedTransfer));
  for (const r of ctx.graph.identityEdges.filter((x) => x.type === "POTENTIALLY_ASSOCIATED_WITH")) out.hypotheses.push({ text: `A possible association only, not established: ${r.statement}.`, refs: f.sourceRefs(r.sources, ["Identifiers and locations", `${f.base}/people`]) });
  out.hypotheses.push(...rels.filter((r) => isHolderLink(ctx, r)).map(f.holderCaution));
  for (const r of ctx.graph.identityEdges.filter((x) => x.status === "DISPUTED" || x.status === "REFUTED")) out.unknowns.push({ text: `${statusDef("verification", r.status).label}: ${r.statement}.`, refs: f.sourceRefs(r.sources, ["Identifiers and locations", `${f.base}/people`]) });
  const unverified = ctx.handover.unverifiedIdentifiers;
  if (unverified) out.unknowns.push({ text: `${plural(unverified, "identifier")} ${unverified === 1 ? "is" : "are"} not yet verified.`, refs: [R.add("Identifiers and locations", `${f.base}/people`)] });
  const summary = `${plural(out.established.length, "statement")} in this case ${out.established.length === 1 ? "is" : "are"} backed by a bank or provider record or a document; ${plural(out.hypotheses.length, "other")} rest${out.hypotheses.length === 1 ? "s" : ""} on the victim's report or ${out.hypotheses.length === 1 ? "is" : "are"} possible only.`;
  out.suggestions.push({ label: "Open evidence", href: `${f.base}/evidence` }, { label: "Open the graph", href: `${f.base}/graph` });
  return { ...out, summary, references: R.items };
}

function missing(ctx: CaseContext, R: Refs): CaseAnswerBody {
  const f = facts(ctx, R);
  const out = { intent: "MISSING" as const, ...empty() };
  const leads = ctx.handover.leads;
  for (const t of leads.slice(0, 10)) out.unknowns.push({ text: t.question, refs: [f.taskRef(t)] });
  out.unknowns.push(...f.unknownHolds());
  for (const r of ctx.handover.pendingRequests.filter((x) => x.followUpDue))
    out.unknowns.push({ text: `${r.reference} to ${r.recipient} has no complete response; the follow-up was due ${formatDateIST(new Date(r.followUpAt!))}.`, refs: [R.add(`Request ${r.reference}`, `${f.base}/requests/${r.id}`)] });
  for (const r of ctx.handover.responsesToReview)
    out.unknowns.push({ text: `A response from ${r.from}, received ${formatDateTimeIST(new Date(r.receivedAt))}, has not been reviewed yet${r.needsMatch ? "; which request it answers is not confirmed" : ""}.`, refs: [R.add(`Response from ${r.from}`, `${f.base}/responses/${r.id}`)] });
  const unverified = ctx.handover.unverifiedIdentifiers;
  if (unverified) out.unknowns.push({ text: `${plural(unverified, "identifier")} ${unverified === 1 ? "is" : "are"} not yet verified.`, refs: [R.add("Identifiers and locations", `${f.base}/people`)] });
  for (const t of leads.slice(0, 4)) out.suggestions.push({ label: `Open: ${t.title}`, href: `${f.base}/actions?task=${t.id}` });
  for (const r of ctx.handover.responsesToReview.slice(0, 2)) out.suggestions.push({ label: `Review the response from ${r.from}`, href: `${f.base}/responses/${r.id}` });
  if (ctx.handover.pendingRequests.some((x) => x.followUpDue)) out.guidance = guidanceFor(ctx, "follow up bank request not answered");
  const summary = out.unknowns.length ? `${plural(out.unknowns.length, "question")} ${out.unknowns.length === 1 ? "is" : "are"} open in this case. First: ${out.unknowns[0]!.text}` : "No open questions are recorded in this case.";
  return { ...out, summary, references: R.items };
}

function next(ctx: CaseContext, R: Refs): CaseAnswerBody {
  const f = facts(ctx, R);
  const out = { intent: "NEXT" as const, ...empty() };
  const step = (text: string, label: string, href: string, refLabel: string) => {
    out.steps.push({ text, refs: [R.add(refLabel, href)] });
    out.suggestions.push({ label, href });
  };
  const responses = [...ctx.handover.responsesToReview].sort((a, b) => Number(b.needsMatch) - Number(a.needsMatch));
  for (const r of responses)
    step(
      r.needsMatch ? `Confirm which request the response from ${r.from} answers.` : `Review the response from ${r.from}, received ${formatDateTimeIST(new Date(r.receivedAt))}.`,
      r.needsMatch ? `Confirm the match for ${r.from}` : `Review the response from ${r.from}`,
      `${f.base}/responses/${r.id}`,
      `Response from ${r.from}`,
    );
  const pending = ctx.handover.pendingRequests;
  for (const r of pending.filter((x) => x.needsReview)) step(`Review draft ${r.reference}: its sources changed after it was written.`, `Open ${r.reference}`, `${f.base}/requests/${r.id}`, `Request ${r.reference}`);
  for (const r of pending.filter((x) => x.status === "AWAITING_APPROVAL"))
    step(ctx.isSupervisor ? `Approve or return ${r.reference} for ${r.recipient}.` : `${r.reference} for ${r.recipient} is waiting for a supervisor's approval.`, `Open ${r.reference}`, `${f.base}/requests/${r.id}`, `Request ${r.reference}`);
  for (const r of pending.filter((x) => x.status === "SUBMISSION_FAILED")) step(`Retry ${r.reference}: the simulated submission failed.`, `Open ${r.reference}`, `${f.base}/requests/${r.id}`, `Request ${r.reference}`);
  for (const r of pending.filter((x) => x.followUpDue))
    step(`Follow up ${r.reference} with ${r.recipient}; the follow-up was due ${formatDateIST(new Date(r.followUpAt!))}.`, `Open ${r.reference}`, `${f.base}/requests/${r.id}`, `Request ${r.reference}`);
  // A lead about a response or request already listed above is the same step; list it once.
  const listedResponses = new Set(responses.map((r) => r.id));
  const listedRequests = new Set(pending.filter((x) => x.needsReview || x.status === "AWAITING_APPROVAL" || x.status === "SUBMISSION_FAILED" || x.followUpDue).map((x) => x.id));
  const open = ctx.handover.leads.filter((t) => (t.status === "OPEN" || t.status === "DRAFT_PREPARED") && !(t.responseId && listedResponses.has(t.responseId)) && !(t.requestId && listedRequests.has(t.requestId)));
  // Among the urgent ones, a request already drafted goes first: it only needs approving and sending (a freeze cannot wait).
  const urgent = open.filter((x) => x.priority === "HIGH");
  for (const t of [...urgent.filter((x) => x.status === "DRAFT_PREPARED"), ...urgent.filter((x) => x.status !== "DRAFT_PREPARED"), ...open.filter((x) => x.priority !== "HIGH")].slice(0, 4)) {
    out.steps.push({ text: t.status === "DRAFT_PREPARED" ? `${t.title}: the request is drafted, approve and send it.` : `${t.title}.`, refs: [f.taskRef(t)] });
    out.suggestions.push({ label: `Open: ${t.title}`, href: `${f.base}/actions?task=${t.id}` });
  }
  if (pending.some((x) => x.followUpDue)) out.guidance = guidanceFor(ctx, "follow up bank request not answered");
  const summary = out.steps.length ? `Start with: ${out.steps[0]!.text}` : "Nothing is waiting for review in this case.";
  return { ...out, suggestions: out.suggestions.slice(0, 6), summary, references: R.items };
}

function changed(ctx: CaseContext, R: Refs): CaseAnswerBody {
  const f = facts(ctx, R);
  const out = { intent: "WHAT_CHANGED" as const, ...empty() };
  for (const e of ctx.recent) out.established.push({ text: `${formatDateTimeIST(new Date(e.at))}: ${e.summary} (${e.actor?.name ?? "automatic"})`, refs: [R.add(e.href ? "Record" : "Activity", e.href ?? `${f.base}/activity`)] });
  // Give each record link a readable label.
  for (const r of R.items) if (r.label === "Record") r.label = r.href.includes("/requests/") ? "Request" : r.href.includes("/responses/") ? "Response" : r.href.includes("/evidence/") ? "Evidence" : r.href.includes("/funds") ? "Funds" : r.href.includes("/people") || r.href.includes("/actions") ? "Investigation" : "Case record";
  const reviewedAt = ctx.graph.reviewedAt;
  const fresh = ctx.graph.nodes.filter((n) => n.isNew);
  if (reviewedAt && fresh.length) out.established.unshift({ text: `New since you last reviewed the graph on ${formatDateTimeIST(new Date(reviewedAt))}: ${fresh.map((n) => n.label).join(", ")}.`, refs: [R.add("Graph, new since review", `${f.base}/graph`)] });
  out.suggestions.push({ label: "Open the activity record", href: `${f.base}/activity` });
  if (fresh.length) out.suggestions.push({ label: "Open the graph", href: `${f.base}/graph` });
  const latest = ctx.recent[0];
  const summary = latest ? `The most recent step recorded by an officer was on ${formatDateTimeIST(new Date(latest.at))}: ${latest.summary}` : "No steps have been recorded by an officer yet.";
  return { ...out, summary, references: R.items };
}

function aboutRecords(ctx: CaseContext, R: Refs, entityIds: string[], requestIds: string[]): CaseAnswerBody {
  const f = facts(ctx, R);
  const out = { intent: "RECORD" as const, ...empty() };
  const names: string[] = [];
  for (const id of entityIds.slice(0, 2)) {
    const n = f.byId.get(id) as GraphNode;
    names.push(n.label);
    const kind = (IDENTIFIER_KIND_LABELS[n.kind] ?? n.kind).toLowerCase();
    const recordsPage = n.kind === "PERSON" || n.kind === "ORGANISATION" ? `${f.base}/people` : `${f.base}/people`;
    out.established.push({ text: `${n.label} is a ${kind} recorded in this case${n.caseRole ? ` as: ${n.caseRole.replace(/\.+$/, "")}` : ""}.`, refs: f.sourceRefs(n.sources, ["Identifiers and locations", recordsPage]) });
    const p = n.learnedFrom;
    if (p?.kind === "RESPONSE") out.established.push({ text: `It was found in the ${p.organisation ?? "provider"} response${p.requestReference ? ` to ${p.requestReference}` : ""}.`, refs: [R.add(`Response from ${p.organisation ?? "provider"}`, `${f.base}/responses/${p.responseId}`)] });
    if (p?.kind === "DOCUMENT") out.established.push({ text: `It was extracted from ${p.evidenceTitle}.`, refs: [R.add(p.evidenceTitle, `${f.base}/evidence/${p.evidenceId}`)] });
    const touching = ctx.graph.moneyEdges.filter((t) => t.source === n.id || t.target === n.id);
    out.established.push(...touching.filter((t) => t.status === "CONFIRMED_BY_BANK").map(f.confirmedTransfer));
    out.hypotheses.push(...touching.filter((t) => t.status !== "CONFIRMED_BY_BANK").map(f.reportedTransfer));
    if (n.hold?.heldMinor) out.established.push({ text: `${inr(n.hold.heldMinor)} confirmed held in ${n.label}.`, refs: [f.holdsRef()] });
    const rels = ctx.graph.identityEdges.filter((r) => r.source === n.id || r.target === n.id);
    out.established.push(...rels.filter((r) => r.type !== "POTENTIALLY_ASSOCIATED_WITH").map(f.relationship));
    for (const r of rels.filter((x) => x.type === "POTENTIALLY_ASSOCIATED_WITH")) out.hypotheses.push({ text: `A possible association only, not established: ${r.statement}.`, refs: f.sourceRefs(r.sources, ["Identifiers and locations", recordsPage]) });
    out.hypotheses.push(...rels.filter((r) => isHolderLink(ctx, r)).map(f.holderCaution));
    if (n.hold && !n.hold.heldMinor) out.unknowns.push({ text: n.hold.amountUnknown ? `The amount held in ${n.label} is unknown; it is not counted as ₹0.` : `A hold on ${n.label} was requested; the bank has not confirmed an amount. It is not counted as ₹0.`, refs: [f.holdsRef()] });
    for (const a of n.openActions) {
      const lead = ctx.handover.leads.find((l) => l.id === a.id);
      out.unknowns.push({ text: lead?.question ?? a.title, refs: [f.taskRef(a)] });
    }
    if (n.verification === "UNVERIFIED") out.unknowns.push({ text: `${n.label} has not been verified.`, refs: [R.add("Identifiers and locations", recordsPage)] });
    out.suggestions.push({ label: `Show ${n.label} in the graph`, href: `${f.base}/graph?focus=${n.id}` });
  }
  for (const id of requestIds.slice(0, 2)) {
    const r = ctx.requests.find((x) => x.id === id)!;
    names.push(r.reference);
    const ref = R.add(`Request ${r.reference}`, `${f.base}/requests/${r.id}`);
    out.established.push({ text: `${r.reference} to ${r.recipient}: ${statusDef("request", r.status).label.toLowerCase()}.`, refs: [ref] });
    if (r.followUpAt) out.established.push({ text: `Its follow-up date is ${formatDateIST(new Date(r.followUpAt))}.`, refs: [ref] });
    for (const lead of ctx.handover.leads.filter((l) => l.requestId === r.id)) out.unknowns.push({ text: lead.question, refs: [f.taskRef(lead)] });
    out.suggestions.push({ label: `Open ${r.reference}`, href: `${f.base}/requests/${r.id}` });
  }
  const summary = `${names.join(" and ")}: ${plural(out.established.length, "recorded fact")}, ${plural(out.unknowns.length, "open question")}.`;
  return { ...out, summary, references: R.items };
}

const HELP_SUMMARY =
  "The case assistant cannot answer that. It answers questions about this case from its records only: what changed, what is still missing, what is supported by evidence, money, a named account or request, and what to review next. It cannot write documents, send anything or change the case.";

/** Deterministic answers from one case's records. Nothing here is generated by a language model. */
export function composeCaseAnswer(question: string, ctx: CaseContext): CaseAnswerBody {
  const R = referenceList();
  const mentions = findMentions(question, ctx.graph.nodes, ctx.requests);
  const intent = classifyCaseQuestion(question);
  if ((mentions.entityIds.length || mentions.requestIds.length) && intent !== "WHAT_CHANGED" && intent !== "NEXT") return aboutRecords(ctx, R, mentions.entityIds, mentions.requestIds);
  switch (intent) {
    case "MONEY":
      return money(ctx, R);
    case "SUPPORTED":
      return supported(ctx, R);
    case "MISSING":
      return missing(ctx, R);
    case "NEXT":
      return next(ctx, R);
    case "WHAT_CHANGED":
      return changed(ctx, R);
    default:
      return { intent: "HELP", summary: HELP_SUMMARY, ...empty(), references: [] };
  }
}
