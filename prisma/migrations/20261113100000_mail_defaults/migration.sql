-- Each officer's own From address and closing block for new drafts, and the From address of each draft version.
ALTER TABLE "User" ADD COLUMN "mailFrom" TEXT;
ALTER TABLE "User" ADD COLUMN "mailClosingJson" TEXT;
ALTER TABLE "RequestVersion" ADD COLUMN "fromAddress" TEXT;
