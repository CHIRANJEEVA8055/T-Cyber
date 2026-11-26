import { getDb } from "@/server/db";
import type { SessionUser } from "@/server/auth/session";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function asSessionUser(u: { id: string; username: string; displayName: string; rank: string; role: string; stationId: string }): SessionUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    rank: u.rank,
    role: u.role === "SUPERVISOR" ? "SUPERVISOR" : "OFFICER",
    stationId: u.stationId,
    stationCode: "TEST",
    stationName: "Test station",
  };
}

/** Minimal world: station, officer (assigned), second officer (unassigned), supervisor, one case, one account, routes. */
export async function buildWorld() {
  const db = getDb();
  const station = await db.station.create({ data: { code: uid("ST"), name: "Test station", district: "Test" } });
  const mk = (username: string, role: string) =>
    db.user.create({ data: { username: uid(username), displayName: username, rank: "SI", role, stationId: station.id, passwordHash: "x" } });
  const officer = await mk("officer", "OFFICER");
  const outsider = await mk("outsider", "OFFICER");
  const supervisor = await mk("supervisor", "SUPERVISOR");
  const kase = await db.case.create({
    data: {
      stationId: station.id,
      referenceType: "FIR",
      firNumber: Math.floor(Math.random() * 1e6),
      firYear: 2026,
      title: "Test case",
      // Synthetic test data routes through the synthetic directory, like the demonstration cases.
      isDemo: true,
      createdById: officer.id,
      assignments: { create: { userId: officer.id, role: "INVESTIGATING_OFFICER" } },
    },
  });
  const account = await db.entity.create({
    data: {
      caseId: kase.id,
      kind: "BANK_ACCOUNT",
      label: "Account A",
      value: "XXXXXXXX4821",
      normalizedValue: "XXXXXXXX4821",
      attributesJson: JSON.stringify({ bank: "Demo Bank A" }),
      discoveredAt: new Date(),
    },
  });
  const recipient = await db.recipient.create({
    data: {
      name: "Demo Bank A nodal officer",
      organisation: "Demo Bank A",
      organisationType: "BANK",
      channel: "EMAIL",
      address: "nodal@bank-a.example.invalid",
      verificationStatus: "VERIFIED",
      categoriesJson: JSON.stringify(["INFORMATION", "HOLD", "RESTORATION"]),
    },
  });
  const unverified = await db.recipient.create({
    data: {
      name: "Unverified desk",
      organisation: "Demo Bank A",
      organisationType: "BANK",
      channel: "EMAIL",
      address: "desk@bank-a.example.invalid",
      verificationStatus: "UNVERIFIED",
      categoriesJson: JSON.stringify(["INFORMATION", "HOLD"]),
    },
  });
  const portal = await db.recipient.create({
    data: {
      name: "Platform LE portal",
      organisation: "Demo Platform",
      organisationType: "PLATFORM",
      channel: "PORTAL",
      address: "Demo Platform law-enforcement portal",
      verificationStatus: "VERIFIED",
      categoriesJson: JSON.stringify(["PRESERVATION", "INFORMATION"]),
    },
  });
  await db.routingRule.create({
    data: { name: "Bank A hold", subjectKind: "BANK_ACCOUNT", category: "HOLD", resolveBy: "FIXED", recipientId: recipient.id, approvalRole: "SUPERVISOR", followUpDays: 5, procedureNote: "Test", matchJson: JSON.stringify({ bank: "Demo Bank A" }) },
  });
  for (const key of ["EMAIL_GATEWAY", "TELECOM_UNICROSS", "NPCI_ROUTE", "PROVIDER_PORTAL"]) {
    await db.integrationSetting.upsert({ where: { key }, create: { key, label: key, mode: "SIMULATED", note: "test" }, update: {} });
  }
  return {
    db,
    station,
    kase,
    account,
    recipient,
    unverified,
    portal,
    officer: asSessionUser(officer),
    outsider: asSessionUser(outsider),
    supervisor: asSessionUser(supervisor),
  };
}
