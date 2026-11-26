import { describe, expect, it } from "vitest";
import { readXlsx } from "@/server/documents/xlsx";
import { parseDocument } from "@/server/documents/parse";
import { buildZip } from "@/server/documents/zip";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A workbook whose cells carry styles: style 1 is a date format (14), style 2 a custom date-and-time format. */
function book(cells: string): Buffer {
  const files: Record<string, string> = {
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/styles.xml": `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm:ss"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    "xl/sharedStrings.xml": `<sst><si><t>Txn Date</t></si><si><t>Amount</t></si><si><t>Dr/Cr</t></si><si><t>DR</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${cells}</sheetData></worksheet>`,
  };
  return buildZip(Object.entries(files).map(([name, t]) => ({ name, data: Buffer.from(t), modified: new Date() })));
}

describe("reading an Excel statement", () => {
  const cells =
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
    // 46328 is 02 Nov 2026; .5848 of a day is 14:02:07; 250000 is a plain number in the general format.
    `<row r="2"><c r="A2" s="2"><v>46328.584803240741</v></c><c r="B2"><v>250000</v></c><c r="C2" t="s"><v>3</v></c></row>` +
    `<row r="3"><c r="A3" s="1"><v>46329</v></c><c r="B3" s="0"><v>1250.5</v></c><c r="C3" t="s"><v>3</v></c></row>`;

  it("shows date cells as the dates they display, and leaves plain numbers alone", () => {
    const [sheet] = readXlsx(book(cells));
    expect(sheet!.rows[1]).toEqual(["02-11-2026 14:02:07", "250000", "DR"]);
    expect(sheet!.rows[2]).toEqual(["03-11-2026", "1250.5", "DR"]);
  });

  it("is parsed as a table the reply reader can use", async () => {
    const parsed = await parseDocument(book(cells), XLSX);
    expect(parsed.status).toBe("TABLE_PARSED");
    expect(parsed.table?.[1]?.[0]).toBe("02-11-2026 14:02:07");
  });

  it("says plainly when a workbook cannot be opened", async () => {
    const parsed = await parseDocument(Buffer.from("PK not really a zip"), XLSX);
    expect(parsed.status).toBe("FAILED");
    expect(parsed.note).toMatch(/could not be opened/);
  });
});
