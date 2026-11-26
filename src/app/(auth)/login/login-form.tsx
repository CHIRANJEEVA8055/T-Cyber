"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/features/auth/actions";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/feedback";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="mt-5 flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      {state.error ? <InlineAlert tone="danger">{state.error}</InlineAlert> : null}
      <FormField label="Username" error={state.fieldErrors?.username} required>
        <Input name="username" autoComplete="username" defaultValue={state.username ?? ""} autoCapitalize="none" spellCheck={false} required />
      </FormField>
      <FormField label="Password" error={state.fieldErrors?.password} required>
        <Input name="password" type="password" autoComplete="current-password" required />
      </FormField>
      <Button type="submit" variant="primary" loading={pending} className="mt-1 w-full">
        Sign in
      </Button>
    </form>
  );
}
