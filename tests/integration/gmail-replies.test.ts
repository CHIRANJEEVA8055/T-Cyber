import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import { readGmailReplies } from "@/server/gmail/replies";
import type { GmailApi, MessageFull } from "@/server/gmail/api";
import type { Generate } from "@/server/ai/grounded";
import { useGmail } from "../support/delivery-config";

/**
 * Replies read from the linked Gmail account's inbox and linked to the request they answer. An in-memory inbox
 * stands in for Google, and a stand-in for the local model answers the one question it is asked. Synthetic only.
 */
const db = getDb();
const READ = "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly";

function inbox(messages: MessageFull[], files: Record<string, Buffer> = {}) {
  const fetched: string[] = [];
  const api: GmailApi = {
    createDraft: async () => ({ draftId: "d", messageId: "m" }),
    updateDraft: async () => ({ draftId: "d", messageId: "m" }),
    getDraft: async () => null,
    sendDraft: async () => ({ messageId: "s", threadId: "t" }),
    profile: async () => ({ emailAddress: "station.test@example.invalid" }),
    listMessages: async () => messages.map((m) => ({ id: m.id, threadId: m.threadId })).reverse(),
    getMessageMeta: async (id) => {
      const m = messages.find((x) => x.id === id);
      if (!m) return null;
      const { text: _t, attachments: _a, ...meta } = m;
      return meta;
    },
    getMessage: async (id) => {
      fetched.push(id);
      return messages.find((x) => x.id === id) ?? null;
    },
    getAttachment: async (_m, attachmentId) => files[attachmentId] ?? Buffer.from(""),
  };
  return { api, fetched };
}
const msg = (id: string, threadId: string, from: string, subject: string, text: string, attachments: MessageFull["attachments"] = []): MessageFull => ({ id, threadId, from, to: "station.test@example.invalid", subject, date: Date.parse("2026-11-10T09:00:00Z"), inReplyTo: "", references: "", labels: ["INBOX"], text, attachments });

let fir412 = "";
const req = (key: string) => db.request.findFirstOrThrow({ where: { caseId: fir412, recipient: { configKey: key }, parentRequestId: null }, orderBy: { caseSeq: "asc" } });

