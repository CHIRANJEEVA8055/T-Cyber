import { describe, expect, it } from "vitest";
import {
  parseRupeesToMinor,
  formatInr,
  minorToString,
  minorFromString,
  sumMinor,
  formatMaybeInr,
} from "@/domain/money";

describe("parseRupeesToMinor", () => {
  it("parses Indian-grouped rupee amounts into paise", () => {
    expect(parseRupeesToMinor("20,00,000")).toEqual({ ok: true, value: 200000000n });
  });

  it("parses western-grouped and ungrouped amounts", () => {
    expect(parseRupeesToMinor("2,000,000")).toEqual({ ok: true, value: 200000000n });
    expect(parseRupeesToMinor("600000")).toEqual({ ok: true, value: 60000000n });
  });

  it("accepts currency prefixes and the /- suffix used in Indian documents", () => {
    expect(parseRupeesToMinor("₹10,00,000")).toEqual({ ok: true, value: 100000000n });
    expect(parseRupeesToMinor("Rs. 4,00,000/-")).toEqual({ ok: true, value: 40000000n });
    expect(parseRupeesToMinor("INR 2,00,000.50")).toEqual({ ok: true, value: 20000050n });
  });

  it("keeps paise exactly without floating point drift", () => {
    expect(parseRupeesToMinor("0.10")).toEqual({ ok: true, value: 10n });
    expect(parseRupeesToMinor("1234567.89")).toEqual({ ok: true, value: 123456789n });
    expect(parseRupeesToMinor("0.3")).toEqual({ ok: true, value: 30n });
  });

  it("rejects malformed grouping instead of guessing", () => {
    expect(parseRupeesToMinor("1,0,0").ok).toBe(false);
    expect(parseRupeesToMinor("20,0000").ok).toBe(false);
  });

  it("rejects negatives, more than two decimals, exponents and text", () => {
    expect(parseRupeesToMinor("-500").ok).toBe(false);
    expect(parseRupeesToMinor("10.001").ok).toBe(false);
    expect(parseRupeesToMinor("1e6").ok).toBe(false);
    expect(parseRupeesToMinor("ten lakh").ok).toBe(false);
    expect(parseRupeesToMinor("").ok).toBe(false);
  });

  it("rejects amounts beyond the supported ceiling", () => {
    expect(parseRupeesToMinor("100000000000000").ok).toBe(false);
  });
});

describe("formatInr", () => {
  it("formats paise with Indian digit grouping", () => {
    expect(formatInr(200000000n)).toBe("₹20,00,000");
    expect(formatInr(1800000000n)).toBe("₹1,80,00,000");
    expect(formatInr(0n)).toBe("₹0");
  });

  it("shows paise only when they are not zero", () => {
    expect(formatInr(20000050n)).toBe("₹2,00,000.50");
    expect(formatInr(5n)).toBe("₹0.05");
  });

  it("formats negative adjustments with a leading minus sign", () => {
    expect(formatInr(-2000000n)).toBe("−₹20,000");
  });
});

describe("formatMaybeInr", () => {
  it("renders unknown amounts as Unknown, never as zero", () => {
    expect(formatMaybeInr(null)).toBe("Unknown");
    expect(formatMaybeInr(0n)).toBe("₹0");
  });
});

describe("minor unit serialisation", () => {
  it("round-trips through strings for JSON transport", () => {
    expect(minorToString(123456789012345n)).toBe("123456789012345");
    expect(minorFromString("123456789012345")).toBe(123456789012345n);
  });

  it("refuses non-integer strings", () => {
    expect(() => minorFromString("12.5")).toThrow();
    expect(() => minorFromString("abc")).toThrow();
    expect(() => minorFromString("")).toThrow();
  });
});

describe("sumMinor", () => {
  it("adds bigint amounts exactly", () => {
    expect(sumMinor([100000000n, 60000000n, 40000000n])).toBe(200000000n);
    expect(sumMinor([])).toBe(0n);
  });
});

describe("formatLakh", () => {
  it("writes large sums in lakh with one decimal, and small ones in full", async () => {
    const { formatLakh } = await import("@/domain/money");
    expect(formatLakh(925_0000_00n)).toBe("₹92.5 L");
    expect(formatLakh(1_24_000_00n)).toBe("₹1.2 L");
    expect(formatLakh(80_000_00n)).toBe("₹80,000");
    expect(formatLakh(0n)).toBe("₹0");
  });
});
