import { describe, expect, it } from "vitest";
import { answerFromLibrary, expandQuestion, rankForAnswer, type LibraryDocument } from "@/domain/guidance";

const meta = { issuingBody: "Demo Cyber Crime Wing (synthetic)", jurisdiction: "Demo State (synthetic)" };
const library: LibraryDocument[] = [
  {
    ...meta,
    id: "sop2",
    title: "Station procedure: online financial fraud complaints",
    docNumber: "DEMO-SOP-FF",
    version: "2.0",
    effectiveFrom: "2026-03-31T18:30:00.000Z",
    status: "CURRENT",
    supersededById: null,
    sections: [
      { id: "sop2-2", sectionRef: "§2", heading: "First actions", text: "Send a debit freeze request for each beneficiary account through the bank's nodal channel as early as possible. Record a bank's acknowledgement separately from its confirmation; an acknowledgement does not confirm that funds are held.", topics: ["first-actions", "hold", "acknowledgement"] },
      { id: "sop2-3", sectionRef: "§3", heading: "Recording holds and amounts", text: "A request to hold funds is not a confirmation. Record an amount as held only when the bank confirms it, together with the time at which the balance was taken.", topics: ["hold", "amounts", "unknown"] },
      { id: "sop2-4", sectionRef: "§4", heading: "Follow-up interval", text: "Follow up on bank requests that have not been answered after 5 working days, quoting the original request reference.", topics: ["follow-up-interval", "follow-up"] },
    ],
  },
  {
    ...meta,
    id: "sop1",
    title: "Station procedure: online financial fraud complaints",
    docNumber: "DEMO-SOP-FF",
    version: "1.0",
    effectiveFrom: "2024-12-31T18:30:00.000Z",
    status: "SUPERSEDED",
    supersededById: "sop2",
    sections: [{ id: "sop1-4", sectionRef: "§4", heading: "Follow-up interval", text: "Follow up on unanswered bank requests after 10 working days.", topics: ["follow-up-interval", "follow-up"] }],
  },
  {
    ...meta,
    id: "zc",
    issuingBody: "Demo Zonal Office (synthetic)",
    title: "Zonal circular: follow-up of bank correspondence",
    docNumber: "DEMO-ZC-2026-04",
    version: "1.0",
    effectiveFrom: "2026-05-31T18:30:00.000Z",
    status: "CURRENT",
    supersededById: null,
    sections: [{ id: "zc-2", sectionRef: "Para 2", heading: "Follow-up timing", text: "Where a bank has not acknowledged a request, follow up after 3 working days.", topics: ["follow-up-interval", "follow-up", "acknowledgement"] }],
  },
  {
    ...meta,
    id: "uni",
    title: "Zonal circular: telecom subscriber requests through UNICROSS",
    docNumber: "DEMO-ZC-2026-02",
    version: "1.1",
    effectiveFrom: "2026-02-14T18:30:00.000Z",
    status: "CURRENT",
    supersededById: null,
    sections: [
      { id: "uni-1", sectionRef: "Para 1", heading: "Route", text: "Requests for subscriber details and the Customer Acquisition Form (CAF) are sent through the UNICROSS desk at the zonal ACP office.", topics: ["subscriber", "caf", "unicross", "telecom"] },
      { id: "uni-3", sectionRef: "Para 3", heading: "Registration is not use", text: "Subscriber details show who registered a number. They do not by themselves show who used or controlled it. Record them as registration only.", topics: ["subscriber", "attribution", "identity"] },
    ],
  },
];
const cite = (p: { documentId: string; sectionRef: string }) => `${p.documentId} ${p.sectionRef}`;

