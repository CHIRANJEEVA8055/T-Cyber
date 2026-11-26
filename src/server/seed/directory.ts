import type { Db } from "../db";
import { getAppConfig } from "../config";
import { applyConfig } from "../services/config-sync";
import { hashPassword } from "../auth/password";
import { DEFAULT_TEMPLATES } from "../services/drafting";
import type { DemoTimeline } from "./timeline";
import { seedKnowledge } from "./knowledge";
import { seedPromptTemplates } from "./prompt-templates";

export const DEMO_PASSWORD = "tcyber-demo";

const TEMPLATE_NAMES: Record<string, string> = {
  HOLD: "Hold request to a bank (CFCFRMS)",
  INFORMATION_BANK: "Statement and KYC request to a bank",
  INFORMATION_PHONE: "CDR and CAF request (UNICROSS route)",
  INFORMATION_IP: "Login session details request",
  INFORMATION_OTHER: "Information request",
  INFORMATION_ACCOUNT: "Account details request (email or profile)",
  PRESERVATION: "Preservation request (provider portal)",
  RESTORATION: "Restoration of held funds",
  FOLLOW_UP: "Reminder for outstanding items",
};

export async function seedDirectory(db: Db, T: DemoTimeline) {
  const cfg = getAppConfig();
  await applyConfig(db, cfg);
  const station = await db.station.findUniqueOrThrow({ where: { code: cfg.station.code } });
  const passwordHash = hashPassword(DEMO_PASSWORD);
  const joined = T.at(-300, "09:00");
  const user = (username: string, displayName: string, rank: string, role: string) =>
    db.user.create({ data: { username, displayName, rank, role, stationId: station.id, passwordHash, createdAt: joined } });
  const officer1 = await user("officer1", "Krishna", "Sub-Inspector", "OFFICER");
  const officer2 = await user("officer2", "P. Lavanya", "Sub-Inspector", "OFFICER");
  const officer3 = await user("officer3", "M. Arjun", "Sub-Inspector", "OFFICER");
  const supervisor = await user("supervisor", "R. Devi", "Inspector", "SUPERVISOR");
  // Keeps the knowledge base and the assistant's ready questions; cannot open any case or station record.
  const developer = await user("developer", "Developer", "System developer", "DEVELOPER");
  if ((await db.promptTemplate.count()) === 0) await seedPromptTemplates(db, developer.id, joined);
  // Author of drafts the rules prepare. Never active and has no usable password, so nobody can sign in as it.
  await db.user.create({ data: { username: "assistant", displayName: "Assistant", rank: "System", role: "SYSTEM", stationId: station.id, passwordHash: "!", active: false, createdAt: joined } });

  // Directory entries come from config/t-cyber.config.json; verification is recorded as done by the supervisor.
  await db.recipient.updateMany({
    where: { configKey: { not: null }, verificationStatus: "VERIFIED" },
    data: { verifiedById: supervisor.id, verifiedAt: T.at(-20, "10:00"), verificationNote: "Checked against the station's directory list (demonstration procedure)." },
  });
  const byKey = (key: string) => db.recipient.findUniqueOrThrow({ where: { configKey: key } });
  const unicross = await byKey("unicross-zone");
  const npci = await byKey("npci-route");
  const dating = await byKey("dating-portal");
  const messaging = await byKey("messaging-portal");
  const mail = await byKey("mail-portal");

  const templateIds: Record<string, string> = {};
  for (const [category, t] of Object.entries(DEFAULT_TEMPLATES)) {
    const created = await db.template.create({ data: { name: TEMPLATE_NAMES[category] ?? category, category, subjectTemplate: t.subject, bodyTemplate: t.body } });
    templateIds[category] = created.id;
  }

  const rule = (data: { name: string; subjectKind: string; category: string; resolveBy: string; recipientId?: string; template: string; followUpDays: number; procedureNote: string; approvalRole?: string; match?: Record<string, string> }) =>
    db.routingRule.create({
      data: {
        name: data.name,
        subjectKind: data.subjectKind,
        category: data.category,
        resolveBy: data.resolveBy,
        recipientId: data.recipientId ?? null,
        templateId: templateIds[data.template] ?? null,
        approvalRole: data.approvalRole ?? "INVESTIGATING_OFFICER",
        followUpDays: data.followUpDays,
        procedureNote: data.procedureNote,
        ...(data.match ? { matchJson: JSON.stringify(data.match) } : {}),
      },
    });
  await rule({ name: "Bank account: hold (CFCFRMS)", subjectKind: "BANK_ACCOUNT", category: "HOLD", resolveBy: "ACCOUNT_BANK", template: "HOLD", followUpDays: 2, procedureNote: "To the nodal officer of the bank named on the account, through CFCFRMS (simulated). Holds are time-critical: money usually moves on within 48 hours." });
  await rule({ name: "Bank account: statement and KYC", subjectKind: "BANK_ACCOUNT", category: "INFORMATION", resolveBy: "ACCOUNT_BANK", template: "INFORMATION_BANK", followUpDays: 5, procedureNote: "To the bank's nodal officer, with a Section 94 BNSS notice. Only verified nodal addresses from the directory." });
  await rule({ name: "Bank account: restoration", subjectKind: "BANK_ACCOUNT", category: "RESTORATION", resolveBy: "ACCOUNT_BANK", template: "RESTORATION", followUpDays: 7, approvalRole: "SUPERVISOR", procedureNote: "Only after the order or approval reference is recorded. A supervisor approves." });
  await rule({ name: "Phone number: CDR and CAF (UNICROSS)", subjectKind: "PHONE", category: "INFORMATION", resolveBy: "FIXED", recipientId: unicross.id, template: "INFORMATION_PHONE", followUpDays: 8, procedureNote: "Through the Zonal ACP's UNICROSS desk; replies come back through the DD mailbox. Usually 5 to 8 days." });
  await rule({ name: "UPI ID: beneficiary trace (NPCI)", subjectKind: "UPI_ID", category: "INFORMATION", resolveBy: "FIXED", recipientId: npci.id, template: "INFORMATION_OTHER", followUpDays: 5, procedureNote: "NPCI, then the bank or app. Needs the 12-digit UTR, amount, date and payer VPA; a reference with unreadable digits is held back until verified." });
  await rule({ name: "Dating profile: preservation", subjectKind: "PLATFORM_PROFILE", category: "PRESERVATION", resolveBy: "FIXED", recipientId: dating.id, template: "PRESERVATION", followUpDays: 30, match: { platform: "Dating platform" }, procedureNote: "Preservation first, on the provider's portal; disclosure is a separate submission." });
  await rule({ name: "Dating profile: disclosure", subjectKind: "PLATFORM_PROFILE", category: "INFORMATION", resolveBy: "FIXED", recipientId: dating.id, template: "INFORMATION_OTHER", followUpDays: 30, match: { platform: "Dating platform" }, procedureNote: "Needs a legal process reference and the exact account identifier." });
  await rule({ name: "Messaging profile: preservation", subjectKind: "PLATFORM_PROFILE", category: "PRESERVATION", resolveBy: "FIXED", recipientId: messaging.id, template: "PRESERVATION", followUpDays: 30, procedureNote: "Preservation is separate from disclosure. Submitted by the officer on the provider portal." });
  await rule({ name: "Messaging profile: disclosure", subjectKind: "PLATFORM_PROFILE", category: "INFORMATION", resolveBy: "FIXED", recipientId: messaging.id, template: "INFORMATION_OTHER", followUpDays: 30, procedureNote: "Provider portal. Disclosure depends on the provider's own process." });
  await rule({ name: "Email address: preservation", subjectKind: "EMAIL", category: "PRESERVATION", resolveBy: "FIXED", recipientId: mail.id, template: "PRESERVATION", followUpDays: 30, procedureNote: "Provider portal (synthetic). The portal address is not yet verified." });
  await rule({ name: "Email address: account details", subjectKind: "EMAIL", category: "INFORMATION", resolveBy: "FIXED", recipientId: mail.id, template: "INFORMATION_ACCOUNT", followUpDays: 15, procedureNote: "To the mail provider's law-enforcement team: who registered the address, its phone numbers and recovery email, and the login IP addresses." });
  await rule({ name: "IP address: session details from the reporting bank", subjectKind: "IP_ADDRESS", category: "INFORMATION", resolveBy: "LINKED_ACCOUNT_BANK", template: "INFORMATION_IP", followUpDays: 7, procedureNote: "To the bank whose record linked the IP address to an account." });

  const integrations = [
    { key: "EMAIL_GATEWAY", label: "Bank nodal and LEA email (CFCFRMS for holds)", note: "Simulation adapter. No email is sent and nothing reaches CFCFRMS; a synthetic reference is returned." },
    { key: "TELECOM_UNICROSS", label: "UNICROSS through the Zonal ACP", note: "Simulation adapter for the department's route. Nothing leaves this application." },
    { key: "NPCI_ROUTE", label: "NPCI and payment-app route", note: "Simulation adapter. No request reaches NPCI or any payment app." },
    { key: "PROVIDER_PORTAL", label: "Provider law-enforcement portals", note: "Not automated. Officers submit on the portal and record the reference." },
    { key: "AI_PROVIDER", label: "Assistant", note: "Rules answer first, from the case record and the approved sources. A local model through Ollama reads scans and translates when rules cannot; nothing is sent outside this server." },
  ];
  for (const i of integrations) await db.integrationSetting.create({ data: { ...i, mode: i.key === "AI_PROVIDER" ? "LOCAL" : "SIMULATED" } });

  // The knowledge base survives a demonstration reset; the illustrative library is only loaded into an empty one.
  if ((await db.knowledgeDocument.count()) === 0) await seedKnowledge(db);
  return { station, officer1, officer2, officer3, supervisor };
}
