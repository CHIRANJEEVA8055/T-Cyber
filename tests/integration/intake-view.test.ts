import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { sampleFirPdf } from "@/server/seed/documents";
import { makeTimeline } from "@/server/seed/timeline";
import { openCaseFromFir } from "@/server/services/fir-open";
import { getIntakeView } from "@/server/services/intake-view";
import { reviewCandidate } from "@/server/services/extraction";

const T = makeTimeline("2026-11-09");

describe("intake: checking what was read from the FIR", () => {
  it("shows the FIR with each detail marked where it was read, and lists them to check", async () => {
    const w = await buildWorld();
    const f = sampleFirPdf(T);
    const { caseId } = await openCaseFromFir(w.db, w.officer, { name: f.fileName, buffer: f.buffer });
    const v = await getIntakeView(w.db, w.officer, caseId);
    expect(v).toMatchObject({ hasFir: true, canWrite: true });
    expect(v.documents[0]!.tab).toBe("FIR");
    const marked = v.documents[0]!.lines.flatMap((l) => l.marks.map((m) => [l.text.slice(m.start, m.end), m.kind]));
    expect(marked).toEqual(expect.arrayContaining([["T. Ramesh", "phone"], ["XXXXXXXXXXXX8810", "acct"], ["Rs. 65,000", "amt"]]));
    expect(v.pending).toBeGreaterThan(5);
    expect(v.summary).toMatch(/^\d+ details · 0 confirmed · \d+ to check$/);
    const name = v.groups.find((g) => g.key === "people")!.items[0]!;
    expect(name.status).toEqual({ text: "Check role", tone: "wait" });
    expect(v.notInFir).toEqual([{ title: "IP addresses and devices", sub: "Expected from the platform later, not from the complainant." }]);

    await reviewCandidate(w.db, w.officer, name.id, { action: "ACCEPT" });
    const after = await getIntakeView(w.db, w.officer, caseId);
    expect(after.groups.find((g) => g.key === "people")!.items[0]!.status).toEqual({ text: "Confirmed", tone: "ok" });
    expect(after.pending).toBe(v.pending - 1);
  });

  it("is closed to an officer not on the case", async () => {
    const w = await buildWorld();
    const f = sampleFirPdf(T);
    const { caseId } = await openCaseFromFir(w.db, w.officer, { name: f.fileName, buffer: f.buffer });
    await expect(getIntakeView(w.db, w.outsider, caseId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
