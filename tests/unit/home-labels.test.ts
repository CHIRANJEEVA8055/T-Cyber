import { describe, expect, it } from "vitest";
import { helloActions, homeLabels } from "@/features/station/labels";

const base = { name: "Inspector R. Devi", partOfDay: "evening" as const, overnight: 0, lost6Cases: 109, from: "June", to: "November", heldAccounts: 21, firs: { open: 11, closed: 3 } };

describe("the home page's greeting line", () => {
  it("counts only the cases in My cases as 'your cases'", () => {
    expect(helloActions({ actions: 21, mine: 11, own: { actions: 20, cases: 11 }, other: { actions: 1, cases: 1 } })).toBe("21 actions need you today: 20 in all 11 of your cases, and 1 in another officer's case.");
    expect(helloActions({ actions: 27, mine: 12, own: { actions: 27, cases: 10 }, other: { actions: 0, cases: 0 } })).toBe("27 actions need you today, in 10 of your 12 cases.");
    expect(helloActions({ actions: 3, mine: 0, own: { actions: 0, cases: 0 }, other: { actions: 3, cases: 2 } })).toBe("3 actions need you today, in 2 other officers' cases.");
    expect(helloActions({ actions: 1, mine: 1, own: { actions: 1, cases: 1 }, other: { actions: 0, cases: 0 } })).toBe("1 action needs you today, in your case.");
    expect(helloActions({ actions: 0, mine: 4, own: { actions: 0, cases: 0 }, other: { actions: 0, cases: 0 } })).toBe("Nothing needs you today.");
  });

  it("names the cards in words: the actions, and My FIRs", () => {
    const L = homeLabels("en", { ...base, actions: 21, actionCases: 12, mine: 11, own: { actions: 20, cases: 11 }, other: { actions: 1, cases: 1 } });
    expect(L.helloSub).toBe("21 actions need you today: 20 in all 11 of your cases, and 1 in another officer's case. No replies arrived since yesterday evening.");
    expect(L.needSub).toBe("to do today, across 12 cases");
    expect(L.firs).toBe("My FIRs");
    expect(L.firsSub).toBe("open now · 3 closed");
    expect(L.trendsT).toBe("Trends");
  });

  it("has the Telugu line say the same numbers", () => {
    const L = homeLabels("te", { ...base, actions: 21, actionCases: 12, mine: 11, own: { actions: 20, cases: 11 }, other: { actions: 1, cases: 1 } });
    for (const n of ["21", "11", "20", "1"]) expect(L.helloSub).toContain(n);
    expect(L.needSub).toContain("12");
  });
});
