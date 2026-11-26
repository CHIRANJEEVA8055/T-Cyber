"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { gmailConnectFinishAction, gmailConnectStartAction, gmailDisconnectAction } from "../gmail-actions";

/** Connect the Gmail account in two steps: open Google's sign-in, then paste the address the browser lands on. */
export function GmailConnect({ connected, canManage, needsRead = false }: { connected: boolean; canManage: boolean; needsRead?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  if (!canManage) return <p className="mt-2 text-label text-ink-3">A supervisor connects or disconnects the Gmail account here.</p>;
  const begin = () =>
    start(async () => {
      setMsg(null);
      const r = await gmailConnectStartAction();
      if (!r.ok) setMsg({ tone: "warn", text: r.error });
      else setLink(r.data.url);
    });
  const finish = () =>
    start(async () => {
      setMsg(null);
      const r = await gmailConnectFinishAction(pasted);
      if (!r.ok) setMsg({ tone: "warn", text: r.error });
      else {
        setMsg({ tone: "ok", text: `Connected as ${r.data.account}. Drafts appear in its Drafts within a few seconds, and replies to requests are looked for with every check.` });
        setLink(null);
        setPasted("");
        router.refresh();
      }
    });
  const off = () =>
    start(async () => {
      const r = await gmailDisconnectAction();
      setConfirmOff(false);
      if (!r.ok) setMsg({ tone: "warn", text: r.error });
      else {
        setMsg({ tone: "ok", text: "Disconnected. Drafts already in Gmail stay there; nothing more is copied or sent." });
        router.refresh();
      }
    });
  return (
    <div className="mt-3 flex flex-col gap-3">
      {!link ? (
        <div className="flex flex-wrap gap-2">
          <button className="btn primary" type="button" onClick={begin} aria-busy={pending}>
            {pending ? "Preparing…" : needsRead ? "Connect again to read replies" : connected ? "Connect again" : "Connect Gmail"}
          </button>
          {connected ? (
            confirmOff ? (
              <>
                <span className="self-center text-label text-ink-2">Stop copying drafts and sending from Gmail?</span>
                <button className="btn" type="button" onClick={() => setConfirmOff(false)}>
                  Keep it
                </button>
                <button className="btn" type="button" onClick={off} aria-busy={pending}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn" type="button" onClick={() => setConfirmOff(true)}>
                Disconnect
              </button>
            )
          ) : null}
        </div>
      ) : (
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-body text-ink-2">
          <li>
            <a className="font-medium text-action hover:underline" href={link} target="_blank" rel="noopener noreferrer">
              Open Google sign-in
            </a>{" "}
            and sign in to the Gmail account. Google asks to let T-CYBER manage drafts and send email, and to read your email (so replies to requests are found): tick both and choose Allow. (While the Google project is in testing, Google first warns that the app is unverified: choose Continue.)
          </li>
          <li>The browser then opens an address starting “http://localhost/?” and says the page cannot be reached. That is expected.</li>
          <li>
            <label htmlFor="gmail-pasted">Copy that whole address from the address bar and paste it here:</label>
            <div className="mt-2 flex flex-wrap gap-2">
              <input id="gmail-pasted" className="input" style={{ flex: "1 1 320px", minHeight: 40 }} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost/?state=…&code=…" autoComplete="off" spellCheck={false} />
              <button className="btn primary" type="button" onClick={finish} disabled={!pasted.trim()} aria-busy={pending}>
                {pending ? "Connecting…" : "Connect"}
              </button>
              <button className="btn" type="button" onClick={() => setLink(null)}>
                Cancel
              </button>
            </div>
          </li>
        </ol>
      )}
      {msg ? (
        <p role="status" className={`text-body ${msg.tone === "ok" ? "text-success" : "text-warning"}`}>
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
