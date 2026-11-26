import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { downloadLetter, requestLetter } from "@/server/services/letters";
import { parseDocument } from "@/server/documents/parse";
import { readDocxBlocks } from "@/server/documents/docx-read";

const db = getDb();
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
let fir412 = "";
beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("a request as a printed letter", () => {
  it("is laid out like the station's notices, with the request's own wording", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, category: "INFORMATION", status: { in: ["SUBMITTED", "ACKNOWLEDGED", "PARTIAL_RESPONSE", "COMPLETE_RESPONSE"] } } });
    const v = await db.requestVersion.findFirstOrThrow({ where: { requestId: req.id, versionNo: req.currentVersionNo } });
    const l = await requestLetter(db, await user("officer1"), req.id);
    expect(l.approved).toBe(true);
    expect(l.office[0]).toBe("Office of the");
    expect(l.date).toMatch(/^Dated: \d{2}-\d{2}-\d{4}$/);
    expect(l.sub).toMatch(/ – Reg\.$/);
    expect(l.ref).toMatch(/^Crime No\. 412\/2026/);
    expect(l.ref).toContain(req.reference);
    // The draft's own sentences are kept; its opening "To … Sir/Madam," is printed once, by the letter.
    const firstSentence = v.body.split(/\n{2,}/).find((p) => p.length > 40 && !/^To /.test(p))!;
    expect(l.body.join("\n\n")).toContain(firstSentence.trim());

    const pdf = await downloadLetter(db, await user("officer1"), req.id, "pdf");
    const text = (await parseDocument(pdf.buffer, "application/pdf")).segments.map((s) => s.text).join("\n");
    expect(text).toContain("Office of the");
    expect(text).toContain(`Sub: ${l.sub.replace("–", "-").slice(0, 30)}`);
    expect(text).not.toContain("DRAFT");
    const docx = readDocxBlocks((await downloadLetter(db, await user("officer1"), req.id, "docx")).buffer).map((b) => b.text).join("\n");
    expect(docx).toContain("Sir/Madam,");
    expect(docx).not.toContain("DRAFT");
    expect(await db.auditEvent.count({ where: { objectId: req.id, action: "request.letter_downloaded" } })).toBe(2);
  });

  it("prints without the DRAFT mark as soon as the address is verified, before approval", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, status: { in: ["DRAFT", "AWAITING_APPROVAL"] } }, include: { recipient: true } });
    await db.recipient.update({ where: { id: req.recipientId }, data: { verificationStatus: "VERIFIED", verifiedAt: new Date("2026-11-08T05:30:00Z") } });
    await db.request.update({ where: { id: req.id }, data: { needsReview: false, needsReviewReason: null } });
    const l = await requestLetter(db, await user("officer1"), req.id);
    expect(l).toMatchObject({ approved: false, final: true });
    expect(l.footer).toMatch(/address verified 08-11-2026$/);
    const pdf = await downloadLetter(db, await user("officer1"), req.id, "pdf");
    expect(pdf.buffer.toString("latin1")).not.toContain("(DRAFT) Tj");
    const docx = readDocxBlocks((await downloadLetter(db, await user("officer1"), req.id, "docx")).buffer).map((b) => b.text).join("\n");
    expect(docx).not.toContain("DRAFT");
  });

  it("keeps the DRAFT mark on every page while the address is not verified or the draft is to be checked", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, status: { in: ["DRAFT", "AWAITING_APPROVAL"] } } });
    await db.recipient.update({ where: { id: req.recipientId }, data: { verificationStatus: "UNVERIFIED" } });
    let pdf = await downloadLetter(db, await user("officer1"), req.id, "pdf");
    expect(pdf.buffer.toString("latin1")).toContain("(DRAFT) Tj");
    expect((await requestLetter(db, await user("officer1"), req.id)).footer).toMatch(/DRAFT, address not verified$/);
    const docx = readDocxBlocks((await downloadLetter(db, await user("officer1"), req.id, "docx")).buffer).map((b) => b.text).join("\n");
    expect(docx).toMatch(/^DRAFT – address not verified/);
    // Verified, but flagged because the facts changed after it was written: still marked until it is checked.
    await db.recipient.update({ where: { id: req.recipientId }, data: { verificationStatus: "VERIFIED" } });
    await db.request.update({ where: { id: req.id }, data: { needsReview: true, needsReviewReason: "A reply changed the facts." } });
    pdf = await downloadLetter(db, await user("officer1"), req.id, "pdf");
    expect(pdf.buffer.toString("latin1")).toContain("(DRAFT) Tj");
    expect((await requestLetter(db, await user("officer1"), req.id)).footer).toMatch(/DRAFT, to be checked before sending$/);
  });

  it("is refused to an officer who cannot open the case", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412 } });
    await expect(downloadLetter(db, await user("officer2"), req.id, "pdf")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
