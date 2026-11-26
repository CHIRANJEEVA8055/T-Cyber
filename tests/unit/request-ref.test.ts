import { describe, expect, it } from "vitest";
import { caseRefKey, coreRef, fileSafeRef, formatRequestRef, letterFor, quotedRequestRefs, quotesRequest, refVariants, reminderRef, responseRef } from "@/domain/request-ref";

describe("request and reply references", () => {
  it("names the kind of request, the case and the request's place in it", () => {
    expect(caseRefKey({ firNumber: 412, firYear: 2026 })).toBe("412/2026");
    expect(caseRefKey({ firNumber: null, firYear: null, complaintRef: "31234567890123" })).toBe("31234567890123");
    expect(caseRefKey({ firNumber: null, firYear: null, complaintRef: "1234" })).toBeNull();
    expect(caseRefKey({ firNumber: null, firYear: null })).toBeNull();
    expect(formatRequestRef("REQ", "412/2026", 3, "PRESERVATION")).toBe("P.REQ-412/2026-003");
    expect(formatRequestRef("REQ", "412/2026", 2, "INFORMATION")).toBe("R.REQ-412/2026-002");
    expect(formatRequestRef("REQ", "412/2026", 5, "HOLD")).toBe("H.REQ-412/2026-005");
    expect(formatRequestRef("REQ", "412/2026", 9, "RESTORATION")).toBe("U.REQ-412/2026-009");
    expect(formatRequestRef("REQ", "412/2026", 1234, "INFORMATION")).toBe("R.REQ-412/2026-1234");
    expect(letterFor("SOMETHING_ELSE")).toBe("R");
    expect(() => formatRequestRef("REQ", "412/2026", 0, "HOLD")).toThrow();
  });

  it("gives reminders their request's reference and kind, and replies the RES form", () => {
    expect(reminderRef("R.REQ-412/2026-002", 1)).toBe("R.REQ-412/2026-002-R1");
    expect(reminderRef("R.REQ-412/2026-002-R1", 2)).toBe("R.REQ-412/2026-002-R2");
    expect(responseRef("P.REQ-412/2026-003")).toBe("P.RES-412/2026-003");
    expect(responseRef("R.REQ-412/2026-002", 2)).toBe("R.RES-412/2026-002-2");
    expect(responseRef("H.REQ-412/2026-001-R1")).toBe("H.RES-412/2026-001-R1");
    expect(responseRef("REQ-2026-0275")).toBe("RES-2026-0275");
  });

  it("reads a request's core, which names it with or without the letter", () => {
    expect(coreRef("R.REQ-412/2026-002")).toBe("REQ-412/2026-002");
    expect(coreRef("p.res-412/2026-003")).toBe("REQ-412/2026-003");
    expect(coreRef("REQ-2026-0275")).toBe("REQ-2026-0275");
    expect(refVariants("REQ-412/2026-002")).toEqual(["REQ-412/2026-002", "P.REQ-412/2026-002", "R.REQ-412/2026-002", "H.REQ-412/2026-002", "U.REQ-412/2026-002"]);
  });

  it("finds the requests a reply quotes, in every form, as their cores", () => {
    expect(quotedRequestRefs("RE: R.REQ-412/2026-002 statement and KYC", "REQ")).toEqual(["REQ-412/2026-002"]);
    expect(quotedRequestRefs("Your ref P.RES-412/2026-003 and r.req-412/2026-002-r1", "REQ")).toEqual(["REQ-412/2026-003", "REQ-412/2026-002-R1"]);
    expect(quotedRequestRefs("RE: REQ-412/2026-002 (the form without the letter)", "REQ")).toEqual(["REQ-412/2026-002"]);
    expect(quotedRequestRefs("Ref: REQ-2026-0275 (preservation)", "REQ")).toEqual(["REQ-2026-0275"]);
    expect(quotedRequestRefs("Ref H.REQ-412 2026-005", "REQ")).toEqual(["REQ-412/2026-005"]);
    expect(quotedRequestRefs("R.REQ-31234567890123-001", "REQ")).toEqual(["REQ-31234567890123-001"]);
    expect(quotedRequestRefs("no reference here, REQ-12, REQ-2026-12345678", "REQ")).toEqual([]);
    expect(quotedRequestRefs("R.REQ-412/2026-002 REQ-412/2026-002 R.RES-412/2026-002", "REQ")).toEqual(["REQ-412/2026-002"]);
  });

  it("tells whether a text quotes a given request, whole references only", () => {
    expect(quotesRequest("RE: R.REQ-412/2026-002-R1", ["R.REQ-412/2026-002"])).toBe(false);
    expect(quotesRequest("RE: R.REQ-412/2026-002-R1", ["R.REQ-412/2026-002-R1"])).toBe(true);
    expect(quotesRequest("Our ref P.RES-412/2026-003", ["P.REQ-412/2026-003"])).toBe(true);
    expect(quotesRequest("Re: REQ-412/2026-003", ["P.REQ-412/2026-003"])).toBe(true);
    expect(quotesRequest("Re: REQ-2026-0275 preservation", ["R.REQ-1439/2026-001", "REQ-2026-0275"])).toBe(true);
    expect(quotesRequest("R.REQ-412/2026-002-PSMDP", ["R.REQ-412/2026-002-PSMDP"])).toBe(true);
    expect(quotesRequest("R.REQ-412/2026-002", ["R.REQ-412/2026-002-PSMDP"])).toBe(false);
    expect(quotesRequest("anything", [null, undefined])).toBe(false);
  });

  it("makes a reference safe for a file name", () => {
    expect(fileSafeRef("R.REQ-412/2026-002")).toBe("R.REQ-412-2026-002");
    expect(fileSafeRef("R.RES-412/2026-002-2")).toBe("R.RES-412-2026-002-2");
  });
});
