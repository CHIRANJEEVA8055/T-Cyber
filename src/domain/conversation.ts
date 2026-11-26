/**
 * Conversation the procedure assistant handles by fixed rules, before any document or model is consulted:
 * greetings, thanks, goodbyes, what it is and can do, and today's date and time. Everything here is a plain reply
 * built from the clock and the officer's own details; nothing is looked up and no model is used.
 *
 * It also decides which questions may be answered from general knowledge at all. Law, police procedure and official
 * requirements must come from the approved sources, so a model is only allowed to answer those from quoted passages.
 */

/**
 * How a model must speak of people: an FIR is the complainant's account before any enquiry, so a name it gives is only
 * stated; a bank's or provider's record names a holder or subscriber on record, which is not proof of who used it.
 */
export const NAMES_RULE =
  "Names: a name given in an FIR or complaint for an account, number, email or profile is only what was stated; write it as 'stated to be <name>' or 'named in the FIR as <name>'. A name in a bank's or provider's record is the holder or subscriber on record, not proof of who used it. Never call a named person the accused, the fraudster or the culprit, and never write a name as established.";

export type SmallTalk = "GREETING" | "WELLBEING" | "THANKS" | "BYE" | "ACK" | "IDENTITY" | "HELP" | "DATE" | "TIME";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const ADDRESS = "(?: (?:there|sir|madam|mam|ma'am|team|all|everyone|assistant|bot|buddy|friend|t cyber|tcyber))?";
const GREET = `(?:hi+|hey+|hello+|helo|hai|hiya|yo|namaste|namaskar(?:am)?|vanakkam|salaam|greetings|good (?:morning|afternoon|evening|day))${ADDRESS}`;
const THANK = "(?:(?:ok(?:ay)? |great |cool )?(?:thanks?|thank you|thankyou|thx|ty|tq|dhanyavad|shukriya)(?: (?:a lot|so much|very much|again|sir|madam))*)";

