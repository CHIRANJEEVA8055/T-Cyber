-- AlterTable
ALTER TABLE "Case" ADD COLUMN "closureRequestNote" TEXT;
ALTER TABLE "Case" ADD COLUMN "closureRequestedAt" DATETIME;
ALTER TABLE "Case" ADD COLUMN "closureRequestedById" TEXT;

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ackNumber" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "category" TEXT NOT NULL,
    "categoryLabel" TEXT NOT NULL,
    "complainantName" TEXT,
    "lossAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "heldAmountMinor" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'AWAITING_FIR',
    "caseId" TEXT,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Complaint_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InboxMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "bodyText" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "attachmentsJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'UNREAD',
    "caseId" TEXT,
    "responseId" TEXT,
    "importedById" TEXT,
    "importedAt" DATETIME,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InboxMessage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaseHandover" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "reportId" TEXT,
    "reportVersionNo" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "preparedAt" DATETIME NOT NULL,
    "decidedAt" DATETIME,
    "decidedById" TEXT,
    CONSTRAINT "CaseHandover_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable (column order differs from schema.prisma; SQLite does not care, and no table is rebuilt)
ALTER TABLE "Entity" ADD COLUMN "nickname" TEXT;
ALTER TABLE "Entity" ADD COLUMN "belongsTo" TEXT;
ALTER TABLE "Entity" ADD COLUMN "officerEntry" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_ackNumber_key" ON "Complaint"("ackNumber");

-- CreateIndex
CREATE INDEX "Complaint_status_receivedAt_idx" ON "Complaint"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "Complaint_receivedAt_idx" ON "Complaint"("receivedAt");

-- CreateIndex
CREATE INDEX "InboxMessage_status_receivedAt_idx" ON "InboxMessage"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "CaseHandover_caseId_preparedAt_idx" ON "CaseHandover"("caseId", "preparedAt");

