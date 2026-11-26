/** Called once when the T-CYBER server starts: the Gmail draft sync (it idles unless the link is on) and the case upkeep. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VITEST) {
    const { startGmailRunner } = await import("./server/gmail/runner");
    startGmailRunner();
    // Next actions that come due with time alone (a follow-up date passing), and the reminders they call for.
    const { startUpkeepRunner } = await import("./server/upkeep-runner");
    startUpkeepRunner();
  }
}
