# Redesign to the "Cyber Investigation Workspace" design (Nov 2026)

Source of truth: the user's Design canvas https://claude.ai/artifact/7etb7985ZPN3QDPXY3MKiN (12 artboards,
`project/*.dc.html`, 1440 wide, dark default with a full light theme). Local copies and renders live in the
session scratchpad (`design/project/*.dc.html`, `design/out/*.outline.txt|*.logic.js|*.css`, `design/shots/`).
Render any artboard locally: serve `design/project` (support.js = the canvas's `artifact-type/dc-runtime.js`)
with `python3 -m http.server 8765 --bind 127.0.0.1`, then `node design/render.mjs <out> 1440 <Name>[:light]`.

User decisions (2026-11-10):
- Replace the whole frontend with the design, exactly; add features where the design is a prototype
  ("not in this prototype" notes become working features). Every control must work.
- Re-seed the demo to the design's worked example: PS Madhapur (Cyberabad), SI Krishna, FIR 412/2026 (two
  victims, ₹1,00,000 lost, ₹80,000 held in B and C, ₹20,000 cash withdrawn), the station's other cases,
  NCRP complaints awaiting FIR, closed cases and six months of history for the trends. Keep "synthetic" labels.
- AI: rules wherever rules can do it; otherwise a local model through Ollama. Model: `gemma4:26b` (already in
  the system Ollama store). The system service `ollama` must be started by the user (`sudo systemctl enable
  --now ollama`). Configure host/model/enable in `config/t-cyber.config.json`; the app must say plainly when the
  model is unavailable and fall back to rules.

## Screens (design artboard → route)

| Artboard | Route | Notes |
| --- | --- | --- |
| Dashboard (station home) | `/` (and `/cases`) | appbar tabs Dashboard / Procedure assistant; KPIs; case tabs (mine, station, need action, awaiting FIR, closed, trends); search + filter popover; replies inbox, notifications (read state), trends drill-down modals; New FIR floating window; Telugu labels toggle |
| ProcedureAssistant | `/assistant` (station tab) and from the case nav "Department" | chats list (new, search, rename, export, archive, delete), scope, approved sources + document viewer, attachments (file, mail reply, FIR case), copy/feedback/retry |
| Main (case overview) | `/cases/[id]` | case window (shelltop + win + winbar + nav) |
| NextActions | `/cases/[id]/next-actions` | |
| People | `/cases/[id]/people` | people & identifiers |
| Recovery | `/cases/[id]/recovery` | transactions & recovery (ledger) |
| Requests | `/cases/[id]/requests` | requests & responses |
| Intake | `/cases/[id]/intake` | FIR intake & evidence (check details) |
| Graph | `/cases/[id]/graph` | graph & timeline |
| CaseAssistant | `/cases/[id]/assistant` | |
| Audit | `/cases/[id]/activity` | activity & audit |
| Reports | `/cases/[id]/reports` | reports & handover |

Not in the design but kept (restyled in the same system): Settings (directory, routes, templates, integrations,
knowledge, demo reset), search, sign-in. Reached from the profile menu.

## Phases

0. Foundations: design tokens + component classes (dark/light via CSS variables, not the canvas's
   `[style*=…]` hacks), the design's inline SVG icons, theme persistence (cookie, SSR-safe), history buttons.
1. Seed rewrite to the worked example + station history generator; config station = PS Madhapur.
2. Station shell + dashboard (all tabs, modals, filters, i18n labels).
3. New FIR window (upload → rules extraction + rules brief + first steps; OCR/translation via Ollama when the
   copy has no text layer) → intake check → open the case; manual entry; register from NCRP.
4. Case window shell + overview. 5–14: the other case screens in canvas order.
15. Settings and the rest restyled. 16. E2E rewrite, verification, UX audit, docs.

Each screen: study render + outline + logic → map to services (add what is missing, test-first) → build →
render both at 1440 (dark and light) and compare → tests.

## Progress

