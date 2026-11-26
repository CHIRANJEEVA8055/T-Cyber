import { describe, expect, it } from "vitest";
import { deriveRecommendations, explainResolution, type RecoFacts } from "@/domain/recommendations";

const L = (r: number) => BigInt(r) * 100n;
const d = (iso: string) => new Date(iso);

function acct(id: string, label: string, bank: string, value = `XXXXXXXX${id}`) {
  return { id, kind: "BANK_ACCOUNT", label, value, attributes: { bank }, caseRole: null };
}

/** Shape of FIR 1/2026 after the Bank A response was applied and before Bank B's response is reviewed. */
function facts(): RecoFacts {
  return {
    now: d("2026-10-22T06:00:00Z"),
    entities: [
      { id: "victim", kind: "PERSON", label: "Demo victim", value: "Demo victim", attributes: {}, caseRole: null },
      acct("V", "Victim account", "Demo Bank V"),
      acct("A", "Account A", "Demo Bank A"),
      acct("B", "Account B", "Demo Bank B"),
      acct("C", "Account C", "Demo Bank C"),
      acct("D", "Account D", "Demo Bank D"),
      { id: "ph7731", kind: "PHONE", label: "+91-XXXXXX7731", value: "+91-XXXXXX7731", attributes: {}, caseRole: null },
      { id: "ip", kind: "IP_ADDRESS", label: "203.0.113.45", value: "203.0.113.45", attributes: {}, caseRole: null },
      { id: "profile", kind: "PLATFORM_PROFILE", label: "Messaging profile", value: "tradeprime desk", attributes: {}, caseRole: null },
    ],
    victimAccountIds: ["V"],
    transactions: [
      { id: "t1", fromEntityId: "V", toEntityId: "A", amountMinor: L(1000000), layer: 1, kind: "VICTIM_PAYMENT", occurredAt: d("2026-10-03T06:12:00Z"), reference: "U1" },
      { id: "t2", fromEntityId: "V", toEntityId: "B", amountMinor: L(600000), layer: 1, kind: "VICTIM_PAYMENT", occurredAt: d("2026-10-04T09:40:00Z"), reference: "U2" },
      { id: "t3", fromEntityId: "V", toEntityId: "C", amountMinor: L(400000), layer: 1, kind: "VICTIM_PAYMENT", occurredAt: d("2026-10-06T04:35:00Z"), reference: "U3" },
      { id: "t4", fromEntityId: "A", toEntityId: "D", amountMinor: L(800000), layer: 2, kind: "ONWARD_TRANSFER", occurredAt: d("2026-10-03T07:35:00Z"), reference: "U4" },
    ],
    holds: [
      { id: "hA", accountEntityId: "A", status: "CONFIRMED_HELD", confirmedMinor: L(200000) },
      { id: "hB", accountEntityId: "B", status: "REQUESTED", confirmedMinor: null },
      { id: "hC", accountEntityId: "C", status: "REQUESTED", confirmedMinor: null },
    ],
    allocations: [{ holdId: "hA", amountMinor: L(200000), status: "CONFIRMED" }],
    refunds: [],
    requests: [
      { id: "r1", reference: "REQ-1", category: "HOLD", status: "COMPLETE_RESPONSE", recipientName: "Bank A", subjectEntityIds: ["A"], items: [{ itemType: "HOLD_CONFIRMATION", status: "RECEIVED" }], followUpAt: null, parentRequestId: null },
      { id: "r2", reference: "REQ-2", category: "INFORMATION", status: "COMPLETE_RESPONSE", recipientName: "Bank A", subjectEntityIds: ["A"], items: [{ itemType: "STATEMENT", status: "RECEIVED" }], followUpAt: null, parentRequestId: null },
      { id: "r3", reference: "REQ-3", category: "HOLD", status: "ACKNOWLEDGED", recipientName: "Bank B", subjectEntityIds: ["B"], items: [{ itemType: "HOLD_CONFIRMATION", status: "PENDING" }], followUpAt: d("2026-10-13T06:00:00Z"), parentRequestId: null },
      { id: "r4", reference: "REQ-4", category: "INFORMATION", status: "SUBMITTED", recipientName: "Bank B", subjectEntityIds: ["B"], items: [{ itemType: "STATEMENT", status: "PENDING" }, { itemType: "BALANCE_CONFIRMATION", status: "PENDING" }], followUpAt: d("2026-10-15T06:00:00Z"), parentRequestId: null },
      { id: "r5", reference: "REQ-5", category: "HOLD", status: "ACKNOWLEDGED", recipientName: "Bank C", subjectEntityIds: ["C"], items: [{ itemType: "HOLD_CONFIRMATION", status: "PENDING" }], followUpAt: d("2026-10-15T06:00:00Z"), parentRequestId: null },
      { id: "r6", reference: "REQ-6", category: "INFORMATION", status: "ACKNOWLEDGED", recipientName: "Bank C", subjectEntityIds: ["C"], items: [{ itemType: "STATEMENT", status: "PENDING" }], followUpAt: d("2026-10-30T06:00:00Z"), parentRequestId: null },
      { id: "r7", reference: "REQ-7", category: "HOLD", status: "AWAITING_APPROVAL", recipientName: "Bank D", subjectEntityIds: ["D"], items: [{ itemType: "HOLD_CONFIRMATION", status: "PENDING" }], followUpAt: null, parentRequestId: null },
      { id: "r9", reference: "REQ-9", category: "PRESERVATION", status: "SUBMITTED", recipientName: "Platform", subjectEntityIds: ["profile"], items: [{ itemType: "PRESERVATION_CONFIRMATION", status: "PENDING" }], followUpAt: d("2026-11-30T06:00:00Z"), parentRequestId: null },
    ],
    responses: [{ id: "respB", requestId: "r4", requestReference: "REQ-4", recipientName: "Bank B", reviewStatus: "UNREVIEWED", matchStatus: "MATCHED" }],
    relationships: [{ id: "rel1", fromEntityId: "ph7731", toEntityId: "A", type: "LINKED_IDENTIFIER", statement: "Bank A records +91-XXXXXX7731 as the registered mobile for Account A" }],
    locations: [{ id: "loc1", entityId: "ip", observationType: "IP_LOGIN", limitations: "Source port not provided." }],
    sources: [{ subjectType: "TRANSACTION", subjectId: "t4", evidenceId: "ev-bankA", locator: "Row 3", excerpt: "IMPS onward 8,00,000" }],
  };
}

