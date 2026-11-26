"use server";

import { AppError } from "@/server/errors";
import { canManageDirectory } from "@/domain/permissions";
import { runAction } from "@/features/shared/run-action";
import { disconnectGmail, finishGmailConnect, startGmailConnect } from "@/server/gmail/connect";
import { startGmailRunner } from "@/server/gmail/runner";
import { recordAudit } from "@/server/audit";
import { getDb } from "@/server/db";

/** Connecting or disconnecting the Gmail account is a supervisor's step; checked here, not by hiding buttons. */
function supervisorOnly(user: Parameters<typeof canManageDirectory>[0]) {
  if (!canManageDirectory(user)) throw new AppError("Only a supervisor can connect or disconnect the Gmail account.", "FORBIDDEN");
}
const plain = (err: unknown) => (err instanceof AppError ? err : new AppError((err as Error).message, "PRECONDITION"));

export async function gmailConnectStartAction() {
  return runAction(async (user) => {
    supervisorOnly(user);
    try {
      return startGmailConnect();
    } catch (err) {
      throw plain(err);
    }
  }, { refresh: false });
}

export async function gmailConnectFinishAction(pasted: string) {
  return runAction(async (user) => {
    supervisorOnly(user);
    if (!pasted.trim()) throw new AppError("Paste the address the browser showed after signing in.", "VALIDATION", { pasted: "Paste the whole address." });
    let account: string;
    try {
      account = (await finishGmailConnect(pasted.slice(0, 4000))).account;
    } catch (err) {
      throw plain(err);
    }
    startGmailRunner();
    await getDb().$transaction((tx) => recordAudit(tx, { caseId: null, actorId: user.id, action: "settings.gmail_connected", objectType: "Integration", objectId: "gmail", summary: `Gmail connected as ${account} by ${user.displayName}` }));
    return { account };
  });
}

export async function gmailDisconnectAction() {
  return runAction(async (user) => {
    supervisorOnly(user);
    disconnectGmail();
    await getDb().$transaction((tx) => recordAudit(tx, { caseId: null, actorId: user.id, action: "settings.gmail_disconnected", objectType: "Integration", objectId: "gmail", summary: `Gmail disconnected by ${user.displayName}; drafts already in Gmail stay there` }));
    return null;
  });
}
