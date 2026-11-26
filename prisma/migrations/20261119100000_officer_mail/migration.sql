-- A mail an officer wrote from "New mail" rather than one the rules proposed.
ALTER TABLE "Request" ADD COLUMN "writtenByOfficer" BOOLEAN NOT NULL DEFAULT false;
