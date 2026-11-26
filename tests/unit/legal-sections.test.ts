import { describe, expect, it } from "vitest";
import { formatSections, readSections, sectionItems } from "@/domain/legal-sections";

describe("formatSections", () => {
  it("puts the section first and the act after it", () => {
    expect(formatSections("BNS 318(4), IT Act 66D")).toBe("318(4) BNS, 66D IT Act");
    expect(formatSections("BNS 318(4), IT Act 66C, 66D")).toBe("318(4) BNS, 66C IT Act, 66D IT Act");
    expect(formatSections("BNS 308, 351, IT Act 67")).toBe("308 BNS, 351 BNS, 67 IT Act");
  });

  it("reads semicolons and keeps each section's own wording", () => {
    expect(formatSections("BNS 318(4); IT Act 66-D")).toBe("318(4) BNS, 66-D IT Act");
    expect(formatSections("IT Act 66-C, 66-D; BNS 318(4), 319(2)")).toBe("66-C IT Act, 66-D IT Act, 318(4) BNS, 319(2) BNS");
    expect(formatSections("BNS 351, 79; IT Act 67")).toBe("351 BNS, 79 BNS, 67 IT Act");
  });

  it("reads the CCTNS copy's own lists", () => {
    expect(formatSections("BNS 318(4), 319(2) r/w 3(5); IT Act 66-D")).toBe("318(4) BNS, 319(2) r/w 3(5) BNS, 66-D IT Act");
  });

  it("leaves text already in that order as it is", () => {
    expect(formatSections("318(4) BNS, 66D IT Act")).toBe("318(4) BNS, 66D IT Act");
    expect(formatSections("318(4), 319(2) BNS; 66D IT Act")).toBe("318(4) BNS, 319(2) BNS, 66D IT Act");
  });

  it("drops section keywords but keeps read-with joins together", () => {
    expect(formatSections("u/s 318(4) r/w 3(5) BNS")).toBe("318(4) r/w 3(5) BNS");
    expect(formatSections("BNS Sec. 318(4) and 319(2)")).toBe("318(4) BNS, 319(2) BNS");
    expect(formatSections("Section 66D of the IT Act")).toBe("66D IT Act");
  });

  it("shows anything it cannot be sure of exactly as written", () => {
    expect(formatSections("as per the FIR copy")).toBe("as per the FIR copy");
    expect(formatSections("318(4), IT Act 66D")).toBe("318(4), IT Act 66D"); // 318(4) has no act
    expect(formatSections("318(4)")).toBe("318(4)");
    expect(formatSections("IT Act")).toBe("IT Act");
    expect(formatSections("IT Act, 2000 Sec 66D")).toBe("IT Act, 2000 Sec 66D");
    expect(formatSections("  BNS   318(4) ")).toBe("318(4) BNS");
  });

  it("is empty for nothing", () => {
    expect(formatSections(null)).toBe("");
    expect(formatSections(undefined)).toBe("");
    expect(formatSections("   ")).toBe("");
    expect(readSections("")).toBeNull();
  });

  it("lists each section on its own", () => {
    expect(sectionItems("BNS 318(4), IT Act 66C, 66D")).toEqual(["318(4) BNS", "66C IT Act", "66D IT Act"]);
    expect(sectionItems("as per the FIR copy")).toEqual(["as per the FIR copy"]);
    expect(sectionItems(null)).toEqual([]);
  });

  it("never invents or loses a section", () => {
    for (const s of ["BNS 318(4), IT Act 66D", "BNS 318(4); IT Act 66-D", "IT Act 66-C, 66-D; BNS 318(4), 319(2)", "BNS 308, 351, IT Act 67"]) {
      const nums = (x: string) => (x.match(/\d+[A-Za-z]?(?:-[A-Za-z])?(?:\(\d+\))?/g) ?? []).sort();
      expect(nums(formatSections(s))).toEqual(nums(s));
    }
  });
});
