import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { updateCaseDetails } from "@/server/services/cases";
import { getCaseHome } from "@/server/services/case-home";
import { getCaseHeader } from "@/server/services/overview";
import { getDashboard } from "@/server/services/dashboard";

const db = getDb();
let fir412 = "";
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("a case's investigation vertical", () => {
  it("is read from the facts until an officer sets it", async () => {
    const o = await getCaseHome(db, await user("officer1"), fir412);
    const mo = o.facts.find((f) => f.label === "Modus operandi")!;
    expect(mo.value).toMatch(/^Investment Frauds/);
    expect(mo.sub).toMatch(/vertical read from the facts/);
    const h = await getCaseHeader(db, await user("officer1"), fir412);
    expect(h.mo).toMatchObject({ vertical: null });
    expect(h.mo.line).toMatch(/^Investment Frauds/);
    const d = await getDashboard(db, await user("officer1"));
    expect(d.rows.find((r) => r.id === fir412)?.type).toBe("INVESTMENT");
  });

  it("can be set by an officer, is logged, and can go back to the facts", async () => {
    const officer = await user("officer1");
    let c = await db.case.findUniqueOrThrow({ where: { id: fir412 } });
    await updateCaseDetails(db, officer, fir412, { expectedVersion: c.version, title: c.title, narrative: c.narrative, legalSections: c.legalSections, fraudCategory: c.fraudCategory, moVertical: "SOCIAL_MEDIA", moSubtype: "Dating" });
    c = await db.case.findUniqueOrThrow({ where: { id: fir412 } });
    expect(c).toMatchObject({ moVertical: "SOCIAL_MEDIA", moSubtype: "Dating", moBasis: "OFFICER" });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { objectId: fir412, action: "case.details_updated" }, orderBy: { at: "desc" } });
    expect(audit.summary).toContain("moVertical");
    expect(JSON.parse(audit.detailJson ?? "{}").moVertical).toMatchObject({ from: "read from the facts", to: "Social Media Frauds · Dating" });
    const mo = (await getCaseHome(db, officer, fir412)).facts.find((f) => f.label === "Modus operandi")!;
    expect(mo).toMatchObject({ value: "Social Media Frauds · Dating" });
    expect(mo.sub).toMatch(/vertical set by an officer/);
    expect((await getDashboard(db, officer)).rows.find((r) => r.id === fir412)?.type).toBe("SOCIAL_MEDIA");

    await updateCaseDetails(db, officer, fir412, { expectedVersion: c.version, title: c.title, narrative: c.narrative, legalSections: c.legalSections, fraudCategory: c.fraudCategory, moVertical: null });
    expect(await db.case.findUniqueOrThrow({ where: { id: fir412 } })).toMatchObject({ moVertical: null, moSubtype: null, moBasis: null });
  });

  it("accepts only the station's verticals, and leaves the vertical alone when the edit does not mention it", async () => {
    const officer = await user("officer1");
    const c = await db.case.findUniqueOrThrow({ where: { id: fir412 } });
    await expect(updateCaseDetails(db, officer, fir412, { expectedVersion: c.version, title: c.title, narrative: c.narrative, legalSections: c.legalSections, fraudCategory: c.fraudCategory, moVertical: "CRYPTO" })).rejects.toMatchObject({ code: "VALIDATION" });
    await updateCaseDetails(db, officer, fir412, { expectedVersion: c.version, title: c.title, narrative: c.narrative, legalSections: c.legalSections, fraudCategory: c.fraudCategory, moVertical: "OTP", moSubtype: "Trading" });
    const after = await db.case.findUniqueOrThrow({ where: { id: fir412 } });
    // "Trading" is not a kind under OTP Frauds, so it is not kept.
    expect(after).toMatchObject({ moVertical: "OTP", moSubtype: null });
    await updateCaseDetails(db, officer, fir412, { expectedVersion: after.version, title: `${after.title} `, narrative: `${after.narrative} Updated.`, legalSections: after.legalSections, fraudCategory: after.fraudCategory });
    expect(await db.case.findUniqueOrThrow({ where: { id: fir412 } })).toMatchObject({ moVertical: "OTP" });
  });

  it("groups the month's complaints by vertical on the station trends", async () => {
    const d = await getDashboard(db, await user("supervisor"));
    const labels = d.trends.kinds.groups.map((g) => g.label);
    for (const l of labels) expect(["Investment Frauds", "Advertisement Fraud", "Job Frauds", "Business Frauds", "OTP Frauds", "Social Media Frauds", "Miscellaneous", "Not classified"]).toContain(l);
  });
});