### Phase 1: seed and rules (done, 2026-11-10)
- Seed (`src/server/seed/`): `timeline.ts` (demo "today" = IST today, or yesterday before 11:00; `seedDemo(db, { anchor })`
  pins it for tests), `directory.ts` (PS Madhapur; SI Krishna / SI P. Lavanya / SI M. Arjun / Inspector R. Devi; a
  SYSTEM user "assistant" authors rule-drafted requests so the IO may approve them), `knowledge.ts` (the design's six
  sources, labelled illustrative), `documents.ts` (FIR 412/2026 copy, chat export, Bank A statement, CDR/CAF, …),
  `scenario.ts` (FIR 412/2026 through the real services: R-01…R-08, reminder under R-01, holds B ₹50,000 / C ₹30,000,
  ATM cash ₹20,000, Bank C 4-FIR reply awaiting match, UNICROSS reply + NPCI ack unread in the station inbox),
  `station.ts` (405, 398, 391, 377, 370, 362, 355; closed 341, 326), `history.ts` (30 light open + 12 closed FIRs,
  complaint register for 6 months of trends, 4 NCRP complaints awaiting FIR).
- New models: Complaint (NCRP/1930 register), InboxMessage (station mailbox), CaseHandover, Entity.nickname /
  belongsTo / officerEntry, Case.closureRequested*, Request.preservedUntil, KnowledgeDocument.reviewNote.
- New services: people.ts (officer entries, notes), contacts.ts (victim contact log, CALL_IN), inbox.ts (deliver,
  list for case with match scores, read in), layers.ts (recompute trail layers), domain/reply-match.ts (scores).
- New rules (tested): date discrepancy flag, unknown-counterparty match, slash hold refs, cash withdrawal + ATM
  sighting, preservation receipts (expiry, login IP), multi-FIR hold tables + restriction, lien expiry, rows before
  the trail / bank charges summarised, allocation-basis decision (ALLOC:basis), CCTV blocked on ATM ID (BLOCKED),
  KYC-only request for fully held accounts (LOW, not auto-drafted), reminders carry no own number (R-01 · reminder).
- Verified: tsc 0, eslint 0, vitest 300/300 (after updating seed-dependent tests). Dev DB reseeded (anchor 2026-11-10).

### Phase 2: station shell and dashboard (done, 2026-11-10)
- `src/app/(station)/` (layout + `/`, `/cases` → `/`, settings and search moved here), `src/features/station/`
  (station-shell, dashboard, charts, labels EN/TE, actions), `src/components/design/` (modal on Radix, history
  back/forward, colour tokens = CSS variables so inline colours repaint in the light theme).
- Services: `dashboard.ts` (rows, standings, actions, KPIs, trends + drill-downs), `station-feed.ts` (replies
  inbox, notifications + read state), `domain/standing.ts` (pill + actions per case, tested).
- Officers see the station register with other officers' complainants hidden and cases not openable; actions only
  for their own cases; a supervisor additionally gets approvals sent to them and proposed splits to confirm.
- Narrow (375px): compact app bar, 2 KPI columns, tables scroll inside their card; no page overflow.

### Phase 3: New FIR window (done, 2026-11-10)
- `fir-brief.ts` (kind, brief, details, first steps by rules), `fir-reading.ts` (streamed steps; local model only
  for scans and Telugu/Hindi, honest message when it is not running), `fir-open.ts` (open from copy / by hand),
  `ai/local-model.ts` (Ollama, loopback only, config `ai`), routes `/api/fir/read|open|sample`.
- `/cases/new` redirects to `/?newFir=1`; "Register FIR" opens the window with the complaint attached.

### Phase 4: case window and overview (done, 2026-11-10)
- Routes moved from `(app)/cases/[caseId]` to `(case)/cases/[caseId]`; the old screens render inside the new case
  window until each is rebuilt. `src/features/case/nav.ts` maps each section to its route and design scope class.