const WHOLE: [SmallTalk, RegExp][] = [
  ["GREETING", new RegExp(`^${GREET}$`)],
  ["WELLBEING", /^(?:how (?:are|r) (?:you|u)(?: doing| today)?|how's it going|how is it going|how do you do|how have you been|what's up|whats up|sup)$/],
  ["THANKS", new RegExp(`^${THANK}$`)],
  ["BYE", /^(?:bye+|goodbye|good bye|bye bye|see you(?: later| tomorrow)?|see ya|good night|gn|take care|that's all|thats all|that is all)$/],
  ["ACK", /^(?:ok(?:ay)?|k|fine|cool|great|nice|noted|alright|all right|got it|understood|i see|perfect|good)$/],
  ["IDENTITY", /^(?:who are you|what are you|what is your name|what's your name|whats your name|your name|introduce yourself|are you (?:a )?(?:bot|robot|human|an ai|ai|machine|real))$/],
  ["HELP", /^(?:help|help me|menu|options|what can you do|what do you do|what can i ask(?: you)?|what should i ask|how can you help(?: me)?|how do i use (?:you|this)|how does this work|what are your features)$/],
  ["TIME", /^(?:(?:what(?:'s| is) )?(?:the )?(?:current )?(?:date and time|time and date)(?: now| today)?|(?:what(?:'s| is) )?(?:the )?(?:current )?time(?: now| please| is it)?|what time is it(?: now)?|tell me the time)$/],
  [
    "DATE",
    /^(?:(?:what(?:'s| is) )?today(?:'s date)?|(?:what(?:'s| is) )?(?:the )?(?:current |today's )?(?:date|day)(?: today| now| please)?|(?:date|day) today|(?:what|which) (?:date|day) is (?:it|today)(?: today)?|tell me (?:the|today's) date)$/,
  ],
];

/**
 * What a message is, if it is small talk. A greeting or thanks in front of a real question is dropped and the rest
 * is returned as the question ("Hello, how do I …" → "how do I …").
 */
export function readSmallTalk(message: string): { intent: SmallTalk | null; question: string } {
  const text = message.trim();
  const n = norm(text);
  for (const [intent, re] of WHOLE) if (re.test(n)) return { intent, question: text };
  // A courtesy in front of something else: "hi, what's today?", "Thanks. And for Telegram?"
  const lead = new RegExp(`^(?:${GREET}|${THANK}|ok(?:ay)?)\\b[\\s,.!:;-]*`, "i").exec(text.toLowerCase().replace(/[‘’`]/g, "'"));
  if (lead && lead[0].trim() && lead[0].length < text.length) {
    const rest = text.slice(lead[0].length).trim();
    const inner = readSmallTalk(rest);
    if (inner.intent) return inner;
    if (norm(rest).length >= 2) return { intent: null, question: rest };
  }
  return { intent: null, question: text };
}

const IST = "Asia/Kolkata";
const part = (at: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-IN", { timeZone: IST, ...o }).format(at);
/** "Thursday, 12 November 2026" in IST. */
export const longDateIST = (at: Date) => `${part(at, { weekday: "long" })}, ${part(at, { day: "numeric" })} ${part(at, { month: "long" })} ${part(at, { year: "numeric" })}`;
/** "3:42 pm" in IST. */
export function clockIST(at: Date): string {
  const h = Number(part(at, { hour: "numeric", hour12: false })) % 24;
  const m = part(at, { minute: "2-digit" }).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}
const hourIST = (at: Date) => Number(part(at, { hour: "numeric", hour12: false })) % 24;

export interface SmallTalkContext {
  at: Date;
  /** How to address the officer ("Krishna"). */
  officer: string;
  station: string;
  /** How many approved documents the assistant answers from. */
  sources: number;
  /** Whether this account can attach FIR cases and station mail (the developer account cannot). */
  canUseCases: boolean;
  /** Whether the local model is running, which general questions need. */
  modelReady: boolean;
}

export function smallTalkReply(intent: SmallTalk, c: SmallTalkContext): string {
  const attach = c.canUseCases ? "You can also attach an FIR case, a station mail or a file and ask about it." : "You can also attach a file and ask about it.";
  const general = c.modelReady
    ? "General questions are answered by the local model on this server, and those answers are marked as not from the approved sources."
    : "General questions need the local model on this server, which is not running right now.";
  switch (intent) {
    case "GREETING": {
      const h = hourIST(c.at);
      const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
      return `${part}, ${c.officer}. Ask me how to handle a step (freezing an account, an NCRP complaint, a request to a bank or a platform) and I will answer from the station's approved sources, quoting the section. ${attach}`;
    }
    case "WELLBEING":
      return "Everything is working on my side, thank you. What can I help you with?";
    case "THANKS":
      return "You're welcome. Ask whenever you need anything else.";
    case "BYE":
      return `Goodbye, ${c.officer}. This conversation is saved under Chats; you can come back to it any time.`;
    case "ACK":
      return "Alright. Ask your next question whenever you're ready.";
    case "IDENTITY":
      return `I am the T-CYBER procedure assistant for ${c.station}. I answer from the station's ${c.sources} approved sources (SOPs, circulars, provider guides) and quote the section I rely on. ${general} I cannot send mail, file anything or change a record.`;
    case "HELP":
      return [
        "Here is what I can do:",
        `• Answer procedure questions from the ${c.sources} approved sources, quoting the section. For example: "How do I get an account unfrozen?"`,
        c.canUseCases ? "• Read an attached FIR case: what is pending, what is missing, and prepare request drafts for your approval (nothing is sent from here)." : null,
        c.canUseCases ? "• Read an attached station mail or a file you upload (PDF, Word, text) and quote the parts that answer your question." : "• Read a file you upload (PDF, Word, text) and quote the parts that answer your question.",
        `• ${general}`,
        "• Save any answer as a Word document, or export the whole conversation.",
      ]
        .filter(Boolean)
        .join("\n");
    case "DATE":
      return `Today is ${longDateIST(c.at)}.`;
    case "TIME":
      return `It is ${clockIST(c.at)} IST on ${longDateIST(c.at)}.`;
  }
}

/**
 * Questions about law, police procedure and official requirements. These may only be answered from the approved
 * sources: a model may word an answer from quoted passages, never from its own memory.
 */
const SOURCE_ONLY =
  /\b(?:sections?|sec|u\/s|acts?|bns|bnss|bsa|ipc|crpc|cr p c|it act|laws?|legal(?:ly)?|statut\w*|rules?|punish\w*|penalt\w*|offen[cs]es?|cognizable|bail\w*|arrest\w*|warrants?|charge ?sheets?|remand|courts?|magistrates?|judges?|procedures?|sops?|circulars?|notices?|deadlines?|time ?limits?|limitation|jurisdiction\w*|seiz\w*|freez\w*|unfreez\w*|frozen|liens?|holds?|refund\w*|restor\w*|nodal|ncrp|cfcfrms|1930|requisitions?|summons|65 ?b|certificates?|cdrs?|cafs?|ipdrs?|subscriber|kyc|preserv\w*|takedowns?|mules?|firs?|lears?|approv\w*)\b/i;

export const needsApprovedSource = (question: string) => SOURCE_ONLY.test(question);

/** A general answer that names a legal provision ("Section 66C of the IT Act", "318 BNS") needs a caution. */
export const mentionsLawProvision = (text: string) => /\b(?:sections?|sec\.?|u\/s|article)\s*\d+|\b\d+[A-Z]?\s*(?:of (?:the )?)?(?:BNS|BNSS|BSA|IPC|CrPC)\b|\b(?:BNS|BNSS|BSA|IPC|CrPC|IT Act|Information Technology Act)\b/i.test(text);

/** The model's answer as plain text: the chat shows paragraphs and lines, not markdown. */
export function cleanModelText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The model's answer as Markdown: without a wrapping code fence, and without runs of blank lines. */
export function tidyMarkdown(text: string): string {
  return text
    .replace(/\r/g, "")
    // Arrows and symbols some models write as LaTeX.
    .replace(/\$?\\(?:rightarrow|to)\$?/g, "→")
    .replace(/\$?\\leftarrow\$?/g, "←")
    .replace(/\$?\\times\$?/g, "×")
    // "[S5, S7]" → "[S5][S7]", so each citation is recognised.
    .replace(/\[((?:[SDMF]\d+\s*[,;]\s*)+[SDMF]\d+)\]/g, (_m, inner: string) => inner.split(/[,;]/).map((x) => `[${x.trim()}]`).join(""))
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n/i, "")
    .replace(/\n```\s*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Legal provisions an answer names ("Section 316 BNS", "66C of the IT Act", "BNSS 94") that the sources it was given
 * do not contain, as written in the answer. Each is a provision the model may have supplied from memory.
 */
export function provisionsNotIn(answer: string, sources: string): string[] {
  const found = new Map<string, string>();
  const take = (num: string, shown: string) => {
    const n = num.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
    if (!found.has(n)) found.set(n, shown.trim());
  };
  for (const m of answer.matchAll(/\b(?:section|sec\.?|u\/s)\s*(\d{1,3}(?:-?[A-Z])?(?:\(\d+\))?)/gi)) take(m[1]!, `Section ${m[1]}`);
  for (const m of answer.matchAll(/\b(\d{1,3}(?:-?[A-Z])?(?:\(\d+\))?)\s*(?:of\s+(?:the\s+)?)?(?:BNS|BNSS|BSA|IPC|CrPC|IT\s*Act)\b/g)) if (!/^section/i.test(answer.slice(Math.max(0, m.index! - 9), m.index!).trim().split(/\s+/).pop() ?? "")) take(m[1]!, m[1]!);
  for (const m of answer.matchAll(/\b(?:BNS|BNSS|BSA|IPC|CrPC)\s+(?:section\s+)?(\d{1,3}(?:-?[A-Z])?(?:\(\d+\))?)/g)) take(m[1]!, m[1]!);
  const src = sources.replace(/(\d)\s*-\s*([A-Z])/gi, "$1$2").toUpperCase();
  const missing: string[] = [];
  for (const [n, shown] of found) {
    const re = new RegExp(`(?<![0-9A-Z])${n.replace(/[()]/g, (c) => `\\${c}`)}(?![0-9])`);
    if (!re.test(src)) missing.push(shown);
  }
  return missing;
}
