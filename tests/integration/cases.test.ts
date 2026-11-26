import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { createCase } from "@/server/services/cases";
import { AppError } from "@/server/errors";

const base = (w: Awaited<ReturnType<typeof buildWorld>>, over: Record<string, unknown> = {}) => ({
  referenceType: "FIR" as const,
  firNumber: "501",
  firYear: "2026",
  investigatingOfficerId: w.officer.id,
  title: "Investment fraud reported at intake",
  ...over,
});

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected the case to be refused");
}

describe("createCase", () => {
  it("refuses a second case with the same FIR number and names the existing one", async () => {
    const w = await buildWorld();
    await createCase(w.db, w.officer, base(w));
    const err = await rejection(createCase(w.db, w.officer, base(w, { title: "Another title for the same FIR" })));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("CONFLICT");
    expect(err.fieldErrors?.firNumber).toContain("FIR 501/2026");
  });

  it("refuses an FIR whose complaint reference is already recorded on another case, with a field message instead of a failure", async () => {
    const w = await buildWorld();
    await createCase(w.db, w.officer, base(w, { complaintRef: "DEMO-NCRP-2026-000999" }));
    const err = await rejection(createCase(w.db, w.officer, base(w, { firNumber: "502", complaintRef: "DEMO-NCRP-2026-000999" })));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("CONFLICT");
    expect(err.fieldErrors?.complaintRef).toContain("FIR 501/2026");
    expect(await w.db.case.count({ where: { stationId: w.kase.stationId, firNumber: 502 } })).toBe(0);
  });
});
