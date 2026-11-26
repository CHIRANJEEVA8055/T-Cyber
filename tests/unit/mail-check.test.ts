import { describe, expect, it } from "vitest";
import { addressProblem, checkMail, invalidLine, splitAddresses, withItemLine, withoutItemLine } from "@/domain/mail-check";

const ok = { to: "nodal@bank.in", subject: "FIR 1/2026 · statement", body: "Sir/Madam,\n\nKindly furnish the statement.\n\nRegards", attachmentBytes: 0, hasItems: true, itemsKept: 1 };

describe("the mail window's checks", () => {
  it("passes a complete mail", () => {
    expect(checkMail(ok)).toEqual({});
    expect(invalidLine({})).toBeNull();
  });

  it("names each field that is wrong, in the window's order", () => {
    const e = checkMail({ ...ok, to: "", body: "Sir/Madam,\n\nTo [Bank A: to be filled in], kindly furnish …", hasItems: true, itemsKept: 0 });
    expect(Object.keys(e).sort()).toEqual(["body", "items", "to"]);
    expect(e.to).toBe("Type the address to send it to.");
    expect(e.body).toBe("Fill in [Bank A: to be filled in] first.");
    expect(invalidLine(e)).toBe("Invalid: To, Mail text, Asks for");
  });

  it("refuses addresses that are not addresses, or that can never receive mail", () => {
    expect(checkMail({ ...ok, to: "nodal at bank" }).to).toMatch(/is not an email address/);
    expect(checkMail({ ...ok, to: "x@mail-portal.example.invalid" }).to).toMatch(/placeholder address/);
    expect(addressProblem("desk@example.com")).toMatch(/placeholder/);
    expect(addressProblem("lea@hdfcbank.com")).toBeNull();
    expect(checkMail({ ...ok, to: "a@b.in, c@d.in, e@f.in, g@h.in, i@j.in, k@l.in" }).to).toMatch(/at most 5/);
  });

  it("reads the addresses however they are typed", () => {
    expect(splitAddresses("A <a@b.in>; c@d.in  c@d.in,mailto:e@f.in")).toEqual(["a@b.in", "c@d.in", "e@f.in"]);
  });

  it("keeps the subject and text to sensible lengths and the files under Gmail's limit", () => {
    expect(checkMail({ ...ok, subject: "Hi" }).subject).toMatch(/at least 5/);
    expect(checkMail({ ...ok, body: "Too short" }).body).toMatch(/at least 20/);
    expect(checkMail({ ...ok, attachmentBytes: 19 * 1024 * 1024 }).attachments).toMatch(/at most about 18 MB/);
    expect(checkMail({ ...ok, missingAttachments: ["An attached file"] }).attachments).toMatch(/no longer in the case/);
    expect(checkMail({ ...ok, body: "Sir,\n\nAuthority: [record the order or approval reference before approval]\n\nKindly restore." }).body).toMatch(/^Fill in \[record the order/);
  });

  it("does not ask an officer's own mail to list items", () => {
    expect(checkMail({ ...ok, hasItems: false, itemsKept: 0 })).toEqual({});
  });

  it("takes an item's line out of the text and puts it back where the list is", () => {
    const body = "Sir/Madam,\n\nKindly furnish:\n- Statement\n- KYC\n\nKindly reply quoting REQ-1.";
    const without = withoutItemLine(body, "KYC")!;
    expect(without).toBe("Sir/Madam,\n\nKindly furnish:\n- Statement\n\nKindly reply quoting REQ-1.");
    expect(withItemLine(without, "KYC", ["Statement"])).toBe(body);
    expect(withoutItemLine(body, "Not listed")).toBeNull();
    // With no item left to follow, the line goes under the line that introduces the list.
    expect(withItemLine("Sir/Madam,\n\nKindly furnish:\n\nKindly reply quoting REQ-1.", "KYC", [])).toBe("Sir/Madam,\n\nKindly furnish:\n- KYC\n\nKindly reply quoting REQ-1.");
  });
});

describe("matching a reply by its sender", () => {
  it("takes a shared domain (gmail.com, nic.in) as a sign only when it is the very address the request went to", async () => {
    const { scoreReply } = await import("@/domain/reply-match");
    const req = { reference: "REQ-2026-0001", recipientAddress: "officer.x@gmail.com", firReference: null, identifiers: [] };
    expect(scoreReply({ fromAddress: "someone.else@gmail.com", subject: "Hello", bodyText: "Hi" }, req).score).toBe(1);
    expect(scoreReply({ fromAddress: "Officer X <officer.x@gmail.com>", subject: "Re", bodyText: "Done" }, req).score).toBe(25);
    expect(scoreReply({ fromAddress: "other@nic.in", subject: "Re", bodyText: "" }, { ...req, recipientAddress: "desk@nic.in" }).score).toBe(1);
    // An organisation's own domain still counts.
    expect(scoreReply({ fromAddress: "lea.cell@hdfcbank.com", subject: "Re", bodyText: "" }, { ...req, recipientAddress: "nodal@hdfcbank.com" }).score).toBe(25);
  });
});

describe("a Gmail draft without an addressee yet", () => {
  it("has no To line at all (Gmail refuses a placeholder one)", async () => {
    const { buildMime } = await import("@/server/mail/message");
    const none = buildMime({ from: "station@example.invalid", to: "", subject: "FIR 1/2026 · details", text: "Sir/Madam," }).mime;
    expect(none.split("\r\n\r\n")[0]).not.toMatch(/^To:/m);
    const some = buildMime({ from: "station@example.invalid", to: "lea@provider.in", subject: "FIR 1/2026 · details", text: "Sir/Madam," }).mime;
    expect(some).toMatch(/^To: lea@provider\.in$/m);
  });
});