beforeAll(async () => {
  useGmail("station.test@example.invalid", { scope: READ });
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("replies in the Gmail inbox", () => {
  it("links each reply to its request, and keeps nothing of mail that is not about a case", async () => {
    const a = await req("bank-a");
    const b = await req("bank-b");
    const c = await req("bank-c");
    await db.request.update({ where: { id: a.id }, data: { gmailThreadId: "T-A", gmailTo: "nodal.officer@bank-a.example.invalid" } });
    await db.request.update({ where: { id: c.id }, data: { gmailTo: "nodal.officer@bank-c.example.invalid" } });
    const csv = Buffer.from("Date,Narration,Debit,Credit,Balance\n01-11-2026,UPI-TEST,100.00,,900.00\n");
    const messages = [
      msg("m1", "T-A", "Nodal Officer <nodal.officer@bank-a.example.invalid>", "Re: statement", "Please find the statement attached.", [{ attachmentId: "f1", fileName: "statement.csv", mimeType: "text/csv", size: csv.length }]),
      msg("m2", "T-X", "offers@shop.example.invalid", "Big sale this week", "Fifty percent off everything."),
      msg("m3", "T-B", "desk@bank-b.example.invalid", `Reply to ${b.reference}`, "The details asked for are below."),
      msg("m4", "T-C", "help@bank-c.example.invalid", "Regarding your mail", "We confirm the debit freeze on the account ending 7715 as asked in your letter."),
      msg("m5", "T-D", "nodal.officer@bank-c.example.invalid", "A question", "Please call our office about your letter."),
      // From the organisation's domain, about the account holder's own banking: nothing names the case.
      msg("m6", "T-E", "alerts@bank-c.example.invalid", "Your statement for October is ready", "Dear customer, your e-statement is attached."),
      // A shared domain: the request went to someone at gmail.com, this is someone else there.
      msg("m7", "T-F", "a.friend@gmail.com", "Re: your request", "See you on Sunday."),
    ];
    await db.request.update({ where: { id: b.id }, data: { gmailTo: "someone.else@gmail.com" } });
    const box = inbox(messages, { f1: csv });
    const model: Generate = async (o) => {
      if (o.prompt.includes("debit freeze")) {
        const n = /R(\d+): [^\n]*nodal\.officer@bank-c/.exec(o.prompt)?.[1];
        return { ok: true, text: JSON.stringify({ request: `R${n}`, quote: "We confirm the debit freeze on the account ending 7715", why: "It confirms the freeze asked for." }), model: "stub", ms: 1 };
      }
      // A quote that is not in the message: the answer is not used.
      return { ok: true, text: JSON.stringify({ request: "R1", quote: "we have sent everything you asked for", why: "" }), model: "stub", ms: 1 };
    };
    const pass = await readGmailReplies(db, box.api, { generate: model });
    expect(pass).toMatchObject({ looked: 7, linked: 3, queued: 1, skipped: 3, failed: 0, note: null });

    // The reply in the request's own conversation, with its file read in.
    const r1 = await db.response.findFirstOrThrow({ where: { requestId: a.id, subject: "Re: statement" }, include: { attachments: true } });
    expect(r1.attachments.map((x) => x.fileName)).toContain("statement.csv");
    const seen1 = await db.gmailSeen.findUniqueOrThrow({ where: { messageId: "m1" } });
    expect(seen1.outcome).toBe("IMPORTED");
    expect(seen1.reason).toMatch(/conversation/);
    // The one quoting the reference, and the one the local model placed (its quote is in the message).
    expect(await db.response.count({ where: { requestId: b.id, subject: `Reply to ${b.reference}` } })).toBe(1);
    expect(await db.response.count({ where: { requestId: c.id, subject: "Regarding your mail" } })).toBe(1);
    expect((await db.gmailSeen.findUniqueOrThrow({ where: { messageId: "m4" } })).reason).toMatch(/local model, quoting/);
    // Not about a case: its id only; its content was never fetched or stored.
    expect((await db.gmailSeen.findUniqueOrThrow({ where: { messageId: "m2" } })).outcome).toBe("IGNORED");
    expect(box.fetched).not.toContain("m2");
    expect(await db.inboxMessage.count({ where: { subject: "Big sale this week" } })).toBe(0);
    // The organisation's own customer mail, and another person on a shared domain: not kept, not shown to the model.
    expect((await db.gmailSeen.findUniqueOrThrow({ where: { messageId: "m6" } })).outcome).toBe("IGNORED");
    expect((await db.gmailSeen.findUniqueOrThrow({ where: { messageId: "m7" } })).outcome).toBe("IGNORED");
    expect(box.fetched).not.toContain("m7");
    expect(await db.inboxMessage.count({ where: { gmailMessageId: { in: ["m6", "m7"] } } })).toBe(0);
    expect(await db.response.count({ where: { subject: { in: ["Your statement for October is ready", "Re: your request"] } } })).toBe(0);
    // Unsure: in the station inbox for an officer, with what the rules suggest (the model's unsupported answer is not used).
    const q = await db.inboxMessage.findFirstOrThrow({ where: { gmailMessageId: "m5" } });
    expect(q).toMatchObject({ status: "UNREAD", source: "GMAIL" });
    expect(q.suggestionNote ?? "").not.toMatch(/local model/);
    expect(await db.auditEvent.count({ where: { action: "gmail.reply_linked" } })).toBe(3);

    // Each message is looked at once.
    const again = await readGmailReplies(db, box.api, { generate: model });
    expect(again.looked).toBe(0);
  });

  it("reads nothing while the link may not read the inbox, and says so", async () => {
    useGmail("station.test@example.invalid", { scope: "https://www.googleapis.com/auth/gmail.compose" });
    const box = inbox([msg("m9", "T-9", "desk@bank-a.example.invalid", "Re: anything", "Text.")]);
    const pass = await readGmailReplies(db, box.api);
    expect(pass.looked).toBe(0);
    expect(pass.note).toMatch(/connect Gmail again/);
    useGmail("station.test@example.invalid", { gmail: { readReplies: false }, scope: READ });
    expect((await readGmailReplies(db, box.api)).note).toMatch(/switched off/);
  });
});
