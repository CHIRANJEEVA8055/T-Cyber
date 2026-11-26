import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Station configuration file (default config/t-cyber.config.json, override with T_CYBER_CONFIG).
 * One place for station identity, the outgoing mailbox, request defaults and the recipient directory.
 * The file is re-read automatically when it changes, and validated before use.
 */

const CHANNELS = ["EMAIL", "PORTAL", "UNICROSS", "NPCI_ROUTE"] as const;
const CATEGORIES = ["INFORMATION", "PRESERVATION", "HOLD", "RESTORATION"] as const;
const ORG_TYPES = ["BANK", "TELECOM", "PAYMENT_PROVIDER", "NPCI", "PLATFORM", "POLICE_UNIT"] as const;
const email = z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address like name@domain.example.invalid");

const recipientSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/, "use lower-case letters, digits and hyphens"),
    organisation: z.string().trim().min(2),
    name: z.string().trim().min(2),
    organisationType: z.enum(ORG_TYPES),
    channel: z.enum(CHANNELS),
    address: z.string().trim().min(3),
    ifscPrefix: z.string().regex(/^[A-Z]{4}$/, "must be four capital letters").optional(),
    categories: z.array(z.enum(CATEGORIES)).min(1),
    verified: z.boolean(),
    verificationNote: z.string().optional(),
    notes: z.string().optional(),
    /** Domains this recipient's replies arrive from when they are forwarded (e.g. UNICROSS replies through the DD mailbox). */
    replyDomains: z.array(z.string().trim().toLowerCase()).optional(),
    /**
     * Demonstration entries (the default) are used only for demonstration cases. Set false for a real provider's address
     * the station has confirmed, so real cases can be routed to it.
     */
    synthetic: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.channel !== "PORTAL" && !email.safeParse(r.address).success) {
      ctx.addIssue({ code: "custom", path: ["address"], message: `channel ${r.channel} needs an email address` });
    }
  });

const configSchema = z
  .object({
    $comment: z.string().optional(),
    station: z.object({
      code: z.string().regex(/^[A-Z0-9-]{3,20}$/, "use 3-20 capital letters, digits or hyphens"),
      name: z.string().trim().min(3),
      district: z.string().trim().min(2),
      address: z.string().trim().default(""),
      phone: z.string().trim().default(""),
      email: email,
      /** Lines printed at the top of a request letter ("GOVERNMENT OF TELANGANA", "(POLICE DEPARTMENT)"). */
      letterhead: z.array(z.string().trim().min(1)).default([]),
    }),
    mailbox: z.object({
      fromAddress: email,
      displayName: z.string().trim().min(3),
      /** The line before the officer's name at the foot of a letter, as the station's notices have it. */
      valediction: z.string().trim().max(40).default("Yours faithfully,"),
      signature: z.array(z.string().trim()).min(1),
    }),
    /**
     * How approved requests leave the station. "via-io" (v1): each one is mailed to the PS investigating officer's
     * mailbox below, and the IO forwards it to the nodal officer from their own mailbox and records it as forwarded.
     * "direct": sent straight to the nodal officer (needs the station mailbox's SMTP/IMAP access to be approved).
     * transport "simulated" keeps the mail in T-CYBER's outbox (nothing leaves this server); "smtp" sends it through
     * the mail server set in the environment (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS), never here.
     */
    delivery: z
      .object({
        mode: z.enum(["gmail", "via-io", "direct"]).default("via-io"),
        ioMailbox: email.optional(),
        ioName: z.string().trim().min(3).default("Investigating Officer"),
        transport: z.enum(["simulated", "smtp"]).default("simulated"),
      })
      .default({ mode: "via-io", ioName: "Investigating Officer", transport: "simulated" }),
    /**
     * Prototype link to one Gmail account (Gmail API, "compose" permission only): every request draft is kept as a
     * draft in that account's Drafts, edits on either side are carried to the other, and an approved request is sent
     * from that account to the address the officer types. The OAuth client file and the token are kept outside the
     * configuration, in the files named here (under data/, which is never committed). Connect once with
     * `npm run gmail:connect`.
     */
    gmail: z
      .object({
        enabled: z.boolean().default(false),
        account: email.optional(),
        credentialsFile: z.string().trim().default("data/secrets/gmail-credentials.json"),
        tokenFile: z.string().trim().default("data/secrets/gmail-token.json"),
        syncSeconds: z.number().int().min(10).max(3600).default(20),
        /**
         * The officer who presses Send in the mail window approves the version they send, even when they wrote it
         * (logged as approved by sending). Off: another officer approves a version its author wrote. A route that
         * needs a supervisor still needs one either way.
         */
        senderApproves: z.boolean().default(false),
        /** Read replies in the linked account's inbox and link each to the request it answers (needs the read permission). */
        readReplies: z.boolean().default(true),
      })
      .default({ enabled: false, credentialsFile: "data/secrets/gmail-credentials.json", tokenFile: "data/secrets/gmail-token.json", syncSeconds: 20, senderApproves: false, readReplies: true }),
    requests: z.object({
      referencePrefix: z.string().regex(/^[A-Z]{2,6}$/, "use 2-6 capital letters"),
      defaultFollowUpDays: z.number().int().min(1).max(90),
      /** Draft the requests that new identifiers call for as soon as an officer records them. Drafts only: never sent automatically. */
      autoDraft: z.boolean().default(true),
      /**
       * The heading a printed request letter carries for each kind of request ("Notice U/Sec 94 BNSS"). A kind with no
       * heading here is printed without one: the assistant never chooses a provision for a letter.
       */
      noticeHeadings: z.partialRecord(z.enum(["INFORMATION", "PRESERVATION", "HOLD", "RESTORATION"]), z.string().trim().min(3)).default({}),
    }),
    directory: z.array(recipientSchema).min(1),
    /**
     * The local model used only where rules cannot do the work (reading scanned copies, translating Telugu or
     * Hindi, wording free answers). Loopback only unless allowNonLocalHost is set: case documents never leave
     * this server by default.
     */
    ai: z
      .object({
        provider: z.enum(["ollama", "none"]).default("ollama"),
        host: z.string().trim().default("http://127.0.0.1:11434"),
        model: z.string().trim().min(1).default("gemma4:26b"),
        timeoutSeconds: z.number().int().min(5).max(900).default(180),
        allowNonLocalHost: z.boolean().default(false),
      })
      .default({ provider: "ollama", host: "http://127.0.0.1:11434", model: "gemma4:26b", timeoutSeconds: 180, allowNonLocalHost: false }),
  })
  .superRefine((c, ctx) => {
    try {
      const h = new URL(c.ai.host).hostname;
      if (!c.ai.allowNonLocalHost && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(h)) {
        ctx.addIssue({ code: "custom", path: ["ai", "host"], message: "must be this server (127.0.0.1 or localhost); set allowNonLocalHost to send case material to another host" });
      }
    } catch {
      ctx.addIssue({ code: "custom", path: ["ai", "host"], message: "must be a URL like http://127.0.0.1:11434" });
    }
    const keys = new Set<string>();
    const addresses = new Set<string>();
    c.directory.forEach((r, i) => {
      if (keys.has(r.key)) ctx.addIssue({ code: "custom", path: ["directory", i, "key"], message: `duplicate directory key "${r.key}"` });
      keys.add(r.key);
      const a = r.address.toLowerCase();
      if (addresses.has(a)) ctx.addIssue({ code: "custom", path: ["directory", i, "address"], message: `duplicate address "${r.address}"` });
      addresses.add(a);
    });
  });

