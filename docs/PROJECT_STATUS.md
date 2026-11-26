# T-CYBER — project status

> **Redesign in progress (November 2026).** The interface is being rebuilt to the station/case-window design.
> What is done, phase by phase, and what is next is kept in [`REDESIGN_PLAN.md`](REDESIGN_PLAN.md) (Progress section).
> Where this file and that one differ, that one is current.


Last updated: 2026-11-08 (visual refresh to the Figma reference designs; app runs as a systemd user service; verification green)

## Resume commands

```bash
cd /home/astra/cyber_GPT
export PATH="$HOME/.local/bin:$PATH"      # Node 24.22.2 in ~/.local/share/node (symlinked into ~/.local/bin)
npm install                               # postinstall runs prisma generate
npx prisma migrate deploy                 # applies prisma/migrations to data/t-cyber.db
npm run db:seed                           # scripted synthetic investigation (~4 s); no-op if data exists
npm run db:reset                          # confirmed wipe + reseed (type RESET); `npx tsx scripts/reset-db.ts --yes` in automation
npm run dev                               # http://localhost:3000
npm test                                  # vitest: 235 tests in 25 files (unit + integration), each file on its own DB copy
npx eslint . && npx tsc --noEmit
PW_DEV=1 npx playwright test              # 18 E2E tests in 7 specs against the running dev server (resets the dev DB first)
npx playwright test                       # same tests against a production build on :3100 with its own DB (migrate + build + start)
node scripts/visual-audit.mjs --out <dir> --user supervisor --paths /cases --viewports 375x812,1280x800   # screenshots + overflow + console errors
```

NOTE (dev server): Turbopack occasionally keeps a stale server copy of a module after a file is rewritten by a script,
which shows up as a hydration mismatch naming code that is already fixed. Stop the server, move `.next/dev` aside,
and start it again.

NOTE: Prisma 7 `migrate dev` refuses non-interactive use and does not regenerate the client. Generate SQL with
`npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`, save it as a new
migration folder, then `npx prisma migrate deploy` and `npx prisma generate`.

## Stack (pinned)

Next 16.4.5, React 19.3.1, TypeScript 5.9.3, Tailwind 4.3.5, radix-ui 1.8.1, lucide-react 1.70, Zod 4.6.7,
Prisma 7.10.1 + @prisma/adapter-better-sqlite3, @xyflow/react 12.12.1, unpdf 2.1.0, Vitest 5.1.0, Playwright 1.65.0
(Chromium 1254 downloaded to ~/.cache/ms-playwright), ESLint 9.39.5 (ESLint 10 blocked by plugin peer ranges).

## Completed

- Schema + 7 migrations; SQLite triggers make AuditEvent append-only, RequestVersion immutable and ReportVersion
  content immutable (review recorded once; deletion only during the confirmed demo reset).
- Domain (`src/domain`, pure, TDD): money, ledger, request workflow, identifiers, IST time (incl. date-only
  observations), permissions, extraction RULES_V1, next-action engine.
- Server (`src/server`): Prisma client, clock seam (seed only), sessions, access guard, audit, storage, document
  parsing, PDF writer, simulation adapters, configuration file (`config/t-cyber.config.json`, Zod-validated, applied
  without restart: station, mailbox, request prefix, recipient directory).
- Services (`src/server/services`), all integration-tested: cases, evidence, extraction, requests, drafting,
  responses, tasks, funds, investigation, correspondence, overview, graph, activity, reports, assistant, settings,
  work queue, search.
- Seed: directory, synthetic documents, scripted investigation through the real services at historical IST times.
  Contract test `tests/integration/seed.test.ts` pins the brief's figures.

## UI done (audited with scripts/visual-audit.mjs; key pages at 1440/1280/1920/768/390)

- Shell, login, cases list, FIR intake (/cases/new), case header + tabs, Overview.
- Requests + global Correspondence (one shared view), request detail (versioned editor, approval, simulated submit),
  response review split pane, manual response import.
