"use server";

import { getDb } from "@/server/db";
import { markNotificationsRead } from "@/server/services/station-feed";
import { openCaseManually } from "@/server/services/fir-open";
import { runAction } from "@/features/shared/run-action";

export async function markNotificationsReadAction(keys: string[]) {
  return runAction(async (user) => markNotificationsRead(getDb(), user, keys.slice(0, 200)));
}

export async function openCaseManuallyAction(input: Parameters<typeof openCaseManually>[2]) {
  return runAction(async (user) => openCaseManually(getDb(), user, input), { refresh: false });
}

/**
 * The NCRP / 1930 complaint behind an acknowledgement number, to start an FIR from it. Details are given only
 * while it waits for an FIR (the station's intake register); once registered, only that fact is returned.
 */
export async function complaintForFirAction(ack: string) {
  return runAction(
    async () => {
      const c = await getDb().complaint.findUnique({ where: { ackNumber: ack.trim() } });
      if (!c) return null;
      if (c.status !== "AWAITING_FIR") return { ack: c.ackNumber, status: c.status, details: null };
      return {
        ack: c.ackNumber,
        status: c.status,
        details: { channel: c.channel, receivedAt: c.receivedAt.toISOString(), category: c.categoryLabel, complainant: c.complainantName, lossMinor: c.lossAmountMinor.toString(), heldMinor: c.heldAmountMinor.toString(), note: c.note },
      };
    },
    { refresh: false },
  );
}
