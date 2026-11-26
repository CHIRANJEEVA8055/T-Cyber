-- Gmail: the conversation a sent request started, so replies in it are linked to the request.
ALTER TABLE "Request" ADD COLUMN "gmailThreadId" TEXT;

-- Station inbox: messages read from the linked Gmail account, and the request a reply probably answers.
ALTER TABLE "InboxMessage" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'STATION';
ALTER TABLE "InboxMessage" ADD COLUMN "gmailMessageId" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "gmailThreadId" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "suggestedRequestId" TEXT;
ALTER TABLE "InboxMessage" ADD COLUMN "suggestionNote" TEXT;
CREATE UNIQUE INDEX "InboxMessage_gmailMessageId_key" ON "InboxMessage"("gmailMessageId");

-- Each Gmail inbox message looked at once; one not about any case is kept by its id only.
CREATE TABLE "GmailSeen" (
    "messageId" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "responseId" TEXT,
    "inboxMessageId" TEXT,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GmailSeen_seenAt_idx" ON "GmailSeen"("seenAt");
