import { describe, expect, it } from "vitest";
import { classifyCaseQuestion, findMentions } from "@/domain/assistant";
import { activityCategory } from "@/domain/activity";

describe("case assistant: what is being asked", () => {
  it("recognises the four kinds of question the case assistant answers", () => {
    expect(classifyCaseQuestion("What changed since last week?")).toBe("WHAT_CHANGED");
    expect(classifyCaseQuestion("What is still missing?")).toBe("MISSING");
    expect(classifyCaseQuestion("Which facts are supported by evidence?")).toBe("SUPPORTED");
    expect(classifyCaseQuestion("What should I review next?")).toBe("NEXT");
  });

  it("sends money questions to the ledger", () => {
    expect(classifyCaseQuestion("How much has been secured for the victim?")).toBe("MONEY");
    expect(classifyCaseQuestion("Which holds are confirmed?")).toBe("MONEY");
    expect(classifyCaseQuestion("how much is outstanding")).toBe("MONEY");
  });

  it("offers help instead of guessing when the question is not one it can answer", () => {
    expect(classifyCaseQuestion("hello")).toBe("HELP");
    expect(classifyCaseQuestion("Write the chargesheet for me")).toBe("HELP");
  });
});

describe("case assistant: which records a question is about", () => {
  const records = [
    { id: "a", label: "Account A", value: "XXXXXXXX4821" },
    { id: "b", label: "Account B", value: "XXXXXXXX0937" },
    { id: "p", label: "+91-XXXXXX7731", value: "+91-XXXXXX7731" },
  ];
  const requests = [{ id: "r4", reference: "R.REQ-412/2026-004" }];

  it("finds records by name or by recorded value, whole words only", () => {
    expect(findMentions("What do we know about account b?", records, requests)).toEqual({ entityIds: ["b"], requestIds: [] });
    expect(findMentions("Is XXXXXXXX4821 still holding money?", records, requests)).toEqual({ entityIds: ["a"], requestIds: [] });
    expect(findMentions("Who uses +91-XXXXXX7731?", records, requests)).toEqual({ entityIds: ["p"], requestIds: [] });
    expect(findMentions("Tell me about Account Bravo", records, requests)).toEqual({ entityIds: [], requestIds: [] });
  });

  it("matches a name without its bracketed qualifier", () => {
    const people = [{ id: "h", label: "Demo Holder A (synthetic)", value: "Demo Holder A (synthetic)" }];
    expect(findMentions("What do we know about Demo Holder A?", people, [])).toEqual({ entityIds: ["h"], requestIds: [] });
  });

  it("finds requests by reference", () => {
    expect(findMentions("Where does req-412/2026-004 stand?", records, requests)).toEqual({ entityIds: [], requestIds: ["r4"] });
  });
});

describe("assistant questions in the activity record", () => {
  it("are kept with access to records, not with changes", () => {
    expect(activityCategory("assistant.case_question")).toBe("ACCESS");
    expect(activityCategory("assistant.guidance_question")).toBe("ACCESS");
  });
});
