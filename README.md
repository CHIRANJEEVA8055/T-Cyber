# T-CYBER

A working demonstration of a cybercrime investigation workspace for a police station. A station dashboard (cases,
what needs action, NCRP complaints awaiting an FIR, trends) opens each case in a case window: overview, ranked next
actions, people and identifiers, transactions and recovery, requests and responses, intake and evidence, graph and
timeline, a case assistant, activity and audit, and reports and handover. A procedure assistant answers from the
station's approved sources.

**Everything in this build is synthetic and runs locally.** No email, bank, telecom, NPCI or provider request is ever
sent: each external channel is a labelled simulation adapter. Rules do everything they can; a local language model
(Ollama on this server, loopback only) is used only to read scanned FIR pages, translate Telugu or Hindi copies and
answer assistant questions the rules cannot place, and every such use is labelled. No paid service, API key or remote
model is needed. Production sign-in (SSO) and deployment hardening are **not** implemented. Do not put real case
data into this build.

## Requirements

- Node.js 24 or later (developed and tested with 24.22.2 on Linux).
- About 1 GB of disk space for dependencies and the Playwright browser.
- No API keys, paid services or network access are needed after `npm install`.

## Set up and run

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # database path, evidence storage path, telemetry off
npm run setup               # generate client, create data/t-cyber.db, load the demonstration data
npm run dev                 # http://localhost:3000
```

For a production build, run `npm run build` and then `npm start`. Both also use port 3000.

### Keep it running (background service)

On the demo server the app runs as a systemd user service instead of in a terminal. It starts at boot without a login, keeps running when SSH, VS Code or Claude sessions close, restarts within seconds if the process exits or is killed, and a health check restarts it if it stops answering for three minutes. It stops only when you stop it.

```bash
scripts/service.sh install        # once: install and start (also updates an existing install)
scripts/service.sh status         # state and the addresses to open
scripts/service.sh logs           # follow the log
scripts/service.sh restart        # e.g. after installing packages
scripts/service.sh clean-restart  # restart with an empty dev-server cache if pages look stale
scripts/service.sh stop           # stop it; it stays stopped until `start` or the next boot
```

While the service runs, do not start `npm run dev` or kill the server with `pkill`: use the commands above. The service runs the dev server, so code changes show up without a rebuild.

### Demo sign-in

Every account uses the password `tcyber-demo`.

| Username | Who | Can open |
| --- | --- | --- |
| `officer1` | SI Krishna, investigating officer | His cases, including FIR 412/2026 (the worked example) |
| `officer2` | SI P. Lavanya, investigating officer | Her cases |
| `officer3` | SI M. Arjun, investigating officer | His cases, including FIR 377/2026 |
| `supervisor` | Inspector R. Devi, station supervisor | Every case at the station, approvals, allocations and settings changes |
| `developer` | Developer | The developer console only: knowledge base, ready questions, audit log, and the procedure assistant. No case or station record |

Officers see the station's case register, with other officers' complainants hidden and those cases not openable.
Permissions are checked on the server for every read, change, upload, search, export, graph and assistant
question. An officer who opens a case they are not assigned to gets "not found".

### Local model (optional)

The app runs without it. To let it read scans, translate Telugu or Hindi FIR copies and answer assistant questions
the rules cannot place, start Ollama on this server and pull the configured model:

```bash
sudo systemctl enable --now ollama
ollama pull gemma4:26b
```

The model and host are set in the `ai` section of the configuration file. Only a loopback host is accepted unless
`allowNonLocalHost` is set on purpose. Settings › Integrations shows whether the model is ready. When it is not
running, every screen says so and falls back to rules or to the officer.

### Reset the demonstration data

- In the app: Settings › Demonstration data (supervisor only). Type `RESET` to confirm. Everyone is signed out.
- From the command line: `npm run db:reset` asks you to type `RESET`. Use `npx tsx scripts/reset-db.ts --yes` in
  scripts.

The data is built around today's date. FIR 412/2026 (PS Madhapur) is an investment-app fraud with two victims:
₹1,00,000 lost, ₹80,000 held in Accounts B and C, ₹20,000 taken out as cash at an ATM. It has drafts ready to approve,
a reply waiting for a match, a UNICROSS reply (CDR and CAF) unread in the station inbox and a decision to make on
splitting the held money. The station also has other open and closed FIRs, four NCRP complaints awaiting an FIR and
six months of complaint history for the trends.

## Configuration file

Station details, the outgoing mailbox, request numbering and the recipient directory live in one file:
[`config/t-cyber.config.json`](config/t-cyber.config.json). To use a different file, set `T_CYBER_CONFIG` to its path.

| Section | What it controls |
| --- | --- |
| `station` | Code, name, district, address, phone and email shown in the header, letters, reports and PDFs |
| `mailbox` | From address, display name and signature used in request letters |
| `requests` | Reference prefix (for example `REQ`) and the default follow-up interval |
| `directory` | Recipients (banks, the UNICROSS desk, the NPCI route, provider portals) with channel, address, IFSC prefix and the request types each receives |

- **Changes apply without a restart.** The app re-reads the file on the next page load, and Settings › Overview
  shows when it was last applied.
- **An invalid file doesn't break the app.** The last valid configuration stays in use and Settings shows the error
  until the file is fixed.
- **A changed recipient address must be re-verified.** That recipient becomes "not verified", and requests to it
  can't be submitted until a supervisor verifies the new address.
- **Use `example.invalid` addresses for demonstrations.**
- **Demonstration entries serve only demonstration cases.** Entries are synthetic unless marked `"synthetic": false`.
  Mark a real provider's confirmed address that way and real cases can be routed to it.

Routes, letter templates and the simulated-failure switches are edited by a supervisor in Settings and stored in the
database.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest: 235 unit and integration tests in 25 files; each file uses its own copy of the database |
| `npx playwright install chromium` | One-time browser download for the end-to-end tests |
| `npm run test:e2e` | Playwright: 18 end-to-end tests. Builds the app, starts it on port 3100 with its own database and storage, and resets that database first |
| `PW_DEV=1 npx playwright test` | The same tests against an already running `npm run dev` on port 3000. This resets the dev database |
| `node scripts/visual-audit.mjs --out <dir> --user supervisor --paths /cases,/work-queue --viewports 375x812,1280x800` | Screenshots, a horizontal-overflow check and a console-error check for the listed pages |

The end-to-end tests cover these behaviours (from the brief):
- persistence across reloads;
- invalid forms;
- authorisation boundaries;
- partial responses staying open;
- duplicate response imports;
- approval withdrawn after an edit;
- simulated submission failure and retry;
- an image that can't be read;
- source links opening at the cited line;
- keyboard dialogs;
- no sideways scrolling on a 390 px phone;
- unsaved-change protection;
- no request leaving the application.

Holds, refunds and onward-transfer arithmetic are covered by the unit and integration tests.

## What is implemented, simulated and not done

### Implemented

- **Station dashboard:** my cases and the station's, what needs action today, NCRP complaints awaiting an FIR, closed
  cases, month-on-month figures and trends with drill-down; replies inbox; notifications; English and Telugu labels;
  dark and light themes.
- **New FIR:** read an FIR copy (rules on the text layer; the local model for scans and Telugu or Hindi), a brief with
  page citations, the details found and the first steps; or enter it by hand. The CCTNS FIR form is read item by
  item (sections, occurrence, complainant, each accused entry, property, the complaint text, officers), with each
  number, website, handle, account and amount given the role the FIR's own words give it. PDFs saved from a browser
  whose text layer drops digits ("436/2026" for 1436) are repaired from the glyph shapes in the file. The case opens on Intake, where each
  detail is checked against the document before it is applied.
- **Case window:** overview (facts, money, identity, what changed since you last looked, what the case waits on, open
  questions, case file download as a ZIP with recorded and recomputed hashes).
- **Next actions:** ranked by what unblocks the most; drafts prepared by the assistant identity so the officer can
  approve and send them through the simulated adapters; narrow what a draft asks for; defer with a reason; decisions
  on splitting held money (proportional, first in first out traced through the trail, or the court).
- **People and identifiers:** what the records say about each person and number, kept apart from the officer's own
  entries; matches in the station's other cases; sightings; what is still to establish.
- **Transactions and recovery:** a ledger in paise from bank records only; per-account and per-victim positions; a
  refund preview that records nothing; the victim call log; CSV export.
- **Requests and responses:** versioned drafts, approval bound to an exact version, simulated submission, follow-ups
  and reminders; replies read in from the station inbox and matched to their request; bank statement, hold, KYC,
  preservation, CDR and CAF replies read by rules into findings the officer accepts before anything changes.
- **Graph and timeline, Activity and audit, Reports and handover:** as before, inside the case window.
- **Assistants:** saved conversations (rename, search, export as Word or text, archive, delete, retry); rules first,
  the local model second, with sources for every point. The procedure assistant can also take a file you upload, a
  station mail or a whole FIR case you can open, and prepares request drafts for approval (never sends).
- **Developer console** (`developer`): the knowledge base (upload, check sections, publish, new versions that
  supersede, retire, restore, bulk import), ready questions, and an audit log. See
  [`docs/KNOWLEDGE_BASE.md`](docs/KNOWLEDGE_BASE.md).
- **Nodal officers:** the CrimeOS nodal officer list, searchable under Settings and shown beside a draft's To address;
  a supervisor adds an address to the recipient directory, unverified until checked.
- **Requests for real FIRs** (cases opened from a real FIR copy, not the demonstration):
  - **What is asked:** what the FIR gives becomes next actions.
    - Accounts named as receiving the money are frozen, and their statement and KYC asked for.
    - The complainant's own account is asked for the beneficiary of each debit; without one, the complainant's
      statement is asked for.
    - Indian numbers go to UNICROSS for CDR and CAF; WhatsApp numbers (including foreign ones) go to WhatsApp.
    - Fraudsters' email and platform accounts are preserved; each fraud website's registrar is asked for the registrant.
    - The complainant's own email, number and accounts are never the subject of a request.
  - **Who it goes to:** the address comes from the nodal officer list, never the demonstration directory. The bank is
    found from the IFSC, or from the bank the FIR names beside the account; the provider from the email domain or the
    platform. An action whose bank, mail provider, platform or registrar is not known yet waits and says what to
    record (People & identifiers › Edit details); once recorded, the request is drafted.
  - **Verification:** a draft to an address that is not verified yet says so and cannot be sent. A supervisor
    verifies the address from the draft itself and then approves and sends (simulated).
  - **Refreshing existing cases:** `npm run actions:refresh` works out the next actions of open real cases again with
    the current rules, re-addresses drafts that went to demonstration entries, or marks them for review with what is
    missing.
- **Replies:** a reply is read by rules from its text and its attachments (CSV and Excel statements, Word and PDF
  letters).
  - **Statements:** a bank's statement layout (title rows, its own column names, Dr/Cr columns, month-name dates) is
    understood. Debits on the complainant's own statement become their payments when they match the FIR or the
    period of the offence; any other debit is left for the officer to decide.
  - **Free-text replies:** what the rules cannot place (a platform's, registrar's or mail provider's answer) is read
    by the local model. Every fact must quote the reply and is checked against it; facts that fail the check are
    dropped, and the rest are proposed for the officer to accept, never applied by themselves.
  - **What follows:** accepted results update the case and draft the requests they call for.
- **Search and Settings:** search covers only the cases you can open; directory, routes, templates, integrations
  (including the local model's status), knowledge library and a confirmed demonstration reset.

### Simulated (labelled as such in the app)

- Email to bank nodal mailboxes, the UNICROSS desk route and the NPCI route; submissions return a synthetic receipt.
  A supervisor can make the next submission fail once to rehearse a retry.
- Provider law-enforcement portals: the officer submits on the portal and records the reference by hand.
- The station inbox: replies arrive as synthetic messages; a reply that came another way can be imported from a file.
- The demonstration cases, recipient directory, people, accounts and documents are synthetic. The knowledge base is
  the station's own (imported from data/Knowledge Base); the illustrative demonstration library is retired.

### Not done

- Production sign-in (SSO), deployment hardening, a strict Content Security Policy, rate limiting and backups.
  The demo uses local accounts with hashed passwords and server-side sessions.
- Scans, including scanned attachment pages inside an FIR PDF, are read only when the local model is running.
- PDF bank statements are not read as tables by the rules: the local model proposes the payments it finds in them,
  each checked against the text, for the officer to accept. Excel and CSV statements are read in full.
- The registrar of a website and the mail host of a company domain are not looked up automatically (no WHOIS or DNS
  queries leave this server); the officer records them.
- LibreChat as the assistant engine (agents, MCP tools, vector search) is designed but not yet installed; the assistant
  runs on the app's own rules and the local model.
- Testing with real assistive technology, and on platforms other than Linux and Chromium.

Development notes and the detailed status are in [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).