const byKey = (recs: ReturnType<typeof deriveRecommendations>) => new Map(recs.map((r) => [r.dedupeKey, r]));

describe("deriveRecommendations", () => {
  it("links a hold recommendation to an existing draft instead of duplicating it", () => {
    const rec = byKey(deriveRecommendations(facts())).get("HOLD:D");
    expect(rec).toMatchObject({ status: "DRAFT_PREPARED", requestId: "r7", objective: "FINANCIAL", priority: "HIGH" });
  });

  it("recommends a statement request for an onward recipient with its supporting source", () => {
    const rec = byKey(deriveRecommendations(facts())).get("INFO:D");
    expect(rec?.status).toBe("OPEN");
    expect(rec?.question).toContain("₹8,00,000");
    expect(rec?.supportingSources).toEqual([{ evidenceId: "ev-bankA", locator: "Row 3", excerpt: "IMPS onward 8,00,000" }]);
    expect(rec?.prerequisites.length).toBeGreaterThan(0);
    expect(rec?.expectedClarification).not.toBe("");
  });

  it("does not recommend a hold where the bank has already confirmed one", () => {
    expect(byKey(deriveRecommendations(facts())).has("HOLD:A")).toBe(false);
  });

  it("marks recommendations covered by submitted requests as waiting", () => {
    const recs = byKey(deriveRecommendations(facts()));
    expect(recs.get("HOLD:B")).toMatchObject({ status: "WAITING", requestId: "r3" });
    expect(recs.get("PRESERVE:profile")).toMatchObject({ status: "WAITING", requestId: "r9" });
  });

  it("never recommends action against the victim's own account", () => {
    const keys = [...byKey(deriveRecommendations(facts())).keys()];
    expect(keys.some((k) => k.endsWith(":V"))).toBe(false);
  });

  it("asks for an unreviewed response to be reviewed", () => {
    expect(byKey(deriveRecommendations(facts())).get("REVIEW:respB")).toMatchObject({ kind: "REVIEW", status: "OPEN", priority: "HIGH" });
  });

  it("suggests follow-ups only after the configured follow-up date and when no response is pending review", () => {
    const recs = byKey(deriveRecommendations(facts()));
    expect(recs.has("FOLLOWUP:r5")).toBe(true); // Bank C hold: due 15 Oct, nothing received
    expect(recs.has("FOLLOWUP:r6")).toBe(false); // due 30 Oct, not yet
    expect(recs.has("FOLLOWUP:r4")).toBe(false); // a response is waiting for review
  });

  it("recommends identity work with explicit prerequisites", () => {
    const recs = byKey(deriveRecommendations(facts()));
    expect(recs.get("SUBSCRIBER:ph7731")).toMatchObject({ objective: "IDENTITY", requestCategory: "INFORMATION" });
    const ip = recs.get("IPPORT:ip");
    expect(ip?.objective).toBe("IDENTITY");
    expect(ip?.relevance).toMatch(/source port/i);
  });

  it("proposes restoration only with the unmet authority prerequisite stated", () => {
    const rec = byKey(deriveRecommendations(facts())).get("RESTORE:hA");
    expect(rec?.requestCategory).toBe("RESTORATION");
    expect(rec?.prerequisites.some((p) => !p.met)).toBe(true);
  });

  it("raises missing balance information once a partial response leaves it outstanding", () => {
    const f = facts();
    f.responses = [];
    f.requests = f.requests.map((r) => (r.id === "r4" ? { ...r, status: "PARTIAL_RESPONSE", items: [{ itemType: "STATEMENT", status: "PARTIAL" }, { itemType: "BALANCE_CONFIRMATION", status: "PENDING" }] } : r));
    f.entities.push(acct("E", "Account E", "Demo Bank E"));
    f.transactions.push({ id: "t5", fromEntityId: "B", toEntityId: "E", amountMinor: L(400000), layer: 2, kind: "ONWARD_TRANSFER", occurredAt: d("2026-10-04T10:32:00Z"), reference: "U5" });
    const recs = byKey(deriveRecommendations(f));
    const balance = recs.get("BALANCE:B");
    expect(balance).toMatchObject({ kind: "MISSING_INFORMATION", objective: "FINANCIAL" });
    expect(balance?.question).toContain("₹2,00,000");
    expect(recs.get("HOLD:E")?.status).toBe("OPEN");
  });
});

