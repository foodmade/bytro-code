import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon element to render */
  readonly icon: ReactNode;
  /** Size variant */
  readonly size?: "sm" | "md";
  /** Visual variant */
  readonly variant?: "ghost" | "muted";
  /** Active/selected state */
  readonly active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { icon, size = "sm", variant = "ghost", active, className, disabled, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cn(
          "flex items-center justify-center rounded transition-[color,background-color] duration-150",
          size === "sm" && "p-1.5",
          size === "md" && "p-2",
          variant === "ghost" && !disabled && "text-text-tertiary hover:text-muted-foreground hover:bg-hover-overlay/5 active:bg-hover-overlay/10",
          variant === "muted" && !disabled && "text-text-tertiary hover:text-muted-foreground active:text-foreground",
          active && "text-accent-purple bg-accent-purple/15",
          disabled && "text-text-tertiary opacity-40 cursor-not-allowed",
          className,
        )}
        {...props}
      >
        {icon}
      </button>
    );
  },
);
