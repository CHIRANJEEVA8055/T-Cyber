import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { getCaseContext } from "@/server/services/case-context";
import { getPeopleView } from "@/server/services/people-view";
import { buildCaseContext } from "@/server/ai/context";
import { groundingFacts } from "@/server/ai/grounded";

/** A case's whole context in one place, and the money-trail levels of its identifiers (demonstration case 412). */
const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
let fir412 = "";
beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("the case context", () => {
  it("holds the case, the money trail, every mail with what came back, and what is pending", async () => {
    const ctx = await getCaseContext(db, await user("officer1"), fir412);
    expect(ctx.ref).toBe("FIR 412/2026");
    expect(ctx.facts.find((f) => f.label.startsWith("Sections"))?.value).toBeTruthy();
    expect(ctx.trail[0]!.level).toBe(1);
    expect(ctx.trail.length).toBeGreaterThanOrEqual(2);
    expect(ctx.mails.length).toBeGreaterThanOrEqual(5);
    const answered = ctx.mails.find((m) => m.replies.length > 0)!;
    expect(answered.replies[0]!.from).toMatch(/@/);
    expect(answered.asks.length).toBeGreaterThan(0);
    expect(ctx.pending.length).toBeGreaterThan(0);
    expect(ctx.text).toContain("MAILS SENT AND WHAT CAME BACK");
    expect(ctx.text).toContain("MONEY TRAIL");
    expect(ctx.text).toMatch(/Level 1: /);
    expect(ctx.sides.victim.length).toBeGreaterThan(0);
  });

  it("is what the case assistant's local model is given about the mails", async () => {
    const c = await buildCaseContext(db, await user("officer1"), fir412);
    const { facts } = groundingFacts(c);
    expect(facts.some((f) => /^[PRHU]\.REQ-412\/2026-0\d\d\b/.test(f.text) && f.refs[0]?.href.includes("/requests/"))).toBe(true);
  });

  it("is only for officers who may read the case", async () => {
    const other = await db.user.findFirst({ where: { role: "OFFICER", NOT: { assignments: { some: { caseId: fir412 } } } }, include: { station: true } });
    if (!other) return;
    const u: SessionUser = { id: other.id, username: other.username, displayName: other.displayName, rank: other.rank, role: other.role as SessionUser["role"], stationId: other.stationId, stationCode: other.station.code, stationName: other.station.name };
    await expect(getCaseContext(db, u, fir412)).rejects.toThrow();
  });
});

describe("people and identifiers by their place in the money trail", () => {
  it("gives each account its level, numbers linked to an account that account's level, and the victim's own none", async () => {
    const v = await getPeopleView(db, await user("officer1"), fir412);
    expect(v.deepest).toBeGreaterThanOrEqual(2);
    const levels = v.rows.filter((r) => r.trail).map((r) => r.trail!.level);
    expect(levels).toContain(1);
    expect(levels).toContain(2);
    for (const r of v.rows.filter((x) => x.side === "VICTIM")) expect(r.trail).toBeNull();
    for (const r of v.rows.filter((x) => x.trail)) expect(r.side).toBe("ACCUSED");
    const linked = v.rows.find((r) => r.trail?.linkedTo);
    if (linked) expect(linked.kind).not.toBe("BANK_ACCOUNT");
  });
});
