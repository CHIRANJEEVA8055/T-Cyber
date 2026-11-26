/**
 * Connect the Gmail account named in config/t-cyber.config.json ("gmail"):
 *   npm run gmail:connect                 prints the Google sign-in link
 *   npm run gmail:connect -- "<address>"  finishes, with the address the browser showed after signing in
 * The same can be done in T-CYBER: Settings → Integrations → Gmail.
 */
import { finishGmailConnect, startGmailConnect } from "../src/server/gmail/connect";
import { gmailStatus } from "../src/server/gmail/oauth";

const pasted = process.argv[2];
try {
  if (!pasted) {
    const { url } = startGmailConnect();
    console.log("1. Open this link in a browser and sign in to the Gmail account; choose Allow:\n");
    console.log(url);
    console.log('\n2. The browser then goes to an address starting "http://localhost/?..." and says the page cannot be reached. That is expected.');
    console.log('3. Copy that whole address and run:  npm run gmail:connect -- "<the address>"');
  } else {
    const { account } = await finishGmailConnect(pasted);
    console.log(`Connected: ${account}. ${gmailStatus().note}`);
    console.log("T-CYBER now keeps its drafts in this account's Drafts (within the configured sync interval).");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
