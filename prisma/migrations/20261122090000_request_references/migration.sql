-- References that name their case (REQ-412/2026-002). The reference a request had before is kept so that replies
-- quoting it are still matched.
ALTER TABLE "Request" ADD COLUMN "legacyReference" TEXT;
CREATE UNIQUE INDEX "Request_legacyReference_key" ON "Request"("legacyReference");
