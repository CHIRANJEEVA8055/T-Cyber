"use client";

import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FormField, Input } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";
import { useServerAction } from "@/features/shared/use-action";
import { resetDemoAction } from "@/features/settings/actions";

/**
 * Explicit, typed confirmation. The reset signs everyone out, so the page then loads the sign-in page in full:
 * that also discards any cached pages of the deleted cases, and Back cannot return to them.
 */
export function DemoReset() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reset = useServerAction(resetDemoAction);
  const close = () => {
    setTyped("");
    reset.reset();
    setOpen(false);
  };
  return (
    <>
      <Button variant="danger" icon={<RotateCcw aria-hidden="true" />} onClick={() => setOpen(true)}>
        Reset demonstration data
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : !reset.pending && close())}>
        {open ? (
          <DialogContent
            title="Reset all demonstration data?"
            description="Every case, document, request, response, report and activity entry is deleted and the synthetic demonstration is loaded again."
            initialFocusRef={cancelRef}
            footer={
              <>
                <Button ref={cancelRef} variant="secondary" onClick={close} disabled={reset.pending}>
                  Cancel
                </Button>
                <Button variant="danger" loading={reset.pending} onClick={() => reset.run([typed], { onSuccess: () => window.location.replace(new URL("/login?reset=1", window.location.origin)) })}>
                  Reset demonstration data
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <InlineAlert tone="warning" title="This cannot be undone">
                Uploaded files are removed too. Everyone is signed out, including you; sign in again afterwards with the demonstration accounts.
              </InlineAlert>
              {reset.error && !reset.fieldErrors.confirmation ? <InlineAlert tone="danger">{reset.error}</InlineAlert> : null}
              <FormField label="Type RESET to confirm" required error={reset.fieldErrors.confirmation} validate={(v) => (v === "RESET" ? null : "Type RESET in capital letters to confirm.")}>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="max-w-[12rem] font-mono" />
              </FormField>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