describe("guidance from the approved library", () => {
  it("quotes the section that answers the question, with its document and version", () => {
    const a = answerFromLibrary("Does subscriber registration show who used the number?", library);
    expect(a.kind).toBe("ANSWER");
    expect(a.passages.map(cite)[0]).toBe("uni Para 3");
    expect(a.passages[0]).toMatchObject({ version: "1.1", status: "CURRENT", documentTitle: "Zonal circular: telecom subscriber requests through UNICROSS" });
  });

  it("finds the rule on recording held amounts", () => {
    const a = answerFromLibrary("Can I record a hold amount before the bank confirms it?", library);
    expect(a.kind).toBe("ANSWER");
    expect(a.passages.map(cite)[0]).toBe("sop2 §3");
  });

  it("shows both current sources when they differ, and does not pick one", () => {
    const a = answerFromLibrary("When should I follow up with a bank that has not replied?", library);
    expect(a.kind).toBe("CONFLICT");
    expect(a.passages.map(cite).sort()).toEqual(["sop2 §4", "zc Para 2"]);
    expect(a.summary).toMatch(/differ/);
    expect(a.summary).toMatch(/does not decide/);
  });

  it("does not report a conflict when two passages only touch the same subject in passing", () => {
    const a = answerFromLibrary("Does an acknowledgement from the bank mean the money is held?", library);
    expect(a.kind).toBe("ANSWER");
    expect(a.passages.map(cite)[0]).toBe("sop2 §2");
  });

  it("never presents a superseded version as current, but shows it for history", () => {
    const a = answerFromLibrary("When should I follow up with a bank that has not replied?", library);
    expect(a.passages.some((p) => p.documentId === "sop1")).toBe(false);
    expect(a.superseded.map(cite)).toEqual(["sop1 §4"]);
    expect(a.superseded[0]).toMatchObject({ status: "SUPERSEDED", supersededBy: { documentId: "sop2", version: "2.0" } });
  });

  it("says the library does not cover a question instead of answering from general knowledge", () => {
    const a = answerFromLibrary("What is the procedure for extradition?", library);
    expect(a.kind).toBe("INSUFFICIENT");
    expect(a.passages).toEqual([]);
    expect(a.summary).toMatch(/does not cover/);
  });

  it("does not answer from a passage that matches only a small part of the question", () => {
    // "subscriber" is the UNICROSS circular's subject; "cricket", "weather" and "forecast" are nowhere in the library.
    expect(answerFromLibrary("What is the cricket weather forecast for subscriber?", library).kind).toBe("INSUFFICIENT");
    // Most of the question is covered: still answered.
    expect(answerFromLibrary("Where do subscriber requests go, UNICROSS?", library).kind).toBe("ANSWER");
  });

  it("matches freeze, freezing, frozen and unfrozen as one word", () => {
    // Four words of evidence only when "frozen" meets "freeze".
    const a = answerFromLibrary("Was the beneficiary account frozen at the bank?", library);
    expect(a.kind).toBe("ANSWER");
    expect(a.passages.map(cite)[0]).toBe("sop2 §2");
  });
});

describe("choosing passages for a written answer", () => {
  it("writes out police shorthand: MO, and IPS meaning the IPC beside BNS", () => {
    expect(expandQuestion("types of cyber crimes and their mo wise ips/bns classifications")).toMatch(/modus operandi/);
    expect(expandQuestion("types of cyber crimes and their mo wise ips/bns classifications")).toMatch(/\bipc\b/);
    expect(expandQuestion("which IPs logged in?")).toBe("which IPs logged in?");
  });
  it("takes passages from several documents and holds software how-tos back", () => {
    const software: LibraryDocument = { ...library[0]!, id: "crimeos", title: "How can I create a new case in CrimeOS?", sections: [{ id: "c1", sectionRef: "§3", heading: "Step-by-step procedure", text: "Step by step: open the case, add the FIR and the handles.", topics: [] }] };
    const lib = [...library, software];
    const top = rankForAnswer("step by step: what to do first on a new FIR for a held amount", lib, { limit: 4, perDoc: 1 });
    expect(new Set(top.map((p) => p.documentId)).size).toBe(top.length);
    expect(top[0]!.documentId).not.toBe("crimeos");
    expect(rankForAnswer("how do I add the FIR in CrimeOS, step by step?", lib, { limit: 4, perDoc: 1 })[0]!.documentId).toBe("crimeos");
  });
});
