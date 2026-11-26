import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { istInputToUtc } from "@/domain/time";
import type { SessionUser } from "@/server/auth/session";
import { importInboxMessage } from "@/server/services/inbox";
import { applyResponse, decideFinding } from "@/server/services/responses";
import { getRequestsView } from "@/server/services/requests-view";
import { getPeopleView } from "@/server/services/people-view";

const db = getDb();
const at = istInputToUtc("2026-11-09T11:30")!;
let fir412 = "";

async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER", stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("a telecom reply (CDR and CAF) read in from the station inbox", () => {
  it("lists the unread replies for the case with how well each matches", async () => {
    const v = await getRequestsView(db, await user("officer1"), fir412, at);
    expect(v.inbox.map((m) => [m.from, m.looksLike, m.attachments])).toEqual([
      ["UNICROSS, Zonal ACP Madhapur", "a reply to R.REQ-412/2026-002", 2],
      ["NPCI", "an acknowledgement of R.REQ-412/2026-004", 0],
    ]);
    expect(v.rows[0]).toMatchObject({ kind: "reply", refSub: "not matched yet", pill: { text: "Needs a match" } });
  });

  it("reads the CAF's subscriber and the CDR's daily contacts, the call to the victim, the cell and the handset", async () => {
    const officer = await user("officer1");
    const msg = (await getRequestsView(db, officer, fir412, at)).inbox[0]!;
    const res = await importInboxMessage(db, officer, fir412, msg.id, { requestId: msg.requestId });
    const r = await db.response.findUniqueOrThrow({ where: { id: res.responseId }, include: { findings: { orderBy: { sortOrder: "asc" } } } });
    expect(r.matchStatus).toBe("MATCHED");
    const summaries = r.findings.map((f) => f.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Call records of \+91-XXXXXXXX87: 1,214 calls and messages/),
        expect.stringMatching(/^\+91-XXXXXXXX41 was in touch with \+91-XXXXXXXX87 on 19 of 19 days \(already in the case/),
        expect.stringMatching(/^\+91-XXXXXXXX63 was in touch/),
        expect.stringMatching(/^\+91-XXXXXXXX08 was in touch/),
        expect.stringMatching(/^\+91-XXXXXXXX87 called .* 2 times on 02 Nov at 10:36 and 10:51$/),
        expect.stringMatching(/^\+91-XXXXXXXX87 used cell CYB-KKP-0221C/),
        "+91-XXXXXXXX87 was used in one handset, IMEI 35XXXXXXXXXX614",
        "CAF: +91-XXXXXXXX87 is registered to Suresh K (synthetic), activated 12 Oct 2026",
      ]),
    );
    expect(r.suggestedType).toBe("COMPLETE");

    for (const f of r.findings) await decideFinding(db, officer, f.id, { decision: "ACCEPTED" });
    const fresh = await db.response.findUniqueOrThrow({ where: { id: r.id } });
    await applyResponse(db, officer, r.id, { responseType: "COMPLETE", expectedVersion: fresh.version });

    const people = await getPeopleView(db, officer, fir412, at);
    expect(people.people.find((p) => p.name === "Suresh K")).toMatchObject({ label: "Suresh K (P3)", code: "P3", sub: "Subscriber of Mobile +91-XXXXXXXX87" });
    expect(people.statements.map((s) => s.title)).toContain("Suresh K (P3) is the subscriber on record of Mobile +91-XXXXXXXX87");
    expect(people.rows.find((x) => x.name === "Mobile +91-XXXXXXXX87")!.status.text).not.toBe("Waiting on UNICROSS");
    expect(people.sightings.some((s) => s.title.startsWith("Cell CYB-KKP-0221C"))).toBe(true);
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, caseSeq: 2 }, include: { items: true } });
    expect(req.status).toBe("COMPLETE_RESPONSE");
    expect(req.items.every((i) => i.status === "RECEIVED")).toBe(true);
  });
});
