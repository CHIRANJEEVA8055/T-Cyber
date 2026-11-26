import type { GraphData } from "@/contracts/graph";
import type { LibraryDocument } from "@/domain/guidance";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { getCaseHeader } from "../services/overview";
import { getGraphData } from "../services/graph";
import { getHandover, type HandoverData } from "../services/reports";
import { listActivity, type ActivityEntry } from "../services/activity";
import { loadLibrary } from "./library";
import { getCaseContext } from "../services/case-context";

/**
 * Everything the case assistant may use, assembled through the same access-checked services as the pages:
 * one authorised case plus the general guidance library. A provider receives this and nothing else, so it
 * cannot reach another case or the database.
 */
export interface CaseContext {
  caseId: string;
  reference: string;
  title: string;
  isSupervisor: boolean;
  graph: GraphData;
  handover: HandoverData;
  recent: ActivityEntry[];
  requests: { id: string; reference: string; category: string; status: string; recipient: string; followUpAt: string | null }[];
  library: LibraryDocument[];
  /** Each mail sent and what came back to it, and what is pending, as plain lines with the page each comes from. */
  mail?: { text: string; href: string; label: string }[];
}

export async function buildCaseContext(db: Db, user: SessionUser, caseId: string): Promise<CaseContext> {
  const header = await getCaseHeader(db, user, caseId);
  const [graph, handover, recent, requests, library, ctx] = await Promise.all([
    getGraphData(db, user, caseId),
    getHandover(db, user, caseId),
    listActivity(db, user, caseId, { who: "OFFICERS", limit: 40 }),
    db.request.findMany({ where: { caseId, status: { not: "DISCARDED" } }, include: { recipient: true }, orderBy: { reference: "asc" } }),
    loadLibrary(db),
    getCaseContext(db, user, caseId),
  ]);
  const mail = ctx.mails.flatMap((m) => {
    const href = `/cases/${caseId}/requests/${m.id}`;
    const asked = m.asks.map((a) => `${a.label} (${a.state})`).join("; ");
    return [
      { text: `${m.label} to ${m.to}: ${m.statusText}${m.sent ? `, sent ${m.sent}` : ""}. Subject: ${m.subject}.${asked ? ` Asked for: ${asked}.` : ""}`, href, label: m.label },
      ...m.replies.map((r) => ({ text: `Reply to ${m.label} from ${r.from} on ${r.received} (${r.reviewed ? "reviewed" : "not reviewed yet"})${r.findings.length ? `: ${r.findings.join("; ")}` : ""}.`, href: `/cases/${caseId}/responses/${r.id}`, label: `Reply to ${m.label}` })),
    ];
  });
  for (const p of ctx.pending) mail.push({ text: `Pending: ${p}.`, href: `/cases/${caseId}/requests`, label: "Requests" });
  return {
    caseId,
    reference: header.reference,
    title: header.title,
    isSupervisor: user.role === "SUPERVISOR",
    graph,
    handover,
    // Changes to the case only: who opened what, assistant questions and report housekeeping are left out.
    recent: recent.events.filter((e) => e.category !== "ACCESS" && e.category !== "REPORTS").slice(0, 8),
    requests: requests.map((r) => ({ id: r.id, reference: r.reference, category: r.category, status: r.status, recipient: r.recipient.organisation, followUpAt: r.followUpAt?.toISOString() ?? null })),
    library,
    mail,
  };
}
