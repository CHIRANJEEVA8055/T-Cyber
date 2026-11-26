import net from "node:net";
import tls from "node:tls";

/**
 * A small SMTP client (RFC 5321): implicit TLS (port 465) or STARTTLS (587), AUTH PLAIN or LOGIN, one message to one
 * or more recipients. Only used when the configuration's delivery transport is "smtp"; the server and login come from
 * the environment (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS) and are never logged or shown.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  /** "tls": encrypted from the start (465); "starttls": upgraded after connecting (587); "none": loopback only. */
  secure: "tls" | "starttls" | "none";
  user?: string;
  pass?: string;
  timeoutMs?: number;
}

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

/** SMTP settings from the environment, or why they are not usable. */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true; settings: SmtpSettings } | { ok: false; error: string } {
  const host = env.SMTP_HOST?.trim();
  if (!host) return { ok: false, error: "The delivery transport is \"smtp\" but SMTP_HOST is not set in the environment (.env)." };
  const secure = (env.SMTP_SECURE?.trim().toLowerCase() || "starttls") as SmtpSettings["secure"];
  if (!["tls", "starttls", "none"].includes(secure)) return { ok: false, error: "SMTP_SECURE must be tls, starttls or none." };
  if (secure === "none" && !LOOPBACK.includes(host)) return { ok: false, error: "SMTP_SECURE=none is allowed only for a mail relay on this server (127.0.0.1); use tls or starttls." };
  const port = Number(env.SMTP_PORT || (secure === "tls" ? 465 : secure === "starttls" ? 587 : 25));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "SMTP_PORT must be a port number." };
  return { ok: true, settings: { host, port, secure, user: env.SMTP_USER?.trim() || undefined, pass: env.SMTP_PASS || undefined } };
}

class Conversation {
  private buf = "";
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private failed: Error | null = null;
  constructor(public socket: net.Socket) {
    this.attach(socket);
  }
  attach(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\r\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
    socket.on("error", (e) => (this.failed = e));
  }
  private line(timeoutMs: number): Promise<string> {
    if (this.failed) return Promise.reject(this.failed);
    const ready = this.lines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The mail server did not answer in time.")), timeoutMs);
      this.waiters.push((l) => (clearTimeout(t), resolve(l)));
      this.socket.once("close", () => (clearTimeout(t), reject(this.failed ?? new Error("The mail server closed the connection."))));
    });
  }
  /** One reply, which may span several lines ("250-…" then "250 …"). */
  async reply(timeoutMs: number): Promise<{ code: number; text: string[] }> {
    const text: string[] = [];
    for (;;) {
      const l = await this.line(timeoutMs);
      text.push(l.slice(4));
      if (l[3] !== "-") return { code: Number(l.slice(0, 3)), text };
    }
  }
  async send(cmd: string, expect: number[], timeoutMs: number, shown = cmd.split(" ")[0]): Promise<{ code: number; text: string[] }> {
    this.socket.write(`${cmd}\r\n`);
    const r = await this.reply(timeoutMs);
    if (!expect.includes(r.code)) throw new Error(`The mail server refused ${shown}: ${r.code} ${r.text.join(" ")}`.slice(0, 300));
    return r;
  }
}

/** Sends one message. The data is the whole RFC 5322 text with CRLF line ends. */
export async function smtpSend(s: SmtpSettings, envelope: { from: string; to: string[] }, data: string): Promise<{ response: string }> {
  const timeoutMs = s.timeoutMs ?? 30000;
  const socket: net.Socket = await new Promise((resolve, reject) => {
    const sock = s.secure === "tls" ? tls.connect({ host: s.host, port: s.port, servername: s.host }) : net.connect({ host: s.host, port: s.port });
    const t = setTimeout(() => (sock.destroy(), reject(new Error("Could not reach the mail server in time."))), timeoutMs);
    sock.once(s.secure === "tls" ? "secureConnect" : "connect", () => (clearTimeout(t), resolve(sock)));
    sock.once("error", (e) => (clearTimeout(t), reject(e)));
  });
  const c = new Conversation(socket);
  try {
    const hello = await c.reply(timeoutMs);
    if (hello.code !== 220) throw new Error(`The mail server did not greet: ${hello.code}`);
    let ehlo = await c.send("EHLO t-cyber.local", [250], timeoutMs);
    if (s.secure === "starttls") {
      if (!ehlo.text.some((t) => /^STARTTLS\b/i.test(t))) throw new Error("The mail server does not offer STARTTLS; nothing was sent.");
      await c.send("STARTTLS", [220], timeoutMs);
      const upgraded: net.Socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: c.socket, servername: s.host }, () => resolve(t));
        t.once("error", reject);
      });
      c.attach(upgraded);
      ehlo = await c.send("EHLO t-cyber.local", [250], timeoutMs);
    }
    if (s.user) {
      const auth = ehlo.text.find((t) => /^AUTH\b/i.test(t)) ?? "";
      if (/\bPLAIN\b/i.test(auth)) await c.send(`AUTH PLAIN ${Buffer.from(`\0${s.user}\0${s.pass ?? ""}`).toString("base64")}`, [235], timeoutMs, "the login");
      else {
        await c.send("AUTH LOGIN", [334], timeoutMs, "the login");
        await c.send(Buffer.from(s.user).toString("base64"), [334], timeoutMs, "the login");
        await c.send(Buffer.from(s.pass ?? "").toString("base64"), [235], timeoutMs, "the login");
      }
    }
    await c.send(`MAIL FROM:<${envelope.from}>`, [250], timeoutMs);
    for (const to of envelope.to) await c.send(`RCPT TO:<${to}>`, [250, 251], timeoutMs);
    await c.send("DATA", [354], timeoutMs);
    // Lines starting with "." are doubled so the message cannot end early.
    const body = data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const done = await c.send(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.`, [250], timeoutMs, "the message");
    await c.send("QUIT", [221], timeoutMs).catch(() => undefined);
    return { response: done.text.join(" ") };
  } finally {
    c.socket.destroy();
  }
}
