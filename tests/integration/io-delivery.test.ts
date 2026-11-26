import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { seedDemo } from "@/server/seed";
import type { SessionUser } from "@/server/auth/session";
import { approveAndSend, recordForwarded, submitRequest, updateDraft } from "@/server/services/requests";
import { requestEml } from "@/server/services/forwarding";
import { buildMime } from "@/server/mail/message";
import { useDelivery } from "../support/delivery-config";

/**
 * Version 1 delivery: approved requests are mailed to the PS investigating officer's mailbox (configured), the IO
 * forwards them from their own mailbox and records it. Synthetic addresses only.
 */
const db = getDb();
const IO = "io.test@police.example.invalid";
async function user(username: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { username }, include: { station: true } });
  return { id: u.id, username, displayName: u.displayName, rank: u.rank, role: u.role as SessionUser["role"], stationId: u.stationId, stationCode: u.station.code, stationName: u.station.name };
}
let fir412 = "";
// Drafts the supervisor did not write (so the supervisor may approve them).
const drafts = async (anyCase = false) => {
  const sup = await db.user.findUniqueOrThrow({ where: { username: "supervisor" } });
  const all = await db.request.findMany({ where: { ...(anyCase ? { case: { isDemo: true } } : { caseId: fir412 }), status: "DRAFT", recipient: { verificationStatus: "VERIFIED" } }, include: { recipient: true, versions: { orderBy: { versionNo: "desc" }, take: 1 } }, orderBy: { reference: "asc" } });
  return all.filter((r) => r.versions[0]!.createdById !== sup.id);
};

beforeAll(async () => {
  useDelivery({ mode: "via-io", ioMailbox: IO, ioName: "Investigating Officer, Test PS", transport: "simulated" });
  fir412 = (await seedDemo(db, { anchor: "2026-11-09" })).fir412Id;
}, 240000);

describe("approved requests go to the IO's mailbox to forward", () => {
  it("mails the approved request to the IO, with where to forward it, and does not call it sent", async () => {
    const req = (await drafts())[0]!;
    const out = await approveAndSend(db, await user("supervisor"), req.id, { expectedVersion: req.version, idempotencyKey: "io-1" });
    expect(out).toMatchObject({ outcome: "HANDED_OVER", to: IO, transport: "SIMULATED" });
    const after = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    expect(after).toMatchObject({ status: "APPROVED", handedOverTo: IO, submittedAt: null });
    expect(after.handedOverAt).not.toBeNull();
    const mail = await db.outboundMail.findFirstOrThrow({ where: { requestId: req.id } });
    expect(mail).toMatchObject({ toAddress: IO, transport: "SIMULATED", status: "KEPT" });
    expect(mail.subject).toBe(`Forward to ${req.recipient.organisation}: ${(await db.requestVersion.findFirstOrThrow({ where: { requestId: req.id, versionNo: after.currentVersionNo } })).subject}`);
    expect(mail.bodyText).toContain(`  To:       ${req.recipient.address}`);
    expect(mail.bodyText).toContain('choose "Mark as forwarded"');
    const sub = await db.submission.findFirstOrThrow({ where: { requestId: req.id } });
    expect(sub).toMatchObject({ outcome: "SUCCEEDED", recipientAddress: IO });
    expect(sub.adapter).toMatch(/simulated: kept in T-CYBER's outbox; nothing left this server/);
    expect(await db.auditEvent.count({ where: { objectId: req.id, action: "request.mailed_to_io" } })).toBe(1);
    // Mailing again with the same key does nothing new.
    expect(await approveAndSend(db, await user("supervisor"), req.id, { expectedVersion: after.version, idempotencyKey: "io-1" })).toMatchObject({ outcome: "HANDED_OVER" });
    expect(await db.outboundMail.count({ where: { requestId: req.id } })).toBe(1);
  });

  it("does not send straight to the nodal officer in this mode", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, status: "APPROVED" } });
    await expect(submitRequest(db, await user("supervisor"), req.id, { expectedVersion: req.version, confirmed: true, idempotencyKey: "io-direct" })).rejects.toMatchObject({ code: "PRECONDITION", message: expect.stringContaining("Mail to the IO") });
  });

  it("offers the approved request as a ready-to-send email to the nodal officer, and nothing unapproved", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, status: "APPROVED", handedOverTo: IO }, include: { recipient: true } });
    const eml = (await requestEml(db, await user("officer1"), req.id)).buffer.toString("utf8");
    expect(eml).toContain(`<${req.recipient.address}>`);
    expect(eml).toContain("X-Unsent: 1");
    expect(eml).toMatch(/^Subject: /m);
    const draft = (await drafts())[0]!;
    await expect(requestEml(db, await user("officer1"), draft.id)).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("records it as sent only when the IO marks it forwarded, from when it was forwarded", async () => {
    const req = await db.request.findFirstOrThrow({ where: { caseId: fir412, status: "APPROVED", handedOverTo: IO } });
    const officer = await user("officer1");
    await expect(recordForwarded(db, officer, req.id, { expectedVersion: req.version, forwardedAt: "2099-01-01T10:00" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordForwarded(db, officer, req.id, { expectedVersion: req.version, forwardedAt: "2020-01-01T10:00" })).rejects.toMatchObject({ code: "VALIDATION" });
    await recordForwarded(db, officer, req.id, { expectedVersion: req.version, note: "Sent from the IO's NIC mailbox" });
    const after = await db.request.findUniqueOrThrow({ where: { id: req.id } });
    expect(after.status).toBe("SUBMITTED");
    expect(after.submittedAt).not.toBeNull();
    expect(after.followUpAt).not.toBeNull();
    expect(after.externalReference).toBe("Sent from the IO's NIC mailbox");
    expect((await db.submission.findFirstOrThrow({ where: { requestId: req.id }, orderBy: { attemptedAt: "desc" } })).adapter).toMatch(/^Forwarded by .+ from their own mailbox/);
    expect(await db.auditEvent.count({ where: { objectId: req.id, action: "request.forwarded_recorded" } })).toBe(1);
  });

  it("takes the IO's copy back when the wording is edited after it was mailed", async () => {
    const req = (await drafts())[0]!;
    const sup = await user("supervisor");
    await approveAndSend(db, sup, req.id, { expectedVersion: req.version, idempotencyKey: "io-2" });
    const mailed = await db.request.findUniqueOrThrow({ where: { id: req.id }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 }, items: true } });
    expect(mailed.handedOverAt).not.toBeNull();
    const v = mailed.versions[0]!;
    await updateDraft(db, sup, req.id, { expectedVersion: mailed.version, recipientId: mailed.recipientId, subject: v.subject, body: `${v.body}\n\nEdited.`, scope: v.scope, periodFrom: v.periodFrom, periodTo: v.periodTo, items: mailed.items.map((i) => ({ label: i.label, itemType: i.itemType })), attachmentIds: JSON.parse(v.attachmentIdsJson) as string[] });
    expect(await db.request.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ handedOverAt: null, handedOverTo: null, status: "DRAFT" });
  });
});

