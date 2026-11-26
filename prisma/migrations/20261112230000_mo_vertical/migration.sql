-- Investigation vertical (MO.docx) chosen by an officer; when null the vertical is read from the facts.
ALTER TABLE "Case" ADD COLUMN "moVertical" TEXT;
ALTER TABLE "Case" ADD COLUMN "moSubtype" TEXT;