export type AppConfig = z.output<typeof configSchema>;
export type DirectoryEntry = AppConfig["directory"][number];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function configPath(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.T_CYBER_CONFIG ?? "./config/t-cyber.config.json");
}

export function loadConfigFromFile(file: string): AppConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`Configuration file not found at ${file}. Copy config/t-cyber.config.json or set T_CYBER_CONFIG.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Configuration file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Configuration file ${file} is invalid:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

/** A file version is identified by modification time and size, so a read that caught the file mid-write
 * (truncated, then written) is never mistaken for the finished version. */
let cache: { file: string; mtimeMs: number; size: number; config: AppConfig } | null = null;
/** The newest file version that failed validation, while an earlier valid version stays in use. */
let problem: { file: string; mtimeMs: number; size: number; message: string } | null = null;

/**
 * Current configuration; re-read when the file changes (no restart needed). If an edit makes the file invalid,
 * the last valid configuration stays in use and the problem is reported (Settings shows it) until the file is
 * fixed. With no earlier valid version there is nothing safe to fall back to, so the error is thrown.
 */
export function getAppConfig(): AppConfig {
  const file = configPath();
  const stat = fs.statSync(/*turbopackIgnore: true*/ file, { throwIfNoEntry: false });
  const mtimeMs = stat?.mtimeMs ?? -1;
  const size = stat?.size ?? -1;
  const same = (v: { file: string; mtimeMs: number; size: number } | null) => !!v && v.file === file && v.mtimeMs === mtimeMs && v.size === size;
  if (same(cache)) return cache!.config;
  if (cache && cache.file === file && same(problem)) return cache.config;
  try {
    const config = loadConfigFromFile(file);
    cache = { file, mtimeMs, size, config };
    problem = null;
    return config;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    problem = { file, mtimeMs, size, message: err.message };
    if (cache && cache.file === file) {
      console.error(`[t-cyber] ${err.message}\nThe last valid configuration stays in use until the file is fixed.`);
      return cache.config;
    }
    throw err;
  }
}

/** Whether the configuration file on disk is the one in use, and why not if it is not. */
export function getConfigStatus(): { file: string; ok: boolean; error: string | null; lastValidChangeAt: string | null } {
  getAppConfig();
  const file = configPath();
  const current = problem && problem.file === file ? problem : null;
  return { file, ok: !current, error: current?.message ?? null, lastValidChangeAt: cache && cache.file === file && cache.mtimeMs > 0 ? new Date(cache.mtimeMs).toISOString() : null };
}

export function configVersion(): { file: string; mtimeMs: number; size: number } {
  getAppConfig();
  return { file: cache!.file, mtimeMs: cache!.mtimeMs, size: cache!.size };
}

/** Where approved requests go: the PS IO's mailbox (v1, defaulting to the station mailbox) or the nodal officer. */
export function deliverySettings(): { mode: "gmail" | "via-io" | "direct"; ioMailbox: string; ioName: string; transport: "simulated" | "smtp" } {
  const c = getAppConfig();
  // Gmail mode only while the Gmail link is switched on; otherwise the IO route.
  return { mode: c.delivery.mode === "gmail" && !c.gmail.enabled ? "via-io" : c.delivery.mode, ioMailbox: c.delivery.ioMailbox ?? c.mailbox.fromAddress, ioName: c.delivery.ioName, transport: c.delivery.transport };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
