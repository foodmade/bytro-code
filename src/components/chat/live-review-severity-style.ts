import type { ReviewSeverity } from "@/lib/live-review-events";

// ---------------------------------------------------------------------------
// Severity → presentation lookup table.  Centralised so the panel card and
// the forwarded chat card stay visually consistent and any future "deep mode"
// or third source can plug into the same color language.
// ---------------------------------------------------------------------------

export interface SeverityStyle {
  /** Solid accent color (used for the left-edge bar and the icon stroke). */
  readonly accent: string;
  /** 12% accent — used as pill background. */
  readonly bgSoft: string;
  /** 35% accent — used as pill border. */
  readonly border: string;
  /** Lucide icon name string — caller imports the icon from lucide-react. */
  readonly iconKey:
    | "AlertOctagon"
    | "AlertTriangle"
    | "Lightbulb"
    | "CheckCircle2"
    | "HelpCircle";
  /** i18n key under `chat.codeReview.liveReview.severity.*`. */
  readonly labelKey: string;
}

export const SEVERITY_STYLE: Record<ReviewSeverity, SeverityStyle> = {
  critical: {
    accent: "#ef4444",
    bgSoft: "rgba(239, 68, 68, 0.14)",
    border: "rgba(239, 68, 68, 0.42)",
    iconKey: "AlertOctagon",
    labelKey: "chat.codeReview.liveReview.severity.critical",
  },
  warning: {
    accent: "#f59e0b",
    bgSoft: "rgba(245, 158, 11, 0.16)",
    border: "rgba(245, 158, 11, 0.44)",
    iconKey: "AlertTriangle",
    labelKey: "chat.codeReview.liveReview.severity.warning",
  },
  info: {
    accent: "#3b82f6",
    bgSoft: "rgba(59, 130, 246, 0.14)",
    border: "rgba(59, 130, 246, 0.40)",
    iconKey: "Lightbulb",
    labelKey: "chat.codeReview.liveReview.severity.info",
  },
  ok: {
    accent: "#22c55e",
    bgSoft: "rgba(34, 197, 94, 0.14)",
    border: "rgba(34, 197, 94, 0.40)",
    iconKey: "CheckCircle2",
    labelKey: "chat.codeReview.liveReview.severity.ok",
  },
  unknown: {
    accent: "var(--color-muted-foreground)",
    bgSoft: "rgba(var(--hover-overlay-rgb), 0.10)",
    border: "var(--color-border-strong)",
    iconKey: "HelpCircle",
    labelKey: "chat.codeReview.liveReview.severity.unknown",
  },
};
