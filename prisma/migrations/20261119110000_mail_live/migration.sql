-- The mail window's working copy of a request while an officer types (versions stay append-only).
ALTER TABLE "Request" ADD COLUMN "liveJson" TEXT;
ALTER TABLE "Request" ADD COLUMN "liveAt" DATETIME;
ALTER TABLE "Request" ADD COLUMN "liveById" TEXT;
