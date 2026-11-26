"use client";

import { createContext, forwardRef, useContext, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

interface FieldCtx {
  id: string;
  hintId: string;
  errorId: string;
  invalid: boolean;
  onEngage: () => void;
  onLeave: (value: string) => void;
}
const FieldContext = createContext<FieldCtx | null>(null);

export interface FormFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Server or validation error. Hidden while the officer is correcting the field (blur-first validation). */
  error?: string | null;
  /** Checked when the officer leaves the field (never while typing); the message clears on focus or edit. */
  validate?: (value: string) => string | null;
  required?: boolean;
  optionalLabel?: boolean;
  className?: string;
  children: ReactNode;
  id?: string;
}

/**
 * Visible label + control + helper/error in one slot. The error replaces the hint and clears as soon as
 * the officer focuses or edits the field; it reappears only if the server reports it again.
 */
export function FormField({ label, hint, error, required, optionalLabel, className, children, id, validate }: FormFieldProps) {
  const autoId = useId();
  const fid = id ?? `f${autoId.replace(/:/g, "")}`;
  const [engagedWith, setEngagedWith] = useState<string | null>(null);
  const [blurError, setBlurError] = useState<string | null>(null);
  const serverError = !!error && engagedWith !== error ? error : null;
  const shown = blurError ?? serverError;
  return (
    <FieldContext.Provider
      value={{
        id: fid,
        hintId: `${fid}-hint`,
        errorId: `${fid}-error`,
        invalid: !!shown,
        onEngage: () => {
          setEngagedWith(error ?? null);
          setBlurError(null);
        },
        onLeave: (value) => setBlurError(validate ? validate(value) : null),
      }}
    >
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        <label htmlFor={fid} className="text-label font-medium text-ink">
          {label}
          {required ? <span className="ml-0.5 text-danger" aria-hidden="true">*</span> : null}
          {optionalLabel ? <span className="ml-1.5 font-normal text-ink-3">(optional)</span> : null}
        </label>
        {children}
        {shown ? (
          <p id={`${fid}-error`} className="text-label text-danger" role="alert">
            {shown}
          </p>
        ) : hint ? (
          <p id={`${fid}-hint`} className="text-meta text-ink-3">
            {hint}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

function useFieldProps(required?: boolean) {
  const ctx = useContext(FieldContext);
  if (!ctx) return {};
  return {
    id: ctx.id,
    "aria-invalid": ctx.invalid || undefined,
    "aria-describedby": ctx.invalid ? ctx.errorId : ctx.hintId,
    "aria-required": required || undefined,
    onFocusCapture: ctx.onEngage,
    onBlurCapture: (e: { target: EventTarget }) => ctx.onLeave((e.target as HTMLInputElement).value ?? ""),
  };
}

const controlBase =
  "w-full rounded-[var(--radius-control)] border border-line-input bg-surface text-body text-ink shadow-[inset_0_1px_2px_rgba(0,0,0,0.03)] placeholder:text-ink-3 hover:border-[rgb(21_35_59/0.28)] focus-visible:border-focus focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[rgb(40_102_197/0.25)] disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-3 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-[rgb(180_35_24/0.15)]";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, required, ...rest }, ref) {
  const field = useFieldProps(required);
  return <input ref={ref} required={required} className={cn(controlBase, "h-10 px-3 pointer-coarse:h-11", className)} {...field} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, required, rows = 4, ...rest }, ref) {
  const field = useFieldProps(required);
  return <textarea ref={ref} rows={rows} required={required} className={cn(controlBase, "min-h-20 px-3 py-2.5 leading-relaxed", className)} {...field} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, required, children, ...rest }, ref) {
  const field = useFieldProps(required);
  return (
    <div className="relative">
      <select ref={ref} required={required} className={cn(controlBase, "h-10 appearance-none pl-3 pr-9 pointer-coarse:h-11", className)} {...field} {...rest}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
    </div>
  );
});

export function Checkbox({ label, description, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line-input accent-[var(--color-action)]" {...rest} />
      <label htmlFor={id} className="cursor-pointer text-body text-ink">
        {label}
        {description ? <span className="mt-0.5 block text-label text-ink-3">{description}</span> : null}
      </label>
    </div>
  );
}
