-- Report versions are a history: once saved, a version's content never changes. Edits create a new version.
-- The only permitted update is recording an officer's review of that exact version, once.
-- Deletion is limited to the explicit, confirmed demo reset (Counter 'demo_reset_in_progress' = 1).

CREATE TRIGGER "ReportVersion_content_immutable"
BEFORE UPDATE OF "reportId", "versionNo", "body", "sourcesJson", "generated", "changeNote", "createdById", "createdAt" ON "ReportVersion"
BEGIN
  SELECT RAISE(ABORT, 'ReportVersion content is immutable; save a new version instead');
END;

CREATE TRIGGER "ReportVersion_review_once"
BEFORE UPDATE OF "reviewedById", "reviewedAt" ON "ReportVersion"
WHEN OLD."reviewedAt" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'ReportVersion review is already recorded');
END;

CREATE TRIGGER "ReportVersion_no_delete" BEFORE DELETE ON "ReportVersion"
WHEN COALESCE((SELECT "value" FROM "Counter" WHERE "key" = 'demo_reset_in_progress'), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'ReportVersion rows are kept as history');
END;
