# Keeping the knowledge base

The procedure assistant answers only from the documents in the knowledge base. Only the **developer** account can
change it: add, edit, publish, replace and retire documents, and edit the ready questions officers see. Every change is
in the audit log (Developer console › Audit log).

Sign in as `developer` (demo password `tcyber-demo`). The account cannot open any case, dashboard or station record.

## Adding one document (in the app)

1. **Knowledge › Upload a document.**
2. Choose the file: PDF with a text layer, Word (.docx), text (.txt) or Markdown (.md), up to 25 MB.
   A scanned PDF has no text to read. Type it into a .docx or .txt file first, or prepare it as Markdown (see below).
3. Fill in the details: title, number, issued by, version, the date it takes effect, its kind (SOP, circular, law,
   provider guide or other guide), one line on what it covers, and any caution to show with it.
   If it **replaces** a current document, pick that document under "Replaces".
4. **Upload and check the sections.** The file is read on this server and split into sections at its headings and
   clause numbers (1., 2.1, Section 63, Annexure A, Markdown `#` headings, Word heading styles). It is kept as a **draft**:
   the assistant does not answer from it yet.
5. Check the sections against **Download the original**. Edit any section, add or remove one, and fix the details.
6. **Publish.** From now on the assistant answers from it and cites its sections. If you picked "Replaces", the old
   document becomes **superseded**: it stays searchable as history and is labelled whenever it is cited.

## Changing a published document

Open it and choose **Start a new version**. This gives you a draft copy. Edit it, then publish it, and it supersedes
the current one. Published text is never edited in place, so what the assistant quoted earlier can always be traced.

**Retire** takes a document out of answers, with a reason that is recorded. **Restore** brings it back.

## Importing a prepared folder (many documents at once)

The station's knowledge base (data/Knowledge Base) is a folder of Markdown files, one per source document. Each file
starts with YAML front-matter (`title`, `source_file`, `file_type`, `content_type`, `tags`, and where relevant
`issuing_authority`, `document_ids`, `supersedes`), followed by the transcribed text under `#` headings.

```bash
npm run kb:import -- "data/Knowledge Base"                         # add new and changed documents
npm run kb:import -- "data/Knowledge Base" --retire-illustrative   # also retire the demonstration library
npm run kb:import -- "data/Knowledge Base" --templates             # also replace the ready questions with starter ones
```

- A file that has not changed (same SHA-256) is skipped. A changed file is published as a new version that supersedes
  the old one. `00 - INDEX.md` is skipped.
- Sections follow the document's own `#` headings and are numbered §1, §2 … in reading order.
- The kind is set from the source: SOPs and circulars are **SOP**, LEARs and provider-response guides are **Provider**,
  videos and help pages are **Other guide**.
- Transcribed videos and scanned pages get a caution ("check the issued original"), shown with every answer that cites
  them. So does a document whose front-matter says it supersedes earlier instructions.

To add a new document to the folder, write it in the same shape and run the import again. To replace one, edit its file
and run the import again.

## Ready questions

**Developer console › Questions:** add, edit, reorder, hide or delete the question cards officers see on a new chat.
Each card names the source it is answered from.

## The nodal officer list

The CrimeOS nodal officer export (data/nodal_officers.xlsx) is imported with:

```bash
npm run nodal:import -- data/nodal_officers.xlsx
```

Records are matched by their record ID, so importing a newer export updates them. Officers and supervisors can search
the list under **Settings › Nodal officers**. When a request is drafted, the dialog shows that organisation's nodal
addresses from the list beside the **To** address. A supervisor can add an address to the recipient directory, where it
stays **unverified** until they verify it. Email sending in this build is simulated; nothing is sent.

## What survives a demonstration reset

A demonstration reset replaces the cases and the demo users. It **keeps** the knowledge base, its files, the ready
questions, the nodal officer list, and the audit history of those.
