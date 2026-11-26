import { describe, expect, it } from "vitest";
import { buildWorld } from "../support/fixtures";
import { setEntityVerification, addRelationship, setLocationCorroboration } from "@/server/services/investigation";

async function world() {
  const w = await buildWorld();
  const person = await w.db.entity.create({ data: { caseId: w.kase.id, kind: "PERSON", label: "Holder on record", value: "Holder on record", normalizedValue: "person:h", discoveredAt: new Date() } });
  const loc = await w.db.locationObservation.create({ data: { caseId: w.kase.id, entityId: w.account.id, observationType: "KYC_ADDRESS", description: "KYC address", locationText: "Demo Nagar", precision: "As recorded", receivedAt: new Date(), dedupeKey: "loc-1" } });
  return { ...w, person, loc };
}

describe("investigation records", () => {
  it("records verification as an audited decision with a note", async () => {
    const w = await world();
    await expect(setEntityVerification(w.db, w.officer, w.account.id, { status: "CORROBORATED", note: "" })).rejects.toThrow(/note/i);
    await setEntityVerification(w.db, w.officer, w.account.id, { status: "CORROBORATED", note: "Matches the bank statement" });
    const e = await w.db.entity.findUniqueOrThrow({ where: { id: w.account.id } });
    expect(e).toMatchObject({ verificationStatus: "CORROBORATED", verificationNote: "Matches the bank statement" });
    expect(await w.db.auditEvent.count({ where: { caseId: w.kase.id, action: "entity.verification_changed" } })).toBe(1);
  });

  it("only allows precise relationship types and never relates a record to itself", async () => {
    const w = await world();
    await expect(addRelationship(w.db, w.officer, w.kase.id, { fromEntityId: w.account.id, toEntityId: w.person.id, type: "ACCOMPLICE_OF", statement: "x".repeat(20) })).rejects.toThrow(/type/i);
    await expect(addRelationship(w.db, w.officer, w.kase.id, { fromEntityId: w.person.id, toEntityId: w.person.id, type: "POTENTIALLY_ASSOCIATED_WITH", statement: "Same person twice" })).rejects.toThrow(/itself/i);
    const rel = await addRelationship(w.db, w.officer, w.kase.id, { fromEntityId: w.account.id, toEntityId: w.person.id, type: "USED_BY", statement: "Login records show the holder using the account on 3 Oct 2026" });
    expect(rel.status).toBe("ASSERTED");
  });

  it("records location corroboration changes and refuses unassigned officers", async () => {
    const w = await world();
    await setLocationCorroboration(w.db, w.officer, w.loc.id, { corroboration: "CONTRADICTED", note: "Field visit found no such address" });
    expect((await w.db.locationObservation.findUniqueOrThrow({ where: { id: w.loc.id } })).corroboration).toBe("CONTRADICTED");
    await expect(setLocationCorroboration(w.db, w.outsider, w.loc.id, { corroboration: "CORROBORATED", note: "x" })).rejects.toThrow(/do not have access/);
  });
});
