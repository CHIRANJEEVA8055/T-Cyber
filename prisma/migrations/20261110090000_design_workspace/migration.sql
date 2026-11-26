
-- AlterTable
ALTER TABLE "Case" ADD COLUMN "chargeSheetedAt" DATETIME;
ALTER TABLE "Case" ADD COLUMN "complaintChannel" TEXT;
ALTER TABLE "Case" ADD COLUMN "complaintReceivedAt" DATETIME;
ALTER TABLE "Case" ADD COLUMN "moSummary" TEXT;

-- AlterTable
ALTER TABLE "Hold" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "Hold" ADD COLUMN "extensionNote" TEXT;

-- AlterTable
ALTER TABLE "Request" ADD COLUMN "caseSeq" INTEGER;

-- AlterTable
ALTER TABLE "Response" ADD COLUMN "firCount" INTEGER;
ALTER TABLE "Response" ADD COLUMN "matchScore" INTEGER;

-- CreateTable
CREATE TABLE "ContactLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "victimEntityId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "followUp" TEXT,
    "nextDueAt" DATETIME,
    "at" DATETIME NOT NULL,
    "byUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactLog_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AllocationDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "sharesJson" TEXT NOT NULL DEFAULT '[]',
    "decidedById" TEXT NOT NULL,
    "decidedAt" DATETIME NOT NULL,
    CONSTRAINT "AllocationDecision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "caseId" TEXT,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatThread_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "answerJson" TEXT,
    "attachmentJson" TEXT,
    "feedback" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NotificationRead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "readAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ContactLog_caseId_at_idx" ON "ContactLog"("caseId", "at");

-- CreateIndex
CREATE INDEX "AllocationDecision_caseId_decidedAt_idx" ON "AllocationDecision"("caseId", "decidedAt");

-- CreateIndex
CREATE INDEX "ChatThread_userId_kind_updatedAt_idx" ON "ChatThread"("userId", "kind", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRead_userId_key_key" ON "NotificationRead"("userId", "key");

