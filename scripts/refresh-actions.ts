import { getDb } from "../src/server/db";
import type { SessionUser } from "../src/server/auth/session";
import { refreshRecommendationsTx } from "../src/server/services/tasks";
import { prepareDraftFromTask } from "../src/server/services/drafting";
import { autoDraftRequests } from "../src/server/services/auto-draft";
import { flagDraftsForReview } from "../src/server/services/requests";
import { AppError } from "../src/server/errors";
import { now } from "../src/server/clock";

/**
 * Works out the next actions of every open real (non-demonstration) case again with the current rules, as its
 * investigating officer: npm run actions:refresh
 *  - actions that no longer apply are closed with the reason, new ones are proposed and the urgent ones drafted;
 *  - an unsent draft addressed to a demonstration directory entry is re-addressed to the nodal officer list, or, when
 *    its provider is not known yet, marked for review with what is missing.
 * Nothing is sent. Every change is in the case's audit log.
 */
const DEPARTMENTAL = ["POLICE_UNIT", "NPCI"];
const UNSENT = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_FAILED"];

const ACTIVE = ["OPEN", "DRAFT_PREPARED", "BLOCKED", "DEFERRED", "WAITING"];

/** Directories seeded before email addresses were asked for their details lack that route: it is added once. */
async function ensureEmailDetailsRoute(db: ReturnType<typeof getDb>) {
  const mail = await db.recipient.findUnique({ where: { configKey: "mail-portal" } });
  if (!mail) return;
  if (await db.routingRule.findFirst({ where: { subjectKind: "EMAIL", category: "INFORMATION" } })) return;
  await db.routingRule.create({ data: { name: "Email address: account details", subjectKind: "EMAIL", category: "INFORMATION", resolveBy: "FIXED", recipientId: mail.id, approvalRole: "INVESTIGATING_OFFICER", followUpDays: 15, procedureNote: "To the mail provider's law-enforcement team: who registered the address, its phone numbers and recovery email, and the login IP addresses." } });
  if (!(JSON.parse(mail.categoriesJson) as string[]).includes("INFORMATION")) await db.recipient.update({ where: { id: mail.id }, data: { categoriesJson: JSON.stringify([...(JSON.parse(mail.categoriesJson) as string[]), "INFORMATION"]) } });
  console.log("Added the routing rule: Email address: account details.");
}

async function main() {
  const db = getDb();
  await ensureEmailDetailsRoute(db);
  const cases = await db.case.findMany({ where: { isDemo: false, status: { not: "CLOSED" } }, include: { assignments: { include: { user: { include: { station: true } } } } } });
  if (!cases.length) return console.log("No open real cases.");
  for (const kase of cases) {
    const io = kase.assignments.find((a) => a.role === "INVESTIGATING_OFFICER")?.user ?? kase.assignments[0]?.user;
    const ref = `${kase.referenceType === "FIR" ? "FIR" : "Complaint"} ${kase.firNumber ?? kase.complaintRef}/${kase.firYear}`;
    if (!io) {
      console.log(`${ref}: no officer assigned; skipped.`);
      continue;
    }
    const user: SessionUser = { id: io.id, username: io.username, displayName: io.displayName, rank: io.rank, role: io.role as SessionUser["role"], stationId: io.stationId, stationCode: io.station.code, stationName: io.station.name };
    const since = now();
    const summary = await db.$transaction((tx) => refreshRecommendationsTx(tx, kase.id, user.id));
    let rerouted = 0;
    const flagged: string[] = [];
    const drafts = await db.request.findMany({ where: { caseId: kase.id, status: { in: UNSENT }, recipient: { isSynthetic: true, organisationType: { notIn: DEPARTMENTAL } } }, include: { recipient: true, subjects: true } });
    for (const r of drafts) {
      const task = await db.task.findFirst({ where: { caseId: kase.id, requestId: r.id } });
      // A draft whose action was replaced (a preservation request now asked as a details request) is taken over by
      // the new action below, not re-addressed as it was.
      if (task && !ACTIVE.includes(task.status)) continue;
      try {
        if (!task) throw new AppError("No next action is linked to it.", "PRECONDITION");
        await prepareDraftFromTask(db, user, task.id, { asAssistant: true });
        rerouted++;
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await flagDraftsForReview(db, kase.id, r.subjects.map((s) => s.entityId), `Addressed to the demonstration directory entry "${r.recipient.organisation}", which is not a real recipient. ${err.message}`);
        flagged.push(`${r.reference}: ${err.message}`);
      }
    }
    const auto = await autoDraftRequests(db, user, kase.id, { since });
    console.log(`${ref}: ${summary.created} proposed, ${summary.updated} updated, ${summary.resolved} closed; ${auto.drafted.length} drafted${auto.drafted.length ? ` (${auto.drafted.map((d) => d.reference).join(", ")})` : ""}; ${rerouted} re-addressed${flagged.length ? `; marked for review: ${flagged.join(" | ")}` : ""}.`);
  }
}
main();
