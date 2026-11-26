-- Files an officer adds to a case from the case window, with what was read in them.
CREATE TABLE "FileReading" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READ',
    "resultJson" TEXT NOT NULL,
    "modelJson" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME,
    "appliedById" TEXT,
    "appliedJson" TEXT,
    CONSTRAINT "FileReading_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileReading_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FileReading_caseId_createdAt_idx" ON "FileReading"("caseId", "createdAt");
CREATE INDEX "FileReading_evidenceId_idx" ON "FileReading"("evidenceId");
