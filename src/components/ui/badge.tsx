import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface BadgeProps {
  /** Badge content (text or element) */
  readonly children: ReactNode;
  /** Accent color for tinted background + text */
  readonly color?: string;
  /** Size variant */
  readonly size?: "xs" | "sm";
  /** Extra class names */
  readonly className?: string;
}

/**
 * Small colored label for status, agent type, counts, etc.
 *
 * When `color` is provided, renders with a tinted background (color at 10% opacity)
 * and the color as text. Without `color`, renders in neutral muted style.
 */
export function Badge({ children, color, size = "xs", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "font-medium rounded-[3px] shrink-0",
        size === "xs" && "text-[9px] px-1.5 py-0.5",
        size === "sm" && "text-[10px] px-2 py-0.5",
        !color && "bg-card text-muted-foreground",
        className,
      )}
      style={
        color
          ? {
              backgroundColor: `${color}15`,
              color,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}
