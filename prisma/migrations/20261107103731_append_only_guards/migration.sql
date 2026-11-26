-- Audit events are append-only: corrections are recorded as new events (correctsId).
-- Request versions are immutable: approval applies to an exact stored version.
-- The only permitted deletion path is the explicit, confirmed demo reset, which sets
-- Counter('demo_reset_in_progress') = 1 inside the same transaction.

CREATE TRIGGER "AuditEvent_no_update" BEFORE UPDATE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent rows are append-only');
END;

CREATE TRIGGER "AuditEvent_no_delete" BEFORE DELETE ON "AuditEvent"
WHEN COALESCE((SELECT "value" FROM "Counter" WHERE "key" = 'demo_reset_in_progress'), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent rows are append-only');
END;

CREATE TRIGGER "RequestVersion_no_update" BEFORE UPDATE ON "RequestVersion"
BEGIN
  SELECT RAISE(ABORT, 'RequestVersion rows are immutable; create a new version instead');
END;

CREATE TRIGGER "RequestVersion_no_delete" BEFORE DELETE ON "RequestVersion"
WHEN COALESCE((SELECT "value" FROM "Counter" WHERE "key" = 'demo_reset_in_progress'), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'RequestVersion rows are immutable');
END;
