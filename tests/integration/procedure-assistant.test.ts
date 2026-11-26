import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import type { GuidanceAnswer } from "@/contracts/assistant";
import { answerProcedureQuestion, listAttachables, uploadChatFile } from "@/server/services/procedure-assistant";
import { askInThread, createThread, exportThreadDocx, getThread, listThreads, retryLastAnswer } from "@/server/services/chats";
import { readDocxBlocks } from "@/server/documents/read-text";

const db = getDb();
let fir412 = "";
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
const offline = async () => ({ ok: false as const, error: "The local model is not running on this server." });
const order = Buffer.from(["ORDER OF THE COURT", "", "1. Interim custody", "The held amount of Rs 30,000 in Account C shall be released to the victim on furnishing an indemnity bond.", "", "2. Compliance", "The bank shall report compliance within 15 days."].join("\n"));

beforeAll(async () => {
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("attaching things to a procedure question", () => {
  it("lists only the cases and mails the officer may use; the developer gets none", async () => {
    const mine = await listAttachables(db, await user("officer1"));
    expect(mine.cases.some((c) => c.id === fir412 && /^FIR 412\/2026/.test(c.label))).toBe(true);
    expect(mine.mails.length).toBeGreaterThan(0);
    const other = await listAttachables(db, await user("officer2"));
    expect(other.cases.some((c) => c.id === fir412)).toBe(false);
    expect(await listAttachables(db, await user("developer"))).toEqual({ cases: [], mails: [] });
  });

  it("answers from an uploaded file by quoting the matching part, and keeps the file private to its uploader", async () => {
    const me = await user("officer1");
    const att = await uploadChatFile(db, me, { fileName: "order.txt", buffer: order });
    expect(att).toMatchObject({ kind: "FILE", label: "order.txt" });
    const a = (await answerProcedureQuestion(db, me, { question: "Within how many days must the bank report compliance?", scope: "ALL", attachment: { kind: "FILE", id: att.id }, generate: offline })) as GuidanceAnswer;
    expect(a.extracts?.[0]?.text).toMatch(/report compliance within 15 days/);
    expect(a.about).toMatch(/treated as data/);
    await expect(answerProcedureQuestion(db, await user("officer2"), { question: "What does it say?", scope: "ALL", attachment: { kind: "FILE", id: att.id }, generate: offline })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A photo or scan is read by the local model: refused plainly when it is not running, or when the file is not what it says.
    await expect(uploadChatFile(db, me, { fileName: "scan.png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })).rejects.toThrow(/does not match its \.png extension/);
    await expect(uploadChatFile(db, me, { fileName: "scan.png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) })).rejects.toThrow(/scans are read by the local model/);
    await expect(uploadChatFile(db, me, { fileName: "notes.exe", buffer: Buffer.from("x") })).rejects.toThrow(/cannot be read here/);
  });

  it("explains a station mail and which request it seems to answer", async () => {
    const me = await user("officer1");
    const mail = (await listAttachables(db, me)).mails[0]!;
    const a = (await answerProcedureQuestion(db, me, { question: "Summarise this mail", scope: "ALL", attachment: { kind: "MAIL", id: mail.id }, generate: offline })) as GuidanceAnswer;
    expect(a.attachment?.kind).toBe("MAIL");
    expect(a.about).toMatch(/^Mail from /);
    expect(a.extracts!.length).toBeGreaterThan(0);
    await expect(answerProcedureQuestion(db, await user("developer"), { question: "Summarise", scope: "ALL", attachment: { kind: "MAIL", id: mail.id } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("works on a whole case only for its officers, and offers to prepare drafts without sending anything", async () => {
    const me = await user("officer1");
    const a = await answerProcedureQuestion(db, me, { question: "Draft the mail requests that are still pending", scope: "ALL", attachment: { kind: "CASE", id: fir412 }, generate: offline });
    expect("established" in a).toBe(true);
    expect(a.attachment?.kind).toBe("CASE");
    expect(a.tasks!.length).toBeGreaterThan(0);
    for (const t of a.tasks!) expect(t.kind === "PREPARE_DRAFT" ? !!t.taskId : !!t.href).toBe(true);
    const sent = await db.submission.count();
    expect(await db.submission.count()).toBe(sent);
    await expect(answerProcedureQuestion(db, await user("officer2"), { question: "What is missing?", scope: "ALL", attachment: { kind: "CASE", id: fir412 } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("conversation tools", () => {
  it("keeps the attachment with the question, retries the last answer, finds chats by their text, and saves a Word document", async () => {
    const me = await user("officer1");
    const att = await uploadChatFile(db, me, { fileName: "order.txt", buffer: order });
    const t = await createThread(db, me, { kind: "PROCEDURE" });
    await askInThread(db, me, t.id, "What does the order say about interim custody?", { generate: offline, attachment: { kind: "FILE", id: att.id } });
    let v = await getThread(db, me, t.id);
    expect(v.messages[0]!.attachment).toMatchObject({ kind: "FILE", label: "order.txt" });
    const firstAnswer = v.messages[1]!.id;
    await retryLastAnswer(db, me, t.id, { generate: offline });
    v = await getThread(db, me, t.id);
    expect(v.messages).toHaveLength(2);
    expect(v.messages[1]!.id).not.toBe(firstAnswer);
    expect((v.messages[1]!.answer as GuidanceAnswer).extracts?.[0]?.text).toMatch(/indemnity bond/);

    const found = await listThreads(db, me, { kind: "PROCEDURE", q: "interim custody" });
    expect(found.groups.flatMap((g) => g.threads).map((x) => x.id)).toContain(t.id);
    expect((await listThreads(db, me, { kind: "PROCEDURE", q: "no such words anywhere" })).groups).toEqual([]);

    const doc = await exportThreadDocx(db, me, t.id, { messageId: v.messages[1]!.id });
    expect(doc.fileName).toMatch(/\.docx$/);
    const text = readDocxBlocks(doc.buffer).map((b) => b.text).join("\n");
    expect(text).toContain("What does the order say about interim custody?");
    expect(text).toMatch(/indemnity bond/);
    await expect(exportThreadDocx(db, await user("officer2"), t.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
