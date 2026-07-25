import { useTranslation } from "react-i18next";
import { Reply, X } from "lucide-react";

interface QuotePreviewBarProps {
  readonly quotedText: string;
  readonly onDismiss: () => void;
}

const MAX_DISPLAY_LENGTH = 200;

export function QuotePreviewBar({ quotedText, onDismiss }: QuotePreviewBarProps) {
  const { t } = useTranslation();

  const displayText =
    quotedText.length > MAX_DISPLAY_LENGTH
      ? `${quotedText.slice(0, MAX_DISPLAY_LENGTH)}...`
      : quotedText;

  return (
    <div
      className="animate-fade-in-up flex items-center"
      style={{
        backgroundColor: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        marginBottom: 4,
        overflow: "hidden",
      }}
    >
      {/* Left purple accent bar */}
      <div
        style={{
          width: 3,
          alignSelf: "stretch",
          backgroundColor: "var(--color-accent-purple)",
          borderRadius: "6px 0 0 6px",
          flexShrink: 0,
        }}
      />

      {/* Quote content */}
      <div
        className="flex-1 min-w-0 flex flex-col"
        style={{ gap: 3, padding: "8px 12px" }}
      >
        <div className="flex items-center" style={{ gap: 6 }}>
          <Reply size={12} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
          <span
            className="font-sans"
            style={{ fontSize: 11, fontWeight: 600, color: "var(--color-accent-purple)" }}
          >
            {t("chat.selectionToolbar.quote")}
          </span>
        </div>
        <p
          className="font-sans m-0"
          style={{
            fontSize: 12,
            color: "var(--color-muted)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.4,
          }}
        >
          {displayText}
        </p>
      </div>

      {/* Close button */}
      <button
        onClick={onDismiss}
        className="shrink-0 flex items-center justify-center transition-colors hover:bg-hover-overlay/[0.06]"
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: "none",
          border: "none",
          cursor: "pointer",
          marginRight: 4,
        }}
        title={t("settings.close")}
      >
        <X size={14} style={{ color: "var(--color-muted)" }} />
      </button>
    </div>
  );
}
