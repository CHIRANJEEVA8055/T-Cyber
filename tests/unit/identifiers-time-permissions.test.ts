import { describe, expect, it } from "vitest";
import { normalizeIdentifier, isMaskedValue } from "@/domain/identifiers";
import { formatDateTimeIST, formatDateIST, istInputToUtc, utcToIstInput } from "@/domain/time";
import { canReadCase, canManageDirectory, canResetDemo } from "@/domain/permissions";

describe("normalizeIdentifier", () => {
  it("preserves leading zeros in bank account numbers", () => {
    expect(normalizeIdentifier("BANK_ACCOUNT", "0045 1200-0068")).toBe("004512000068");
  });

  it("keeps masked characters so masked and full numbers never silently merge", () => {
    expect(normalizeIdentifier("BANK_ACCOUNT", "xxxxxxxx4821")).toBe("XXXXXXXX4821");
    expect(isMaskedValue("XXXXXXXX4821")).toBe(true);
    expect(isMaskedValue("004512004821")).toBe(false);
  });

  it("normalises Indian mobile numbers to +91 form", () => {
    expect(normalizeIdentifier("PHONE", "098480 12345")).toBe("+919848012345");
    expect(normalizeIdentifier("PHONE", "+91-98480-12345")).toBe("+919848012345");
    expect(normalizeIdentifier("PHONE", "+91-XXXXXX4512")).toBe("+91XXXXXX4512");
  });

  it("lower-cases emails, UPI handles and website hosts", () => {
    expect(normalizeIdentifier("EMAIL", " Advisor.Desk@TradePrime-Demo.example.invalid ")).toBe(
      "advisor.desk@tradeprime-demo.example.invalid",
    );
    expect(normalizeIdentifier("UPI_ID", "Demo.Trader@OKDEMO")).toBe("demo.trader@okdemo");
    expect(normalizeIdentifier("WEBSITE", "https://TradePrime-Demo.example.invalid/login/")).toBe(
      "tradeprime-demo.example.invalid/login",
    );
  });

  it("normalises IPv4 octets without treating leading zeros as octal", () => {
    expect(normalizeIdentifier("IP_ADDRESS", "203.0.113.045")).toBe("203.0.113.45");
  });
});

describe("Asia/Kolkata time formatting", () => {
  it("formats UTC instants in IST with an explicit label", () => {
    expect(formatDateTimeIST(new Date("2026-10-03T06:12:00Z"))).toBe("03 Oct 2026, 11:42 IST");
    expect(formatDateIST(new Date("2026-10-03T20:00:00Z"))).toBe("04 Oct 2026");
  });

  it("converts datetime-local input entered in IST to UTC and back", () => {
    const utc = istInputToUtc("2026-10-03T11:42");
    expect(utc?.toISOString()).toBe("2026-10-03T06:12:00.000Z");
    expect(utcToIstInput(new Date("2026-10-03T06:12:00Z"))).toBe("2026-10-03T11:42");
  });

  it("rejects malformed datetime input", () => {
    expect(istInputToUtc("03/10/2026")).toBeNull();
    expect(istInputToUtc("2026-13-03T11:42")).toBeNull();
  });
});

describe("case permissions", () => {
  const caseInfo = { stationId: "s1", assignedUserIds: ["io1"] };

  it("lets assigned officers read the case", () => {
    expect(canReadCase({ id: "io1", role: "OFFICER", stationId: "s1" }, caseInfo)).toBe(true);
  });

  it("denies unassigned officers even at the same station", () => {
    expect(canReadCase({ id: "io2", role: "OFFICER", stationId: "s1" }, caseInfo)).toBe(false);
  });

  it("lets supervisors read cases at their own station only", () => {
    expect(canReadCase({ id: "sup", role: "SUPERVISOR", stationId: "s1" }, caseInfo)).toBe(true);
    expect(canReadCase({ id: "sup2", role: "SUPERVISOR", stationId: "s2" }, caseInfo)).toBe(false);
  });

  it("restricts directory management and demo reset to supervisors", () => {
    expect(canManageDirectory({ id: "io1", role: "OFFICER", stationId: "s1" })).toBe(false);
    expect(canManageDirectory({ id: "sup", role: "SUPERVISOR", stationId: "s1" })).toBe(true);
    expect(canResetDemo({ id: "io1", role: "OFFICER", stationId: "s1" })).toBe(false);
  });
});
