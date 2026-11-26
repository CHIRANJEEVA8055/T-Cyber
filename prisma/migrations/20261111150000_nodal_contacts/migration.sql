-- CreateTable
CREATE TABLE "NodalContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "officerName" TEXT,
    "emailsJson" TEXT NOT NULL DEFAULT '[]',
    "phonesJson" TEXT NOT NULL DEFAULT '[]',
    "address" TEXT,
    "listedAt" DATETIME,
    "source" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "NodalContact_recordId_key" ON "NodalContact"("recordId");

-- CreateIndex
CREATE INDEX "NodalContact_providerKey_idx" ON "NodalContact"("providerKey");

-- CreateIndex
CREATE INDEX "NodalContact_serviceType_idx" ON "NodalContact"("serviceType");

