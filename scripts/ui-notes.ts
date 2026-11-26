import fs from "node:fs";
import path from "node:path";

/**
 * The UI notes left in comment mode (data/ui-notes/notes.json), for the developer working through them:
 *   npx tsx scripts/ui-notes.ts                 list the open notes, with their block and picture
 *   npx tsx scripts/ui-notes.ts all             list every note
 *   npx tsx scripts/ui-notes.ts done <n> "…"   mark note n done, with what was changed (shown under the note)
 *   npx tsx scripts/ui-notes.ts reply <n> "…"  answer note n and leave it open
 */
const dir = path.resolve(process.cwd(), "data", "ui-notes");
const file = path.join(dir, "notes.json");
type Note = { id: string; n: number; createdAt: string; updatedAt: string; by: { displayName: string }; path: string; url: string; comment: string; status: string; reply: string | null; target: { selector: string; tag: string; text: string; heading: string | null; dialog: string | null; rect: { w: number; h: number }; viewport: { w: number; h: number }; theme: string; html: string }; shot: { file: string | null; kind: string | null; note: string | null } };
const notes: Note[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Note[]) : [];
const [cmd = "list", num, ...rest] = process.argv.slice(2);

if (cmd === "done" || cmd === "reply") {
  const n = notes.find((x) => x.n === Number(num));
  if (!n) throw new Error(`No note ${num}.`);
  if (cmd === "done") n.status = "done";
  n.reply = rest.join(" ").trim() || n.reply;
  n.updatedAt = new Date().toISOString();
  const tmp = `${file}.cli.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log(`Note ${n.n}: ${n.status}${n.reply ? ` · ${n.reply}` : ""}`);
} else {
  const shown = notes.filter((n) => (cmd === "all" ? n.status !== "dismissed" : n.status === "open")).sort((a, b) => a.n - b.n);
  if (!shown.length) console.log(cmd === "all" ? "No notes." : "No open notes.");
  for (const n of shown) {
    console.log(`\n#${n.n} [${n.status}] ${n.path} · ${n.by.displayName} · ${n.createdAt.slice(0, 16)}`);
    console.log(`  Asked: ${n.comment}`);
    console.log(`  Block: ${n.target.tag} “${n.target.text.slice(0, 100)}”${n.target.heading ? ` under “${n.target.heading}”` : ""}${n.target.dialog ? ` in the window “${n.target.dialog}”` : ""}`);
    console.log(`  Size ${n.target.rect.w}×${n.target.rect.h} on a ${n.target.viewport.w}×${n.target.viewport.h} screen, ${n.target.theme} theme`);
    console.log(`  Selector: ${n.target.selector}`);
    console.log(`  Picture: ${n.shot.file ? path.join(dir, n.shot.file) : (n.shot.note ?? "none")}`);
    if (n.reply) console.log(`  Reply: ${n.reply}`);
  }
}
