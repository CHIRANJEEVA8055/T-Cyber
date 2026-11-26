// Visual and layout audit with Playwright (headless Chromium).
// Usage: node scripts/visual-audit.mjs --out data/screenshots --user officer1 --paths /cases,/cases/new [--viewports 1440x900,390x844] [--full]
// For each path and viewport it saves a screenshot and reports page-level horizontal overflow and console errors.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);
const base = process.env.BASE_URL ?? "http://localhost:3000";
const out = path.resolve(args.out ?? "data/screenshots");
const user = args.user ?? "officer1";
const paths = (args.paths ?? "/cases").split(",");
const viewports = (args.viewports ?? "1440x900,1280x800,1920x1080,768x1024,390x844").split(",").map((v) => {
  const [w, h] = v.split("x").map(Number);
  return { width: w, height: h };
});
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: viewports[0], deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(`${page.url()} :: ${msg.text()}`);
});
page.on("pageerror", (err) => consoleErrors.push(`${page.url()} :: pageerror ${err.message}`));

if (user !== "none") {
  await page.goto(`${base}/login`);
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill("tcyber-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}

const report = [];
for (const p of paths) {
  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await page.goto(`${base}${p}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    const name = `${p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}__${vp.width}x${vp.height}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: args.full === "true" });
    report.push({ path: p, viewport: `${vp.width}x${vp.height}`, horizontalOverflow: overflow.scrollWidth > overflow.clientWidth ? `${overflow.scrollWidth}>${overflow.clientWidth}` : "none", file: name });
  }
}
console.table(report);
console.log(consoleErrors.length ? `Console errors (${consoleErrors.length}):\n${consoleErrors.join("\n")}` : "Console errors: none");
await browser.close();
