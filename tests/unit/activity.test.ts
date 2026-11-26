import { describe, expect, it } from "vitest";
import { activityCategory, isDiaryEvent } from "@/domain/activity";

describe("activity categories", () => {
  it("groups actions by the part of the investigation they change", () => {
    expect(activityCategory("case.created")).toBe("CASE");
    expect(activityCategory("evidence.uploaded")).toBe("CASE");
    expect(activityCategory("extraction.applied")).toBe("CASE");
    expect(activityCategory("request.submitted")).toBe("REQUESTS");
    expect(activityCategory("response.applied")).toBe("REQUESTS");
    expect(activityCategory("funds.hold_confirmed")).toBe("FUNDS");
    expect(activityCategory("task.recommended")).toBe("ACTIONS");
    expect(activityCategory("relationship.added")).toBe("INVESTIGATION");
    expect(activityCategory("entity.verification_changed")).toBe("INVESTIGATION");
    expect(activityCategory("report.reviewed")).toBe("REPORTS");
    expect(activityCategory("activity.correction_recorded")).toBe("REPORTS");
  });

  it("keeps who looked at what separate from what changed", () => {
    expect(activityCategory("evidence.accessed")).toBe("ACCESS");
    expect(activityCategory("report.exported")).toBe("ACCESS");
    expect(activityCategory("auth.signed_in")).toBe("ACCESS");
  });
});

describe("case diary selection", () => {
  it("includes investigation steps taken by officers", () => {
    expect(isDiaryEvent({ action: "request.submitted", actorId: "u1" })).toBe(true);
    expect(isDiaryEvent({ action: "funds.hold_confirmed", actorId: "u1" })).toBe(true);
    expect(isDiaryEvent({ action: "activity.correction_recorded", actorId: "u1" })).toBe(true);
  });

  it("leaves out automatic recommendations, record access and report housekeeping", () => {
    expect(isDiaryEvent({ action: "task.recommended", actorId: null })).toBe(false);
    expect(isDiaryEvent({ action: "evidence.accessed", actorId: "u1" })).toBe(false);
    expect(isDiaryEvent({ action: "report.created", actorId: "u1" })).toBe(false);
    expect(isDiaryEvent({ action: "graph.reviewed", actorId: "u1" })).toBe(false);
  });
});
