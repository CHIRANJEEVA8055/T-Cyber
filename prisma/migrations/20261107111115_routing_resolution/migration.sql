-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RoutingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "resolveBy" TEXT NOT NULL DEFAULT 'FIXED',
    "recipientId" TEXT,
    "templateId" TEXT,
    "approvalRole" TEXT NOT NULL,
    "followUpDays" INTEGER NOT NULL,
    "procedureNote" TEXT NOT NULL,
    "matchJson" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RoutingRule_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RoutingRule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RoutingRule" ("active", "approvalRole", "category", "followUpDays", "id", "matchJson", "name", "procedureNote", "recipientId", "subjectKind", "templateId", "updatedAt") SELECT "active", "approvalRole", "category", "followUpDays", "id", "matchJson", "name", "procedureNote", "recipientId", "subjectKind", "templateId", "updatedAt" FROM "RoutingRule";
DROP TABLE "RoutingRule";
ALTER TABLE "new_RoutingRule" RENAME TO "RoutingRule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
