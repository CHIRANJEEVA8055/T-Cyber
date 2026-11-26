-- CreateTable
CREATE TABLE "ChatUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "passagesJson" TEXT NOT NULL DEFAULT '[]',
    "pageCount" INTEGER,
    "readNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KnowledgeDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "docNumber" TEXT NOT NULL,
    "issuingBody" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "supersededById" TEXT,
    "summary" TEXT NOT NULL,
    "reviewNote" TEXT,
    "isSynthetic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL DEFAULT 'SOP',
    "fileName" TEXT,
    "storageKey" TEXT,
    "sha256" TEXT,
    "readNote" TEXT,
    "replacesId" TEXT,
    "createdById" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    "publishedById" TEXT,
    "retiredReason" TEXT
);
INSERT INTO "new_KnowledgeDocument" ("createdAt", "docNumber", "effectiveFrom", "id", "isSynthetic", "issuingBody", "jurisdiction", "reviewNote", "status", "summary", "supersededById", "title", "version") SELECT "createdAt", "docNumber", "effectiveFrom", "id", "isSynthetic", "issuingBody", "jurisdiction", "reviewNote", "status", "summary", "supersededById", "title", "version" FROM "KnowledgeDocument";
DROP TABLE "KnowledgeDocument";
ALTER TABLE "new_KnowledgeDocument" RENAME TO "KnowledgeDocument";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ChatUpload_userId_createdAt_idx" ON "ChatUpload"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PromptTemplate_active_sortOrder_idx" ON "PromptTemplate"("active", "sortOrder");


-- Existing documents: the "Answer from" category follows the document's kind, and published ones keep their date.
UPDATE "KnowledgeDocument" SET "category" = 'LAW' WHERE "title" LIKE '%Adhiniyam%' OR "title" LIKE '%Sanhita%' OR "docNumber" LIKE '%BSA%';
UPDATE "KnowledgeDocument" SET "category" = 'PROVIDER' WHERE "title" LIKE '%Provider%' OR "title" LIKE '%platform polic%';
UPDATE "KnowledgeDocument" SET "category" = 'CIRCULAR' WHERE "category" = 'SOP' AND ("title" LIKE '%circular%' OR "docNumber" LIKE 'Cir%');
UPDATE "KnowledgeDocument" SET "publishedAt" = "createdAt", "updatedAt" = "createdAt" WHERE "status" IN ('CURRENT', 'SUPERSEDED');
