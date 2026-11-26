-- Link between a request's draft and a draft in the connected Gmail account.
ALTER TABLE "Request" ADD COLUMN "gmailDraftId" TEXT;
ALTER TABLE "Request" ADD COLUMN "gmailMessageId" TEXT;
ALTER TABLE "Request" ADD COLUMN "gmailSyncedHash" TEXT;
ALTER TABLE "Request" ADD COLUMN "gmailSyncedAt" DATETIME;
ALTER TABLE "Request" ADD COLUMN "gmailTo" TEXT;
ALTER TABLE "Request" ADD COLUMN "gmailError" TEXT;
