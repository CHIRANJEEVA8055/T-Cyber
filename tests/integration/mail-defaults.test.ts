import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { getRequestDetail } from "@/server/services/correspondence";
import { approveAndSend, updateDraft } from "@/server/services/requests";
import { mailDefaultsFor, setMailDefaults } from "@/server/services/mail-defaults";
import { prepareDraftFromTask } from "@/server/services/drafting";
import { getAppConfig } from "@/server/config";
import { buildWorld } from "../support/fixtures";
import { refreshRecommendations } from "@/server/services/tasks";
import { addManualTransaction, upsertClaim } from "@/server/services/funds";

/** A small case with a hold to propose: the bank is known and a route is set up. */
async function holdWorld() {
  const w = await buildWorld();
  const victimAcct = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "BANK_ACCOUNT", label: "Victim account", value: "XXXXXXXX3390", normalizedValue: "XXXXXXXX3390", discoveredAt: new Date() } });
  const victim = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Victim", value: "Victim", normalizedValue: "person:m", discoveredAt: new Date() } });
  const claim = await upsertClaim(w.db, w.officer, w.kase.id, { victimEntityId: victim.id, lossRupees: "10,00,000", basis: "Complaint" });
  await addManualTransaction(w.db, w.officer, w.kase.id, { fromEntityId: victimAcct.id, toEntityId: w.account.id, amountRupees: "10,00,000", occurredAt: "2026-10-03T11:42", channel: "IMPS", reference: "DEMOUTR0001", kind: "VICTIM_PAYMENT", claimId: claim.id, sourceNote: "FIR" });
  await refreshRecommendations(w.db, w.officer, w.kase.id);
  return { ...w, hold: await w.db.task.findFirstOrThrow({ where: { caseId: w.kase.id, dedupeKey: `HOLD:${w.account.id}` } }) };
}

/**
 * The From address and the closing of a request: set on a draft, kept with its version (and its approval), used
 * when it is sent, and offered as the officer's own default for new drafts.
 */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
let fir412 = "";
beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

const MINE = "si.krishna@police.example.invalid";

describe("the From address and closing of a request", () => {
  it("is set on a draft, kept with its version and its fingerprint, and used when it is sent", async () => {
    const officer = await user("officer1");
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, status: "DRAFT", recipient: { verificationStatus: "VERIFIED" } } });
    const before = await getRequestDetail(db, officer, req.id);
    expect(before.current.fromAddress).toBe(getAppConfig().mailbox.fromAddress);
    expect(before.mail.own).toEqual({ from: false, closing: false });

    const edit = { expectedVersion: before.version, recipientId: before.current.recipientId, subject: before.current.subject, body: before.current.body, scope: before.current.scope, periodFrom: before.current.periodFrom ? new Date(before.current.periodFrom) : null, periodTo: before.current.periodTo ? new Date(before.current.periodTo) : null, items: before.current.items, attachmentIds: before.current.attachmentIds };
    await expect(updateDraft(db, officer, req.id, { ...edit, fromAddress: "not an address" })).rejects.toMatchObject({ code: "VALIDATION", fieldErrors: { fromAddress: expect.any(String) } });
    const saved = await updateDraft(db, officer, req.id, { ...edit, fromAddress: MINE });
    const after = await getRequestDetail(db, officer, req.id);
    expect(after.current.fromAddress).toBe(MINE);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.hashIntact).toBe(true);

    const sent = await approveAndSend(db, await user("supervisor"), req.id, { expectedVersion: saved.version, idempotencyKey: "mail-default-1" });
    expect(sent.outcome).toBe("SUCCEEDED");
    expect((await db.submission.findFirstOrThrow({ where: { requestId: req.id } })).adapter).toContain(`from ${MINE}`);
  });

  it("can become the officer's default, which new drafts then start with", async () => {
    const officer = await user("officer1");
    const m = await setMailDefaults(db, officer, { fromAddress: MINE, closing: "Yours sincerely,\nKrishna\nSub-Inspector of Police, PS Madhapur" });
    expect(m).toMatchObject({ from: MINE, own: { from: true, closing: true }, closing: ["Yours sincerely,", "Krishna", "Sub-Inspector of Police, PS Madhapur"] });
    expect(await db.auditEvent.count({ where: { actorId: officer.id, action: "user.mail_defaults_changed" } })).toBe(1);

    const w = await holdWorld();
    const draft = await prepareDraftFromTask(w.db, w.officer, w.hold.id);
    const v = await w.db.requestVersion.findFirstOrThrow({ where: { requestId: draft.id } });
    // The fixture's officer has no defaults of their own: the station mailbox and closing.
    expect(v.fromAddress).toBeNull();
    expect(v.body).toMatch(/Yours faithfully,\n.+, .+\n/);
    const mine = await setMailDefaults(w.db, w.officer, { fromAddress: MINE, closing: "Yours sincerely,\nInvestigating Officer\nPS Madhapur" });
    expect(mine.own).toEqual({ from: true, closing: true });
    const w2 = await holdWorld();
    await setMailDefaults(w2.db, w2.officer, { fromAddress: MINE, closing: "Yours sincerely,\nInvestigating Officer\nPS Madhapur" });
    const v2 = await w2.db.requestVersion.findFirstOrThrow({ where: { requestId: (await prepareDraftFromTask(w2.db, w2.officer, w2.hold.id)).id } });
    expect(v2.fromAddress).toBe(MINE);
    expect(v2.body.endsWith("Yours sincerely,\nInvestigating Officer\nPS Madhapur")).toBe(true);
    // Another officer's drafts are not affected.
    expect((await mailDefaultsFor(db, await user("supervisor"))).own).toEqual({ from: false, closing: false });
  });

  it("goes back to the station mailbox and closing, which new drafts then end with", async () => {
    const officer = await user("officer1");
    const m = await setMailDefaults(db, officer, { fromAddress: null, closing: null });
    expect(m).toMatchObject({ from: getAppConfig().mailbox.fromAddress, own: { from: false, closing: false } });
    expect(m.closing[0]).toBe("Yours faithfully,");
    expect(m.closing[1]).toBe(`${officer.displayName}, ${officer.rank}`);
    const w = await holdWorld();
    await setMailDefaults(w.db, w.officer, { fromAddress: MINE });
    await setMailDefaults(w.db, w.officer, { fromAddress: null, closing: null });
    const v = await w.db.requestVersion.findFirstOrThrow({ where: { requestId: (await prepareDraftFromTask(w.db, w.officer, w.hold.id)).id } });
    expect(v.fromAddress).toBeNull();
    expect(v.body.endsWith((await mailDefaultsFor(w.db, w.officer)).closing.join("\n"))).toBe(true);
    await expect(setMailDefaults(db, officer, { fromAddress: "nope" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