- `case-window.tsx`: station strip, title bar ("Opened from …" from this tab's history), side panel with back /
  forward / collapse (cookie `tc_nav`), Sections menu on phones (Escape and the scrim close it).
- `case-home.ts`: `getCaseWindow`, `getCaseHome` (facts, money bar, identity card, Do next, What changed since you
  last looked from applied replies, Waiting on incl. replies already in the mailbox, Open questions, Case file),
  `markOverviewSeen`. Every sentence composed by rules from stored records.
- Case file download (`/api/cases/[id]/case-file`, `case-file.ts`, `documents/zip.ts`): originals and derived
  text with recorded and recomputed SHA-256, ledger, transactions, requests, audit log; the export is audited.
- Temporary redirects so nothing 404s: `/cases/[id]/intake` → evidence, `/assistant` → `/guidance`.

### Phase 5: next actions (done, 2026-11-10)
- `next-actions.ts`: ranked actions (drafts others wait on, drafts, blocked, decisions, reminders, leads, requests,
  deferred last); per-viewer send mode (approve and send / send / ask for approval / waiting / view); requests sent
  today or depended on stay as "Sent · awaiting reply"; decisions taken today stay as "Decided"; chain of what has to
  happen first for blocked actions; CCTV retention note; leads set aside (from the audit trail for reopened ones).
- `requests.ts`: `rescopeDraft` (narrow an assistant draft; the version stays the assistant's), `approveAndSend`
  (request approval, approve, simulated submit; portal requests wait for the portal reference).
- `allocation-decision.ts` + `domain/allocation.ts`: split preview (proportional in whole rupees, first in first out
  traced through the trail, court), `recordSplitDecision` (reason required, proposes allocations for the supervisor).
- Drafts attach the case's FIR copy; the letter says "Signed FIR copy attached." only when one is attached.
- Seed: the officer defers three rule-raised actions with reasons; overview marker at D-3 18:05.
- Verified: tsc 0, eslint 0 on changed files, vitest 351/351; browser smoke of every dialog (send, scope, defer
  form, split decision, blocked chain, focus return, filters), 1440 and 375, dark and light, no page overflow.

### Phase 6: people and identifiers (done, 2026-11-10)
- `people-view.ts`: parties (FIR-named holder vs bank KYC holder kept apart), identifiers with source, requests,
  matches in the station's other cases (FIR number only; openable only with access), status from holds /
  preservation / pending requests; what the records say; sightings vs declared addresses; still to establish.
- `/cases/[id]/people` with details dialog (officer's nickname and "belongs to", logged; record values read-only),
  add dialog (person / phone / account or UPI / online, kind inferred from how it is written).
- Old `/investigation*` routes redirect (`?task=` opens that action in Next actions); generated report and
  assistant links now point at `/actions?task=` and `/people`.
- Verified: vitest 356/356, eslint 0, browser smoke (filters, detail, edit, add, validation), 1440/375, no overflow.

### Phase 7: transactions and recovery (done, 2026-11-11)
- `recovery-view.ts`: measures (lost / held / cash / returned), also-tracked line, every movement with the record
  it comes from (statement row, FIR, hold note), disputed dates named, per-account sentences (asked for vs drafted),
  per-victim bars (returned solid, set aside striped), call log, split proposals with supervisor confirmation.
- `/cases/[id]/recovery`: refund preview (largest allocation; nothing recorded), help dialog, CSV export
  (`/api/cases/[id]/ledger`, audited), log a call, record / change the split, links to the detailed holds,
  allocations and refunds, and transaction pages (old screens, still working inside the case window).
- Verified: vitest 361/361, eslint 0, tsc 0; browser smoke as officer and supervisor (decision, preview, confirm,
  call log, export), 1440 light/dark and 375.

### Phase 8: requests and responses (done, 2026-11-11)
- `requests-view.ts`: replies waiting for a check first (match %, "Needs a match" for multi-FIR replies), then every
  request with its workflow status and what is missing; tabs Needs you / Waiting / Answered.
- `/cases/[id]/requests`: two-step "Import a reply" from the station inbox (`?inbox=1` opens it; overview's button
  goes here), routing help, links to the existing request and reply-review pages; file import kept as a link.
- Telecom reply rules (`readTelecom` in responses.ts): CDR summary (item received), numbers in touch on nearly every
  day (flags ones already in the case, e.g. ···41), calls to the victim's own number, cell used then (cell ID only,
  no place inferred), handset IMEI; CAF subscriber → new SUBSCRIBER_RECORD finding (person, registered-to, CAF
  address; conflicting name flagged). Relationship findings carry their own case role.
- Verified: vitest 363/363, eslint 0, tsc 0; browser smoke of import → review → apply path and the match page.

### Phase 9: intake and evidence (done, 2026-11-11)
- `intake-view.ts`: the case's own documents (FIR first; translation or transcription shown when the reader used
  one), each detail marked at its exact character span (account / person-or-phone / online / amount / uncertain),
  "What was found" grouped People / Money / Contact / Online with Confirm / Set aside, "Not in the FIR", date
  conflicts flagged against the FIR text.
- `/cases/[id]/intake` (the New FIR window lands here): steps Upload → Read → Check → Open the case; "Add something
  that was missed" (manual candidate, audited); "Confirm and open the case" confirms clean details and applies all
  confirmed ones (payments from an unstated account use the "(not stated)" payer, as the manual path does).
- Verified: vitest 365/365, eslint 0, tsc 0; browser smoke New FIR → intake → confirm → add → open, no overflow.

### Phase 10: graph and timeline (done, 2026-11-11)
- `/cases/[id]/graph` framed in the design header; the existing graph keeps its four views (money flow, identity,
  discovery, timeline), review marker, only-new filter, focus and zoom.
- Fixes: `.chrome-blur` was hard-coded white with a glass blur (now the theme's opaque panel colour); the design's
  `:where(.scr-graph) .grid` gridline rule collided with Tailwind's `grid` utility and broke the timeline (renamed
  to `.dgrid` in design.css).
- Old screens still in their previous style but working inside the case window: Case assistant, Activity,
  Reports, Handover, Evidence, detailed holds / allocations / transactions, request and reply pages.

### Phase 11: assistants, rules first then the local model (logic done, 2026-11-11)
- `ai/grounded.ts`: a question the rules cannot place goes to the loopback Ollama model (`gemma4:26b`), given only
  the numbered facts the rules establish for that case (or the approved library's current passages for the
  procedure assistant); the model must cite [F#] / [S#]; uncited answers are flagged as unsupported; the answer is
  labelled "Local model · <model>" with a disclosure that nothing left the computer. When the model is not
  running, the rules' answer stands with the reason. Questions the rules answer never reach the model.
- Audit records which one answered. Tests use an injected generator (Ollama is not running on this server).
- Still to do: the design's chat layout for the case assistant and the station procedure assistant screen.

### Phase 11b/14: chat screens, settings, docs (done, 2026-11-11)
- `chats.ts`: saved conversations per officer (case threads behind case access): ask, name from the first question,
  rename, archive / restore, delete (audited; questions stay in the audit log), rate, export as text
  (`/api/chats/[id]/export`). Procedure scopes: all sources, SOPs and circulars, evidence law, provider policies.
- `/assistant` (station shell) and `/cases/[id]/assistant`: shared chat screen (chat list with search and a menu,
  sources panel, cited passages, case answers with record links, provider label and disclosure on every answer,
  named confirmation before delete).
- Old `/guidance`, `/work-queue`, `/correspondence` redirect to their new homes; Settings › Integrations shows the
  local model's status; README and PROJECT_STATUS updated (SSO and hardening not implemented).

### Next
- Rewrite the Playwright E2E specs for the new screens (the old specs target the previous interface and have not
  been rerun), then full verification incl. a production build.
- Restyle Activity & audit, Reports & handover, Evidence detail, request and reply pages to the design; closure
  request and handover services; Settings, Search and sign-in restyle; UX audit at 375 / 1280, dark and light.
