import { describe, expect, it } from "vitest";
import { cleanModelText, mentionsLawProvision, needsApprovedSource, provisionsNotIn, readSmallTalk, smallTalkReply, tidyMarkdown } from "@/domain/conversation";

describe("recognising small talk", () => {
  it.each([
    ["hi", "GREETING"],
    ["Hello!", "GREETING"],
    ["hey there", "GREETING"],
    ["Good morning sir", "GREETING"],
    ["namaste", "GREETING"],
    ["hii", "GREETING"],
    ["how are you?", "WELLBEING"],
    ["Hi, how are you doing", "WELLBEING"],
    ["thanks", "THANKS"],
    ["Thank you so much!", "THANKS"],
    ["ok thanks", "THANKS"],
    ["bye", "BYE"],
    ["good night", "BYE"],
    ["ok", "ACK"],
    ["got it", "ACK"],
    ["who are you", "IDENTITY"],
    ["What is your name?", "IDENTITY"],
    ["what can you do?", "HELP"],
    ["help", "HELP"],
    ["what's today", "DATE"],
    ["What is today's date?", "DATE"],
    ["date today", "DATE"],
    ["what day is it", "DATE"],
    ["Which day is today?", "DATE"],
    ["what time is it", "TIME"],
    ["current time", "TIME"],
    ["what is the date and time now", "TIME"],
    ["hi, what's today?", "DATE"],
  ])("%s → %s", (message, intent) => {
    expect(readSmallTalk(message).intent).toBe(intent);
  });

  it("drops a greeting in front of a real question and leaves the question to be answered", () => {
    expect(readSmallTalk("Hello, how do I get an account unfrozen?")).toEqual({ intent: null, question: "how do I get an account unfrozen?" });
    expect(readSmallTalk("hi there what is phishing")).toEqual({ intent: null, question: "what is phishing" });
    expect(readSmallTalk("Thanks. And for Telegram?")).toEqual({ intent: null, question: "And for Telegram?" });
  });

  it.each(["How do I freeze an account?", "what is the time limit to answer a section 94 notice", "today's hearing schedule", "help me draft a CDR request", "who is the nodal officer for Airtel"])(
    "leaves a real question alone: %s",
    (message) => {
      expect(readSmallTalk(message)).toEqual({ intent: null, question: message });
    },
  );
});

describe("replying to small talk", () => {
  const ctx = { officer: "Krishna", station: "PS Madhapur", sources: 58, canUseCases: true, modelReady: true };

  it("gives today's date and time in IST from the clock it is handed", () => {
    const at = new Date("2026-11-12T10:12:00Z"); // 15:42 IST
    expect(smallTalkReply("DATE", { ...ctx, at })).toBe("Today is Thursday, 12 November 2026.");
    expect(smallTalkReply("TIME", { ...ctx, at })).toBe("It is 3:42 pm IST on Thursday, 12 November 2026.");
    expect(smallTalkReply("DATE", { ...ctx, at: new Date("2026-11-12T19:00:00Z") })).toBe("Today is Friday, 13 November 2026.");
  });

  it("greets by the time of day in IST and says what can be attached", () => {
    const morning = smallTalkReply("GREETING", { ...ctx, at: new Date("2026-11-12T03:00:00Z") });
    expect(morning).toMatch(/^Good morning, Krishna\./);
    expect(morning).toMatch(/FIR case/);
    expect(smallTalkReply("GREETING", { ...ctx, at: new Date("2026-11-12T13:00:00Z"), canUseCases: false })).not.toMatch(/FIR case/);
    expect(smallTalkReply("GREETING", { ...ctx, at: new Date("2026-11-12T13:00:00Z") })).toMatch(/^Good evening/);
  });

  it("says what it can do, and that general questions need the local model", () => {
    const at = new Date("2026-11-12T10:12:00Z");
    expect(smallTalkReply("HELP", { ...ctx, at })).toMatch(/58 approved sources/);
    expect(smallTalkReply("HELP", { ...ctx, at })).toMatch(/not from the approved sources/);
    expect(smallTalkReply("HELP", { ...ctx, at, modelReady: false })).toMatch(/not running/);
    expect(smallTalkReply("IDENTITY", { ...ctx, at })).toMatch(/cannot send mail/);
  });
});

describe("keeping law and procedure to the approved sources", () => {
  it.each(["What is the punishment for cheating?", "Which section of the BNSS covers this?", "deadline to reply to a notice", "how do I freeze a mule account", "What does the SOP say about refunds?"])("needs a source: %s", (q) => {
    expect(needsApprovedSource(q)).toBe(true);
  });
  it.each(["tell me a joke", "what is the capital of Telangana", "explain what a VPN is", "what's the weather like"])("general: %s", (q) => {
    expect(needsApprovedSource(q)).toBe(false);
  });
  it("spots a legal provision in a general answer", () => {
    expect(mentionsLawProvision("Identity theft is punishable under Section 66C of the IT Act.")).toBe(true);
    expect(mentionsLawProvision("It falls under 318 BNS.")).toBe(true);
    expect(mentionsLawProvision("A VPN encrypts your traffic.")).toBe(false);
  });
  it("turns model markdown into plain text", () => {
    expect(cleanModelText("**Phishing** is:\n* a fake mail\n- a fake site\n\n## Note\nBe careful.")).toBe("Phishing is:\n• a fake mail\n• a fake site\n\nNote\nBe careful.");
  });
});

describe("legal provisions an answer names that its sources do not contain", () => {
  const source = "Register under Section 318(4) BNS and Section 66-D of the IT Act. Notice under Section 94 BNSS.";
  it("finds none when every provision is in the sources", () => {
    expect(provisionsNotIn("Register under **Section 318(4) BNS** and 66-D of the IT Act; issue a notice under BNSS 94 [S1].", source)).toEqual([]);
  });
  it("lists the ones the sources do not have", () => {
    expect(provisionsNotIn("Cheating is punishable under Section 316 BNS; identity theft under 66C of the IT Act.", source)).toEqual(["Section 316", "66C"]);
  });
  it("splits combined citations and replaces LaTeX arrows", () => {
    expect(tidyMarkdown("Wizard: A $\\rightarrow$ B \\rightarrow C [S5, S7] and [S1;S2]")).toBe("Wizard: A → B → C [S5][S7] and [S1][S2]");
  });
  it("keeps markdown an answer is written in", () => {
    expect(tidyMarkdown("```markdown\n### Steps\n1. **Register** the FIR\n\n\n\n2. Freeze\n```")).toBe("### Steps\n1. **Register** the FIR\n\n2. Freeze");
  });
});
