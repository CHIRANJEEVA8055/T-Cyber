// Takes the picture for a comment-mode note (src/server/ui-notes.ts): opens the page in a headless browser on this
// server, as the officer who wrote the note, outlines the block and photographs it. Run by the app, not by hand.
// Input comes from the environment; the answer is one line of JSON on stdout. Nothing leaves this server.
import { chromium } from "playwright";

const env = process.env;
const note = JSON.parse(env.UI_NOTE_JSON ?? "{}");
const base = env.UI_NOTE_BASE ?? "http://127.0.0.1:3000";
const out = env.UI_NOTE_OUT;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let browser;
try {
  const t = note.target ?? {};
  const where = (() => {
    try {
      const u = new URL(note.url);
      return `${u.pathname}${u.search}`;
    } catch {
      return note.path ?? "/";
    }
  })();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: t.viewport?.w ?? 1440, height: t.viewport?.h ?? 900 }, deviceScaleFactor: 1 });
  const host = new URL(base).hostname;
  await ctx.addCookies([
    { name: "tcyber_session", value: env.UI_NOTE_TOKEN ?? "", domain: host, path: "/", httpOnly: true, sameSite: "Lax" },
    ...(env.UI_NOTE_THEME ? [{ name: "tc_theme", value: env.UI_NOTE_THEME, domain: host, path: "/", sameSite: "Lax" }] : []),
  ]);
  const page = await ctx.newPage();
  await page.goto(`${base}${where}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(600);

  const find = async () => {
    if (t.selector) {
      const bySelector = page.locator(t.selector);
      if ((await bySelector.count().catch(() => 0)) > 0 && (await bySelector.first().isVisible().catch(() => false))) return { el: bySelector.first(), how: null };
    }
    // A block in a window is not on the page as it loads: no guessing by text (another block could match).
    if (t.dialog) return null;
    const text = (t.text ?? "").trim();
    if (text && text.length <= 200 && t.tag) {
      const exact = new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
      const byText = page.locator(t.tag).filter({ hasText: exact });
      if ((await byText.count().catch(() => 0)) === 1 && (await byText.first().isVisible().catch(() => false))) return { el: byText.first(), how: "Found by its text; the page may have changed since." };
    }
    return null;
  };
  const found = await find();
  if (found) {
    await found.el.scrollIntoViewIfNeeded().catch(() => undefined);
    await found.el.evaluate((el) => {
      el.style.outline = "3px solid #f97316";
      el.style.outlineOffset = "2px";
    });
    const box = await found.el.boundingBox();
    const vp = page.viewportSize();
    const pad = 24;
    const x = Math.max(0, (box?.x ?? 0) - pad);
    const y = Math.max(0, (box?.y ?? 0) - pad);
    const w = Math.min((vp?.width ?? 1440) - x, (box?.width ?? 200) + pad * 2);
    const h = Math.min((vp?.height ?? 900) - y, (box?.height ?? 100) + pad * 2);
    await page.screenshot({ path: out, clip: { x, y, width: Math.max(w, 40), height: Math.max(h, 40) } });
    say({ ok: true, kind: "block", note: found.how });
  } else {
    await page.screenshot({ path: out });
    say({ ok: true, kind: "page", note: t.dialog ? `The block was in the window “${String(t.dialog).slice(0, 80)}”, which is not open when the page loads, so this is the page.` : "The block is not on the page as it loads now, so this is the page." });
  }
} catch (err) {
  say({ ok: false, note: `The picture could not be taken: ${String(err?.message ?? err).slice(0, 160)}` });
} finally {
  await browser?.close().catch(() => undefined);
}
