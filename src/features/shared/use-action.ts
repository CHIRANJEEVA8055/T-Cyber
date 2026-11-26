"use client";

import { useCallback, useState, useTransition } from "react";
import { useToast } from "@/components/ui/feedback";
import type { ActionResult } from "@/server/errors";

/**
 * Calls a server action with pending state, inline field errors and a toast for the outcome.
 * The success message repeats the action's verb ("Draft saved"), matching the button label.
 */
export function useServerAction<Args extends unknown[], T>(action: (...args: Args) => Promise<ActionResult<T>>) {
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const run = useCallback(
    (args: Args, opts: { success?: string | ((data: T) => string); onSuccess?: (data: T) => void; toastError?: boolean } = {}) =>
      new Promise<ActionResult<T>>((resolve) => {
        startTransition(async () => {
          const result = await action(...args);
          if (result.ok) {
            setFieldErrors({});
            setError(null);
            if (opts.success) toast({ tone: "success", message: typeof opts.success === "function" ? opts.success(result.data) : opts.success });
            opts.onSuccess?.(result.data);
          } else {
            setFieldErrors(result.fieldErrors ?? {});
            setError(result.error);
            if (opts.toastError !== false && !result.fieldErrors) toast({ tone: "danger", message: result.error });
          }
          resolve(result);
        });
      }),
    [action, toast],
  );

  const reset = useCallback(() => {
    setFieldErrors({});
    setError(null);
  }, []);

  return { run, pending, fieldErrors, error, reset };
}
