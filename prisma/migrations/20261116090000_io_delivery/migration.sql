-- v1 delivery through the PS investigating officer's mailbox, and the station's outbox of mails sent or kept.
ALTER TABLE "Request" ADD COLUMN "handedOverAt" DATETIME;
ALTER TABLE "Request" ADD COLUMN "handedOverTo" TEXT;

CREATE TABLE "OutboundMail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT,
    "requestId" TEXT,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "attachmentIdsJson" TEXT NOT NULL DEFAULT '[]',
    "transport" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OutboundMail_requestId_idx" ON "OutboundMail"("requestId");
