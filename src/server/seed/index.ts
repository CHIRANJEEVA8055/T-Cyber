import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db";
import type { SessionUser } from "../auth/session";
import { setClock } from "../clock";
import { recordAudit } from "../audit";
import { KNOWLEDGE_AREA, storageRoot } from "../storage";
import { refreshRecommendationsTx } from "../services/tasks";
import { seedDirectory } from "./directory";
import { seedFir412, type Actors } from "./scenario";
import { seedStationCases } from "./station";
import { seedAwaitingFir, seedHistory } from "./history";
import { demoAnchor, makeTimeline } from "./timeline";

function asSessionUser(u: { id: string; username: string; displayName: string; rank: string; role: string; stationId: string }, station: { code: string; name: string }): SessionUser {
  return { id: u.id, username: u.username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: station.code, stationName: station.name };
}

/**
 * Seeds the synthetic demonstration by running the real workflows at historical times, relative to a "today"
 * (see timeline.ts). `anchor` (YYYY-MM-DD) pins that day, for tests.
 */
export async function seedDemo(db: Db, opts: { anchor?: string } = {}) {
  const T = makeTimeline(opts.anchor ?? demoAnchor());
  try {
    const { station, officer1, officer2, officer3, supervisor } = await seedDirectory(db, T);
    const actors: Actors = { krishna: asSessionUser(officer1, station), lavanya: asSessionUser(officer2, station), arjun: asSessionUser(officer3, station), devi: asSessionUser(supervisor, station) };
    const fir412 = await seedFir412(db, T, actors);
    await seedStationCases(db, T, actors);
    await seedAwaitingFir(db, T);
    await seedHistory(db, T, actors);
    // Bring time-based next actions (reminders now due, holds about to lapse) up to the present: the real present
    // for the live demonstration, and a fixed one (the anchor day, 11:30 IST) when a test pins the anchor, so a test's
    // data never depends on the time of day it runs.
    setClock(opts.anchor ? T.at(0, "11:30") : null);
    const open = await db.case.findMany({ where: { status: "OPEN" }, select: { id: true } });
    for (const c of open) await db.$transaction((tx) => refreshRecommendationsTx(tx, c.id, null));
    return { fir412Id: fir412.id, anchor: T.anchor };
  } finally {
    setClock(null);
  }
}

const WIPE_ORDER = [
  "chatMessage",
  "chatThread",
  "chatUpload",
  "notificationRead",
  "caseHandover",
  "contactLog",
  "allocationDecision",
  "inboxMessage",
  "complaint",
  "responseFinding",
  "submission",
  "approval",
  "requestNote",
  "requestItem",
  "requestSubject",
  "requestVersion",
  "evidenceSegment",
  "processingEvent",
  "extractionCandidate",
  "extractionRun",
  "sourceAssertion",
] as const;

/** Removes all data. Only called after explicit confirmation (CLI prompt or Settings dialog). */
export async function wipeAll(db: Db) {
  await db.$transaction(async (tx) => {
    await tx.counter.upsert({ where: { key: "demo_reset_in_progress" }, create: { key: "demo_reset_in_progress", value: 1 }, update: { value: 1 } });
    for (const model of WIPE_ORDER) {
      await (tx[model] as unknown as { deleteMany: () => Promise<unknown> }).deleteMany();
    }
    await tx.evidenceItem.deleteMany({ where: { parentId: { not: null } } });
    await tx.evidenceItem.deleteMany();
    await tx.response.deleteMany();
    await tx.request.deleteMany();
    await tx.holdEvent.deleteMany();
    await tx.allocation.deleteMany();
    await tx.refund.deleteMany();
    await tx.hold.deleteMany();
    await tx.transaction.deleteMany();
    await tx.relationship.deleteMany();
    await tx.locationObservation.deleteMany();
    await tx.partyRole.deleteMany();
    await tx.task.deleteMany();
    await tx.reportVersion.deleteMany();
    await tx.report.deleteMany();
    await tx.reviewMarker.deleteMany();
    // The knowledge base and the assistant's ready questions are the station's, not demonstration data: they and
    // their history survive a reset (the developer keeps them).
    await tx.auditEvent.deleteMany({ where: { NOT: [{ action: { startsWith: "knowledge." } }, { action: { startsWith: "prompt." } }] } });
    await tx.victimClaim.deleteMany();
    await tx.entity.deleteMany();
    await tx.caseAssignment.deleteMany();
    await tx.case.deleteMany();
    await tx.session.deleteMany();
    await tx.user.deleteMany();
    await tx.station.deleteMany();
    await tx.routingRule.deleteMany();
    await tx.template.deleteMany();
    await tx.recipient.deleteMany();
    await tx.integrationSetting.deleteMany();
    await tx.counter.deleteMany({ where: { key: { not: "demo_reset_in_progress" } } });
    await tx.counter.delete({ where: { key: "demo_reset_in_progress" } });
  });
  const root = storageRoot();
  // Safety: only ever clear a directory named "storage" inside the project.
  if (path.basename(root) === "storage" && root.startsWith(path.resolve(/*turbopackIgnore: true*/ process.cwd()) + path.sep) && fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root)) if (entry !== KNOWLEDGE_AREA) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

export async function resetDemo(db: Db, actorId: string | null) {
  await wipeAll(db);
  const ids = await seedDemo(db);
  await db.$transaction((tx) =>
    recordAudit(tx, { caseId: ids.fir412Id, actorId: null, action: "demo.reset", objectType: "System", summary: `Demonstration data reset and reseeded${actorId ? " at the request of a supervisor" : " from the command line"}` }),
  );
  return ids;
}
