import { describe, expect, it } from "vitest";
import { buildDocx } from "@/server/documents/docx-writer";
import { readDocxBlocks, readEmailBlocks, readTextDocument } from "@/server/documents/read-text";
import { splitIntoSections } from "@/domain/knowledge-split";

describe("reading uploaded documents", () => {
  it("writes a Word file that reads back with its headings and escaped text", () => {
    const docx = buildDocx(
      [
        { kind: "title", text: "Hold procedure <draft>" },
        { kind: "heading", text: "1. Scope" },
        { kind: "para", text: "Holds follow the NCRP acknowledgement & the FIR." },
        { kind: "bullet", text: "Confirm the amount" },
      ],
      { title: "Hold procedure", author: "SI Krishna", created: new Date("2026-11-11T05:00:00Z") },
    );
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
    const blocks = readDocxBlocks(docx).filter((b) => b.text);
    expect(blocks[0]).toEqual({ text: "Hold procedure <draft>", headingLevel: 1 });
    expect(blocks[1]).toEqual({ text: "1. Scope", headingLevel: 1 });
    expect(blocks[2]!.text).toBe("Holds follow the NCRP acknowledgement & the FIR.");
    const sections = splitIntoSections(readDocxBlocks(docx));
    expect(sections.find((s) => s.sectionRef === "§1")?.text).toContain("NCRP acknowledgement & the FIR.");
  });

  it("reads Markdown and plain text, and refuses types it cannot read", async () => {
    const md = await readTextDocument("guide.md", Buffer.from("# Holds\nA hold is a lien.\n"));
    expect(md.mimeType).toBe("text/markdown");
    expect(splitIntoSections(md.blocks)[0]).toMatchObject({ heading: "Holds", text: "A hold is a lien." });
    await expect(readTextDocument("photo.png", Buffer.from([0x89, 0x50]))).rejects.toThrow(/cannot be read here/);
    await expect(readTextDocument("empty.txt", Buffer.alloc(0))).rejects.toThrow(/empty/);
    await expect(readTextDocument("fake.docx", Buffer.from("not a zip"))).rejects.toThrow(/does not match/);
  });

  it("reads an email's subject, sender and plain-text body, decoding quoted-printable", () => {
    const raw = ["From: nodal@bank-a.example.invalid", "Subject: Re: R-01 hold confirmation", "Date: Mon, 09 Nov 2026 09:12:00 +0530", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "Hold of =E2=82=B930,000 confirmed on account =", "ending 4471."].join("\r\n");
    const text = readEmailBlocks(raw).map((b) => b.text);
    expect(text).toContain("Subject: Re: R-01 hold confirmation");
    expect(text).toContain("From: nodal@bank-a.example.invalid");
    expect(text.join(" ")).toContain("Hold of ₹30,000 confirmed on account ending 4471.");
  });
});