describe("mailing to the IO through a mail server", () => {
  let server: net.Server;
  const seen: string[] = [];
  let data = "";
  const env = { ...process.env };
  beforeAll(async () => {
    server = net.createServer((sock) => {
      let inData = false;
      let buf = "";
      sock.write("220 fake ESMTP\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              sock.write("250 queued\r\n");
            } else data += `${line}\n`;
            continue;
          }
          seen.push(line);
          if (/^EHLO/.test(line)) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (/^AUTH PLAIN/.test(line)) sock.write("235 ok\r\n");
          else if (/^(MAIL FROM|RCPT TO)/.test(line)) sock.write("250 ok\r\n");
          else if (line === "DATA") {
            inData = true;
            sock.write("354 go\r\n");
          }
          else if (line === "QUIT") sock.end("221 bye\r\n");
          else sock.write("500 what\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    server.close();
    process.env = env;
  });

  it("sends it, records it as sent, and never puts the login in the record", async () => {
    useDelivery({ transport: "smtp" });
    Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String((server.address() as net.AddressInfo).port), SMTP_SECURE: "none", SMTP_USER: "relay-user", SMTP_PASS: "relay-secret" });
    const req = (await drafts())[0]!;
    const out = await approveAndSend(db, await user("supervisor"), req.id, { expectedVersion: req.version, idempotencyKey: "io-smtp-1" });
    expect(out).toMatchObject({ outcome: "HANDED_OVER", transport: "SMTP", to: IO });
    expect(seen).toContain(`RCPT TO:<${IO}>`);
    expect(seen.some((l) => l.startsWith("AUTH PLAIN "))).toBe(true);
    // The subject is RFC 2047-encoded when it has non-ASCII characters ("·").
    const subject = /^Subject: (.*)$/m.exec(data)![1]!.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b: string) => Buffer.from(b, "base64").toString("utf8"));
    expect(subject.startsWith("Forward to ")).toBe(true);
    const mail = await db.outboundMail.findFirstOrThrow({ where: { requestId: req.id } });
    expect(mail).toMatchObject({ transport: "SMTP", status: "SENT" });
    expect(JSON.stringify(mail)).not.toContain("relay-secret");
  });

  it("fails plainly, sending nothing, when the mail server is not set", async () => {
    useDelivery({ transport: "smtp" });
    delete process.env.SMTP_HOST;
    const req = (await drafts(true))[0]!;
    const out = await approveAndSend(db, await user("supervisor"), req.id, { expectedVersion: req.version, idempotencyKey: "io-smtp-2" });
    expect(out).toMatchObject({ outcome: "FAILED" });
    expect(out.outcome === "FAILED" && out.error).toMatch(/SMTP_HOST is not set.*Nothing was sent/);
    expect(await db.request.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: "SUBMISSION_FAILED", handedOverAt: null });
  });
});

describe("an email built for sending", () => {
  it("keeps line breaks out of its headers, encodes non-ASCII and carries attachments", () => {
    const { mime } = buildMime({ from: "a@x.invalid", to: "b@y.invalid", subject: "Notice\r\nBcc: evil@z.invalid ₹ held", text: "Line 1\nLine 2", attachments: [{ fileName: "FIR 1.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }] });
    const headers = mime.split("\r\n\r\n")[0]!;
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(mime).toContain('Content-Disposition: attachment; filename="FIR 1.pdf"');
    expect(mime).toContain(Buffer.from("%PDF").toString("base64"));
  });
});