describe("explainResolution", () => {
  it("marks a review task complete once the response has been applied", () => {
    const f = facts();
    f.responses = [{ ...f.responses[0]!, reviewStatus: "APPLIED" }];
    expect(explainResolution("REVIEW:respB", f)).toMatchObject({ outcome: "COMPLETED" });
  });

  it("marks a follow-up superseded when a specific follow-up request replaces it", () => {
    const f = facts();
    f.requests.push({ id: "r11", reference: "REQ-11", category: "INFORMATION", status: "DRAFT", recipientName: "Bank C", subjectEntityIds: ["C"], items: [], followUpAt: null, parentRequestId: "r5" });
    expect(explainResolution("FOLLOWUP:r5", f)).toMatchObject({ outcome: "SUPERSEDED" });
    expect(explainResolution("FOLLOWUP:r5", f).reason).toContain("REQ-11");
  });

  it("marks a hold recommendation complete when the bank confirms the hold", () => {
    expect(explainResolution("HOLD:A", facts())).toMatchObject({ outcome: "COMPLETED" });
  });
});

describe("missing balance information", () => {
  it("is not raised once the bank has answered the balance question", () => {
    const f = facts();
    f.responses = [];
    f.requests = f.requests.map((r) =>
      r.id === "r4"
        ? { ...r, status: "COMPLETE_RESPONSE", items: [{ itemType: "STATEMENT", status: "RECEIVED" }, { itemType: "BALANCE_CONFIRMATION", status: "RECEIVED" }] }
        : r.id === "r3"
          ? { ...r, status: "COMPLETE_RESPONSE", items: [{ itemType: "HOLD_CONFIRMATION", status: "RECEIVED" }] }
          : r,
    );
    expect(byKey(deriveRecommendations(f)).has("BALANCE:B")).toBe(false);
  });
});