- Evidence library, viewer (deep-link highlight), upload drawer, extraction review beside the source.
- Investigation: next actions (assign/defer/dismiss/complete), people, identifiers, location leads.
- Funds: transactions, holds, returns with allocation/refund actions and the ledger strip.
- Graph (`/cases/[id]/graph`):
  - Money flow (columns by transfer depth; repeated transfers combined with exact totals), Identity (identifiers /
    accounts / people), Discovery (columns per step; every card says how it was found), Timeline (event time vs
    time recorded; date-only KYC dates shown as dates).
  - Provenance is exact: `ResponseFinding.appliedRefJson` / `ExtractionCandidate.appliedRefJson` plus matching
    timestamps identify which response or document created each record; officer-recorded steps name the cited
    document.
  - Diagram (React Flow) and List presentations; list is the default below 768 px. Filters by kind, "only new since
    my last review" (per-officer ReviewMarker), branch focus (`?focus=`), details drawer for records and connections
    (sources with excerpts, requests, open next actions), Enter/Escape keyboard flow.
  - Routing (`src/features/graph/routing.ts`, unit-tested): shared trunks for fan-out/fan-in only when no other record
    sits beside them; lanes between card rows for connections that skip a column; otherwise a plain curve.
  - Opens at >= 90% zoom (left-aligned when wider than the view, with a hint); Fit to screen shows everything.
- Activity & reports (`/cases/[id]/activity`, sub-nav Activity / Reports / Handover):
  - Activity: append-only history, newest first, filters (kind of change, officers vs automatic, text), cursor paging,
    links to each record. Corrections are new entries (`correctsId`) shown against the original, which never changes.
  - Reports: case summary, case diary draft and handover note drafted deterministically from the records (figures
    from the same ledger as Overview/Funds; every statement carries a numbered source link; no legal citations).
    Officer edits save new versions (optimistic concurrency); review binds to one exact version; redraft keeps history;
    browser print (app chrome hidden) and authorised PDF export (`/api/reports/[id]/pdf?version=N`, audited as
    `report.exported`).
  - Handover: live unresolved leads, pending requests (follow-up due/overdue, sources changed), responses waiting
    for review, ledger statement, unverified identifiers; "Create handover note" snapshots it as a report.
- Assistants (provider adapter `src/server/ai/provider.ts`; only the local, deterministic "Demo assistant" exists and
  nothing leaves the application; every answer carries that disclosure):
  - Case AI (`/cases/[id]/assistant`): context assembled through the access-checked services for one case plus the
    guidance library. Answers what changed (changes only, not access or report housekeeping), what is missing, what is
    supported, money (from the ledger; unknown is not ₹0), a named account/person/request, and what to review next.
    Established / possible / not yet known are kept apart; every established item cites a record or document line;
    holder-on-record facts carry the caution that holding an account does not show who used it; suggestions only
    navigate. Unsupported questions get an explanation, not a guess. Each question is logged as an access event.
  - AI guidance (`/guidance`): retrieval over the approved library only (no case access). Quotes passages with issuer,
    number, version, effective date and status; current documents that set different rules on the same subject are
    shown side by side without choosing; superseded versions only as history; "not covered" instead of general
    knowledge. Library panel with a sections drawer.
- Work queue (`/work-queue`): open next actions assigned to the officer or to nobody, plus approvals for supervisors;
  exactly the set behind the navigation count (integration-tested), grouped by case, with text and case filters.
- Search (`/search`, also the top bar): only the officer's accessible cases; case details (FIR reference parsing),
  accounts/identifiers/people, document text (marked excerpt, opens at the cited line) and requests.
- Settings (`/settings`, sub-nav): overview (configuration file status, station, mailbox, numbering, change history),
  recipient directory (from the file; supervisors verify/unverify with a note), routes (supervisors edit approval role,
  follow-up days, procedure note; used at approval/submission), templates (edit page; only placeholders drafting can
  fill; versioned; future drafts only), integrations (all simulated; supervisors arm a one-shot submission failure),
  knowledge library, demonstration data (supervisor reset with typed RESET; everyone is signed out and the sign-in
  page explains). Officers see everything read-only with an explanation, not disabled controls.
