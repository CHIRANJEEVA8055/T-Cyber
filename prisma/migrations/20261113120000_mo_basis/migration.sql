-- How a case's investigation vertical was decided, and why. Verticals set before this were set by an officer.
ALTER TABLE "Case" ADD COLUMN "moBasis" TEXT;
ALTER TABLE "Case" ADD COLUMN "moReason" TEXT;
UPDATE "Case" SET "moBasis" = 'OFFICER' WHERE "moVertical" IS NOT NULL;