describe("numbers the complaint says the caller used", () => {
  const withPhone = (caseRole: string | null): RecoFacts => {
    const f = facts();
    return { ...f, entities: [...f.entities, { id: "callerPh", kind: "PHONE", label: "+91-XXXXXX4512", value: "+91-XXXXXX4512", attributes: {}, caseRole }] };
  };

  it("proposes a UNICROSS request for the CDR and CAF of the caller's number", () => {
    const rec = byKey(deriveRecommendations(withPhone("Contact used by the caller / alleged fraudster"))).get("SUBSCRIBER:callerPh");
    expect(rec).toMatchObject({ ruleId: "IDENTITY_CALLER_NUMBER", objective: "IDENTITY", requestCategory: "INFORMATION", subjectEntityIds: ["callerPh"] });
    expect(rec?.title).toMatch(/CDR/);
    expect(rec?.scope).toMatch(/Call detail records \(CDR\).*Customer Acquisition Form \(CAF\)/);
    expect(rec?.recipientHint).toMatch(/UNICROSS/);
  });

  it("proposes nothing for a number whose role the records do not state", () => {
    expect(byKey(deriveRecommendations(withPhone(null))).has("SUBSCRIBER:callerPh")).toBe(false);
  });
});

/** FIR 412/2026 after the holds on B and C and Bank A's statement: two victims' money mixed in Account A. */
function mixedFunds(): RecoFacts {
  return {
    now: d("2026-11-09T05:00:00Z"),
    entities: [
      { id: "v1", kind: "PERSON", label: "Victim 1", value: "Victim 1", attributes: {}, caseRole: null },
      { id: "v2", kind: "PERSON", label: "Victim 2", value: "Victim 2", attributes: {}, caseRole: null },
      acct("V1", "Victim 1 account", "Bank V"),
      acct("V2", "Victim 2 account", "Bank V"),
      acct("A", "Account A", "Bank A"),
      acct("B", "Account B", "Bank B"),
      acct("C", "Account C", "Bank C"),
      { id: "cash", kind: "CASH", label: "Cash, ATM Kukatpally", value: "cash", attributes: {}, caseRole: null },
    ],
    victimAccountIds: ["V1", "V2"],
    claims: [
      { id: "c1", victimEntityId: "v1", lossMinor: L(60000) },
      { id: "c2", victimEntityId: "v2", lossMinor: L(40000) },
    ],
    allocationDecisions: [],
    transactions: [
      { id: "t1", fromEntityId: "V1", toEntityId: "A", amountMinor: L(60000), layer: 1, kind: "VICTIM_PAYMENT", occurredAt: d("2026-11-02T05:12:00Z"), reference: "630100000214" },
      { id: "t2", fromEntityId: "V2", toEntityId: "A", amountMinor: L(40000), layer: 1, kind: "VICTIM_PAYMENT", occurredAt: d("2026-11-03T03:45:00Z"), reference: "6301000?08?7" },
      { id: "t3", fromEntityId: "A", toEntityId: "B", amountMinor: L(70000), layer: 2, kind: "ONWARD_TRANSFER", occurredAt: d("2026-11-03T19:01:00Z"), reference: "BA2026110400318" },
      { id: "t4", fromEntityId: "A", toEntityId: "C", amountMinor: L(30000), layer: 2, kind: "ONWARD_TRANSFER", occurredAt: d("2026-11-03T19:03:00Z"), reference: "BA2026110400322" },
      { id: "t5", fromEntityId: "B", toEntityId: "cash", amountMinor: L(20000), layer: 3, kind: "CASH_WITHDRAWAL", occurredAt: d("2026-11-05T15:44:00Z"), reference: null },
    ],
    holds: [
      { id: "hA", accountEntityId: "A", status: "CONFIRMED_HELD", confirmedMinor: 0n },
      { id: "hB", accountEntityId: "B", status: "CONFIRMED_HELD", confirmedMinor: L(50000) },
      { id: "hC", accountEntityId: "C", status: "CONFIRMED_HELD", confirmedMinor: L(30000) },
    ],
    allocations: [],
    refunds: [],
    requests: [
      { id: "r5", reference: "REQ-5", category: "HOLD", status: "COMPLETE_RESPONSE", recipientName: "Bank B", subjectEntityIds: ["B"], items: [{ itemType: "HOLD_CONFIRMATION", status: "RECEIVED" }], followUpAt: null, parentRequestId: null },
      { id: "r7", reference: "REQ-7", category: "INFORMATION", status: "AWAITING_APPROVAL", recipientName: "Bank B", subjectEntityIds: ["B"], items: [{ itemType: "STATEMENT", status: "PENDING" }, { itemType: "ATM_DETAILS", status: "PENDING" }], followUpAt: null, parentRequestId: null },
    ],
    responses: [],
    relationships: [],
    locations: [
      { id: "atm1", entityId: "B", observationType: "ATM_WITHDRAWAL", limitations: "ATM site only: a historical sighting, not a current location. ATM ID not given, so footage cannot be requested yet.", locationText: "ATM, Kukatpally", eventAt: d("2026-11-05T15:44:00Z") },
    ],
    sources: [],
  };
}