- E2E: main journey, configuration file, graph, settings (failed simulated submission and retry through the UI,
  officer read-only settings, search scoped to own cases), assistants (case answers, keyboard ask, suggestions navigate,
  guidance conflict / superseded / not covered, library drawer, unassigned officer), activity & reports (correction, draft/edit/review/version/PDF,
  handover, unassigned officer gets not-found for the page and a 404 for the PDF).

## Cross-cutting fixes made during the graph work

- Overlay layering: scrims z-50, drawers/dialogs z-[51], menus z-[55], tooltips z-60, toasts z-70. Radix portals the
  scrim and panel separately; a quick close-and-reopen could put a new scrim above the panel and block every click.
- Focus return: drawers/dialogs opened from state (no Radix Trigger) now return focus to what had it
  (`src/components/ui/return-focus.ts`).
- Manual transfers take the later discovery phase of their two endpoints (a transfer cannot be found before them).
- Applying a login-location finding records the IP identifier and its link in the finding's refs.
- Sign out from the account menu was broken (a form inside a Radix menu item is unmounted before it submits); the
  item now calls the logout action directly and shows "Signing out…". Covered by the activity & reports E2E.
- Shared `evidenceHref`/`citationLabel` (`src/lib/evidence-href.ts`) so citations open at the cited line everywhere.
- InlineAlert stacks its action under the text below 640 px; FilterBar can drop a paging cursor on filter change.
- App chrome (sidebar, top bar, case header, sub-nav) is hidden when printing.
- An invalid configuration file no longer takes the app down: the last valid configuration stays in use and Settings
  shows the error until the file is fixed (`getConfigStatus`).
- Each submission records the address it was sent to (`Submission.recipientAddress`); a sent request shows "Sent to"
  that address and notes when the directory address has changed since.

## UX audit (vectorlab ux-audit, 2026-11-07)

Screenshots at 375 and 1280 for settings, work queue, correspondence, search, guidance, cases and the case pages
(graph, assistant, activity, reports, handover, evidence, funds, requests): no page-level horizontal overflow, no
console errors. Fixes made:

- Motion: only transform/opacity animate (no colour or width transitions); durations 100/150/200 ms; reduced motion
  falls back to 100 ms opacity.
- Validation: `FormField validate` runs on blur and clears on focus (corrections, verification notes, routes,
  templates, report edits, demo reset).
- Tab strips (case sections, sub-nav, correspondence views): the frame stays the page width, items scroll inside it,
  and the current tab is scrolled into view on phones (`use-reveal-current.ts`, `reveal-strip.tsx`).
- Lists: the first cell of a linked row is a link in the action colour (resting affordance); phone cards end in a
  chevron. Header cells are positioned so `sr-only` labels cannot widen the page.
- Every table fits its frame at 1280 with the sidebar open (directory, routes, evidence, correspondence, funds).
  Addresses wrap after "@" or before a dot (`Address`), never mid-word.
- Directory shows organisation + role without repeating the organisation (`recipientRole`); routes show short approval
  labels; route and verification history use the configured recipient name.
- Work queue shows assignment as plain text in the meta line; handover shows a task status only when it is not Open;
  Case AI is left-aligned like the other case pages; library documents open with a framed "Read N sections" button.
- Unverify dialog focuses Cancel first; page titles use "Page – T-CYBER".
- Small buttons look 32px tall but have a 44px hit area (invisible `::before`) and are 44px on touch screens.
- Every shadow colour is at most 0.07 alpha (raised surfaces, dialogs, drawers, mobile nav); no text below 12px (the
  collapsed-sidebar count badge was 11px).

## Visual refresh to the reference designs (2026-11-08)

