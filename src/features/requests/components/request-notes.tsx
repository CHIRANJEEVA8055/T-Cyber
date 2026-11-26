"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Textarea } from "@/components/ui/field";
import { useServerAction } from "@/features/shared/use-action";
import { addRequestNoteAction } from "@/features/requests/actions";

/** Internal notes are visible to officers on the case only; they are never part of the request content. */
export function RequestNoteForm({ requestId }: { requestId: string }) {
  const [body, setBody] = useState("");
  const add = useServerAction(addRequestNoteAction);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.run([requestId, body], { success: "Note added", onSuccess: () => setBody("") });
      }}
    >
      <FormField label="Internal note" error={add.fieldErrors.body} hint="Visible to officers on this case. Never sent to the recipient.">
        <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <div>
        <Button type="submit" size="sm" variant="secondary" loading={add.pending}>
          Add note
        </Button>
      </div>
    </form>
  );
}
