"use client";

import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";
import { Spinner } from "./feedback";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline" | "link";
type Size = "md" | "sm";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-action text-white shadow-[var(--shadow-highlight),var(--shadow-control)] hover:bg-action-hover active:bg-action-hover border border-transparent",
  secondary: "bg-surface text-ink border border-line-input shadow-[var(--shadow-control)] hover:bg-surface-muted hover:border-line-input",
  ghost: "bg-transparent text-ink-2 border border-transparent hover:bg-surface-sunken hover:text-ink",
  danger: "bg-danger-solid text-white border border-transparent shadow-[var(--shadow-highlight),var(--shadow-control)] hover:bg-[#991b1b]",
  "danger-outline": "bg-surface text-danger border border-[rgb(180_35_24/0.35)] hover:bg-danger-tint",
  link: "h-auto px-0 bg-transparent text-action underline-offset-4 hover:underline border-0 shadow-none",
};

const SIZES: Record<Size, string> = {
  md: "h-10 px-4 gap-2 text-body pointer-coarse:h-11",
  // Looks 32px tall in dense rows; an invisible ::before extends the hit area to 44px (and the control is 44px on touch).
  sm: "relative h-8 px-3 gap-1.5 text-label pointer-coarse:h-11 before:absolute before:inset-x-0 before:-inset-y-1.5 before:z-[1] before:content-['']",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  asChild?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, asChild = false, icon, className, children, disabled, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] font-medium disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0",
        VARIANTS[variant],
        variant !== "link" && SIZES[size],
        className,
      )}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner className="size-4" /> : icon}
          {children}
        </>
      )}
    </Comp>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  shortcut?: string;
  variant?: "ghost" | "secondary";
  children: ReactNode;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}

/** Square icon-only control. The label is both the accessible name and the tooltip (hover and focus). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, variant = "ghost", className, children, tooltipSide, type, ...rest },
  ref,
) {
  return (
    <Tooltip
      side={tooltipSide}
      content={
        <span className="inline-flex items-center">
          {label}
          {shortcut ? <kbd className="ml-2 rounded-[var(--radius-chip)] border border-white/25 px-1 font-sans text-meta text-white/85">{shortcut}</kbd> : null}
        </span>
      }
    >
      <button
        ref={ref}
        type={type ?? "button"}
        aria-label={label}
        className={cn(
          "inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] pointer-coarse:size-11 [&_svg]:size-[18px]",
          variant === "ghost" ? "text-ink-2 hover:bg-surface-sunken hover:text-ink" : "border border-line-input bg-surface text-ink-2 shadow-[var(--shadow-control)] hover:bg-surface-muted hover:text-ink",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});