describe("deciding whose money is held when victims' payments were mixed", () => {
  it("asks the officer to record a basis for splitting the held money between the victims", () => {
    const rec = byKey(deriveRecommendations(mixedFunds())).get("ALLOC:basis");
    expect(rec).toMatchObject({ ruleId: "FUNDS_ALLOCATION_BASIS", kind: "DECISION", objective: "FINANCIAL", requestCategory: null, status: "OPEN", priority: "HIGH" });
    expect(rec?.title).toBe("Decide how the ₹80,000 is split between the two victims");
    expect(rec?.relevance).toMatch(/Both victims paid into Account A/);
  });

  it("counts only money a bank confirms is held: a hold on an empty account adds nothing", () => {
    const f = mixedFunds();
    f.holds = f.holds.filter((h) => h.id !== "hC");
    expect(byKey(deriveRecommendations(f)).get("ALLOC:basis")?.title).toBe("Decide how the ₹50,000 is split between the two victims");
  });

  it("is not needed once a basis is recorded, or when there is only one victim", () => {
    const decided = mixedFunds();
    decided.allocationDecisions = [{ method: "PROPORTIONAL", decidedAt: d("2026-11-09T06:00:00Z") }];
    expect(byKey(deriveRecommendations(decided)).has("ALLOC:basis")).toBe(false);
    expect(explainResolution("ALLOC:basis", decided)).toMatchObject({ outcome: "COMPLETED" });

    const single = mixedFunds();
    single.claims = single.claims!.slice(0, 1);
    expect(byKey(deriveRecommendations(single)).has("ALLOC:basis")).toBe(false);
  });
});

describe("CCTV footage of a cash withdrawal", () => {
  it("proposes getting the footage, blocked until the ATM ID is known, and names the request that will give it", () => {
    const rec = byKey(deriveRecommendations(mixedFunds())).get("CCTV:atm1");
    expect(rec).toMatchObject({ ruleId: "EVIDENCE_ATM_CCTV", objective: "IDENTITY", status: "BLOCKED", requestCategory: null });
    expect(rec?.title).toBe("Get the ATM CCTV footage from 05 Nov, Kukatpally");
    expect(rec?.prerequisites[0]).toMatchObject({ label: "Cash withdrawal recorded", met: true });
    expect(rec?.prerequisites[1]).toMatchObject({ label: "ATM ID known", met: false, dependsOn: "INFO:B" });
  });

  it("becomes ready once the ATM ID is on record", () => {
    const f = mixedFunds();
    f.locations = [{ ...f.locations[0]!, limitations: "ATM site only: a historical sighting, not a current location.", atmId: "TSKUK0193" }];
    const rec = byKey(deriveRecommendations(f)).get("CCTV:atm1");
    expect(rec?.status).toBe("OPEN");
    expect(rec?.prerequisites[0]).toMatchObject({ met: true });
  });
});

describe("an account whose money is fully held and has not moved", () => {
  it("asks only for the holder's KYC, at low priority, instead of a statement to trace onward money", () => {
    const rec = byKey(deriveRecommendations(mixedFunds())).get("INFO:C");
    expect(rec).toMatchObject({ ruleId: "FUNDS_TRACE", priority: "LOW", title: "Request KYC from Bank C for Account C" });
    expect(rec?.scope).toMatch(/^KYC only/);
    expect(byKey(deriveRecommendations(mixedFunds())).get("INFO:B")?.priority).not.toBe("LOW");
  });
});
