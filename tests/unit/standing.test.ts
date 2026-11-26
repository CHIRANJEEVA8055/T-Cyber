import { describe, expect, it } from "vitest";
import { caseStanding, type StandingFacts } from "@/domain/standing";

const now = new Date("2026-11-09T06:00:00Z");
const L = (r: number) => BigInt(r) * 100n;

function facts(over: Partial<StandingFacts> = {}): StandingFacts {
  return {
    drafts: [],
    awaitingSupervisor: 0,
    failedSends: [],
    decisions: [],
    repliesToMatch: [],
    repliesToCheck: [],
    holdsExpiring: [],
    remindersDue: [],
    waitingOn: [],
    callbacks: null,
    refunds: { creditedMinor: 0n, pipelineMinor: 0n },
    blockedTitles: [],
    ...over,
  };
}

describe("where a case stands", () => {
  it("puts approvals first and says what they unblock (FIR 412/2026)", () => {
    const s = caseStanding(
      facts({
        drafts: [
          { ref: "R.REQ-412/2026-007", short: "Bank B statement" },
          { ref: "R.REQ-412/2026-008", short: "UNICROSS CDR" },
        ],
        repliesToMatch: [{ org: "Bank C", firCount: 4 }],
        decisions: [{ kind: "ALLOC", title: "Decide how the ₹80,000 is split between the two victims", why: "Both victims paid into Account A" }],
        blockedTitles: ["CCTV"],
        waitingOn: [{ org: "UNICROSS" }, { org: "NPCI" }],
      }),
      now,
    );
    expect(s.pill).toEqual({ text: "2 approvals waiting", tone: "wait" });
    expect(s.status).toBe("action");
    expect(s.actions.map((a) => [a.what, a.why, a.when.text, a.when.tone])).toEqual([
      ["Check and approve 2 requests", "R.REQ-412/2026-007 Bank B statement, R.REQ-412/2026-008 UNICROSS CDR. They are written and waiting for you. CCTV can only start after this.", "Today", "wait"],
      ["Say which request a reply from Bank C answers", "It mentions 4 FIRs, so it cannot be filed on its own.", "Reply", "info"],
      ["Decide how the ₹80,000 is split between the two victims", "Both victims paid into Account A", "Decide", "wait"],
    ]);
  });

  it("warns about a hold that is about to lapse (FIR 398/2026)", () => {
    const s = caseStanding(facts({ holdsExpiring: [{ amountMinor: L(180000), org: "Bank D", expiresAt: new Date("2026-11-11T18:29:00Z") }], waitingOn: [{ org: "Bank D" }] }), now);
    expect(s.pill).toEqual({ text: "Hold expires in 2 days", tone: "gap" });
    expect(s.status).toBe("hold");
    expect(s.actions[0]).toMatchObject({ what: "The freeze on ₹1,80,000 at Bank D ends in 2 days", why: "Ask the court or the bank to extend it, or start returning the money to the victim.", when: { text: "2 days", tone: "gap" } });
  });

  it("reports money returned, or a restoration filed, once nothing needs the officer", () => {
    expect(caseStanding(facts({ refunds: { creditedMinor: L(120000), pipelineMinor: 0n }, waitingOn: [{ org: "Bank D" }] }), now).pill).toEqual({ text: "₹1,20,000 returned", tone: "ok" });
    expect(caseStanding(facts({ refunds: { creditedMinor: 0n, pipelineMinor: L(20000) } }), now)).toMatchObject({ pill: { text: "Restoration filed", tone: "ok" }, status: "done" });
  });

  it("says who it is waiting on, and lists a complainant's calls as an action without changing the standing (FIR 391/2026)", () => {
    const s = caseStanding(facts({ waitingOn: [{ org: "NPCI" }, { org: "UNICROSS" }], callbacks: { count: 2, lastChangeAt: new Date("2026-11-03T05:00:00Z") } }), now);
    expect(s.pill).toEqual({ text: "Waiting on 2 replies", tone: "neutral" });
    expect(s.status).toBe("waiting");
    expect(s.actions).toEqual([expect.objectContaining({ what: "Call the complainant back", why: "They called twice asking for an update; the case last changed on 03 Nov.", when: { text: "Call", tone: "neutral" } })]);
    expect(caseStanding(facts({ waitingOn: [{ org: "NPCI" }] }), now).pill).toEqual({ text: "Waiting on NPCI", tone: "neutral" });
  });

  it("flags a reminder that is due, saying whether it is drafted (FIR 377/2026)", () => {
    const s = caseStanding(facts({ remindersDue: [{ ref: "R.REQ-412/2026-004", org: "Bank F", what: "statement", days: 13, drafted: true, missing: null }], waitingOn: [{ org: "Bank F" }] }), now);
    expect(s.pill).toEqual({ text: "Reminder due", tone: "wait" });
    expect(s.actions[0]).toMatchObject({ what: "Bank F has not answered R.REQ-412/2026-004 for 13 days", why: "It asked for the statement. A reminder is written for you: check and send it.", when: { text: "Remind", tone: "wait" } });
  });

  it("names what is still missing from a reply that answered only in part (FIR 412/2026's KYC)", () => {
    const s = caseStanding(facts({ remindersDue: [{ ref: "H.REQ-412/2026-001", org: "Bank A", what: "statement, KYC, hold", days: 6, drafted: true, missing: "the KYC" }] }), now);
    expect(s.actions[0]).toMatchObject({ what: "Ask Bank A again for the KYC", why: "They answered H.REQ-412/2026-001 but left this out. A reminder is written for you: check and send it.", when: { text: "Remind", tone: "wait" } });
  });

  it("asks for a resend when a submission failed, before anything else", () => {
    const s = caseStanding(facts({ failedSends: [{ ref: "R.REQ-412/2026-008", org: "UNICROSS" }], drafts: [{ ref: "R.REQ-412/2026-007", short: "Bank B statement" }] }), now);
    expect(s.actions[0]).toMatchObject({ what: "Send R.REQ-412/2026-008 to UNICROSS again", why: "The last try did not go through, so it has not reached them yet.", when: { text: "Today", tone: "gap" } });
  });

  it("has nothing to say when nothing is open", () => {
    expect(caseStanding(facts(), now)).toMatchObject({ pill: { text: "No open requests", tone: "neutral" }, status: "waiting", actions: [] });
  });
});
