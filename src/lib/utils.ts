import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { CSSProperties } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Smoothly collapse/expand a text label for compact toolbar mode. */
export const collapseStyle = (compact: boolean): CSSProperties => ({
  overflow: "hidden",
  maxWidth: compact ? 0 : 200,
  opacity: compact ? 0 : 1,
  transition: "max-width 150ms ease, opacity 150ms ease",
  whiteSpace: "nowrap",
});