Reference: the user's Figma file "Figma basics" (30 T-CYBER frames: New FIR upload/review/manual, 01–26 workflow screens, a cases dashboard). Read through the Figma page API in the user's Chrome; the Figma MCP tools need edit access, which the account (View seat) does not have.

- Tokens (`src/app/globals.css`): Inter (`@fontsource/inter` 400/500/600), navy ink #15233b, slate text, #f4f5fc canvas, #e2e6ef hairlines, 7px control and 12px card radii, soft navy-tinted shadows. Changed from the reference only for WCAG AA: primary blue #2866c5 (white on the reference #4887ea is 3.4:1), ink-3 #5f6b80, success #1d7259.
- Shell (`app-shell.tsx`): full-width 64px header with brand and station, search, IST clock, demo-data chip, Print and the officer menu; global sidebar outside cases; demo-data footer on every page. The nav-collapse rail and its `tc_nav` cookie are gone.
- Case workspace (`case-sidebar.tsx`, case `layout.tsx`): on wide screens a case sidebar (All cases, FIR, title, station, victims, status, Case actions, then Overview, Next actions, People, Identifiers & locations, Requests & inbox, Funds & refunds, Evidence, Graph, Timeline, Case AI, Activity & audit, Reports & handover, and AI guidance set apart) plus a breadcrumb and section heading; narrow screens keep the case header with its section strip. `CaseActions` (edit details, close/reopen) is shared by both.
- Underline tabs for sub-navigation and correspondence views; cases home has headline stat cards (open cases, reported loss on open cases, next actions open, responses to review); table cell padding 12px (reference), tabular figures only on numeric columns.
- Not adopted: New FIR as a modal with PDF upload at intake (the intake stays a page form; PDF extraction happens in Evidence), and per-screen layouts beyond the shared patterns.

Verification after the refresh: tsc and eslint clean; vitest 25 files / 235 tests; Playwright 18/18 on the dev server and 18/18 on a production build (no build warnings); tables fit at 1280 (measured), no page-level overflow at 375.

## Verification (2026-11-07, after the UX audit)

`npx tsc --noEmit` exit 0; `npx eslint .` exit 0; `npx vitest run` 235/235 in 25 files; `PW_DEV=1 npx playwright test`
18/18 with no errors in the dev server log; `npx playwright test` (production build) 18/18; `npx next build` exit 0
with no warnings.

## Remaining

Nothing required by the brief is open. Design-rule gap still open: about 200 Tailwind half-step spacings
(`py-3.5`, `py-2.5`, `gap-1.5`, `mt-0.5`, ...) sit off the 4/8 pt grid; a sweep needs a full visual re-check. Possible next steps: OCR and DOCX/XLSX parsing, a real assistant provider
behind the adapter (only with an approved deployment), SSO and deployment hardening, cleanup of orphaned storage files.

## Schema decisions

- Money: BigInt paise; null = unknown. DTOs carry decimal strings.
- Statuses are strings validated in `src/domain`. Entities are case-scoped; PERSON keys are opaque (names never merge).
- RoutingRule.resolveBy picks the recipient dynamically; Recipient.ifscPrefix names banks from IFSC codes.
- Approval binds versionNo + contentHash. Response.fingerprint unique. Findings/candidates carry appliedAt + refs.
- Demo reset deletes under Counter('demo_reset_in_progress') so the append-only triggers stay active otherwise.

## Known limitations (so far)

- No OCR; DOCX/XLSX stored but not parsed. Text extraction is rule-based (RULES_V1), not a model.
- All external channels are simulation adapters; portals are recorded manually. Only the deterministic demo assistant
  exists; no language model provider is implemented. Assistant answers are not stored (only the questions are logged).
- Production SSO, deployment hardening and a strict CSP are not implemented.
- Orphaned files can remain in storage if a DB transaction fails after a file was written.
- Graph diagrams with many layers open partly outside the view (by design, to keep text readable); the list
  presentation and Fit to screen cover the whole case.
