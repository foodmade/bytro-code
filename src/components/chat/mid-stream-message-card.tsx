import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Zap, CheckCircle2, Code2 } from "lucide-react";
import { formatRelativeTime, parseUserContent, baseName } from "./message-config";
import { FileText, FolderOpen } from "lucide-react";

// ---------------------------------------------------------------------------
// MidStreamMessageCard — amber-bordered card for queued mid-stream messages
// Design reference: Pencil node CO537
// ---------------------------------------------------------------------------

interface MidStreamMessageCardProps {
  readonly content: string;
  readonly displayContent?: string;
  readonly timestamp?: number;
  readonly consumed?: boolean;
}

export function MidStreamMessageCard({
  content,
  displayContent,
  timestamp,
  consumed = false,
}: MidStreamMessageCardProps) {
  const { t } = useTranslation();
  const visibleContent = displayContent ?? content;
  const parsed = useMemo(() => parseUserContent(visibleContent), [visibleContent]);

  // Amber for pending, muted green for consumed
  const accentColor = consumed ? "var(--color-accent-green)" : "var(--color-accent-amber)";
  const bgColor = consumed ? "var(--color-midstream-bg-consumed)" : "var(--color-midstream-bg-pending)";
  const borderColor = accentColor;

  return (
    <div
      className="flex min-w-0"
      style={{ maxWidth: "min(760px, 90%)", marginLeft: "auto" }}
    >
      <div
        className="flex flex-col min-w-0 overflow-hidden w-full"
        style={{
          backgroundColor: bgColor,
          borderRadius: 6,
          borderLeft: `3px solid ${borderColor}`,
          padding: "10px 14px",
          gap: 8,
        }}
      >
        {/* Header row */}
        <div className="flex items-center gap-2 min-w-0">
          <Zap
            size={12}
            style={{ color: accentColor, fill: accentColor }}
            className="shrink-0"
          />
          <div
            className="flex items-center justify-center shrink-0 rounded-full"
            style={{
              width: 20,
              height: 20,
              backgroundColor: "var(--color-midstream-avatar-bg)",
            }}
          >
            <span
              className="font-sans font-semibold"
              style={{ fontSize: 9, color: "var(--color-midstream-avatar-text)" }}
            >
              Y
            </span>
          </div>
          <span
            className="font-sans font-semibold shrink-0"
            style={{ fontSize: 11, color: accentColor }}
          >
            {consumed ? t("chat.midStreamMessage.consumed") : t("chat.midStreamMessage.queued")}
          </span>

          {/* Consumed indicator */}
          {consumed && (
            <CheckCircle2
              size={12}
              style={{ color: "var(--color-accent-green)" }}
              className="shrink-0"
            />
          )}

          <div className="flex-1" />
          {timestamp && (
            <span
              className="font-mono shrink-0"
              style={{
                fontSize: 10,
                color: consumed
                  ? "var(--color-midstream-timestamp-consumed)"
                  : "var(--color-midstream-timestamp-pending)",
              }}
            >
              {formatRelativeTime(timestamp)}
            </span>
          )}
        </div>

        {/* Attachment chips (if any) */}
        {parsed.attachments.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {parsed.attachments.map((att) => {
              const isDir = att.kind === "directory";
              const name = baseName(att.path);
              return (
                <span
                  key={att.path}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: isDir
                      ? "rgba(245,158,11,0.1)"
                      : "rgba(var(--theme-accent-rgb),0.1)",
                    border: `1px solid ${isDir ? "rgba(245,158,11,0.2)" : "rgba(var(--theme-accent-rgb),0.2)"}`,
                  }}
                >
                  {isDir ? (
                    <FolderOpen size={10} style={{ color: "#F59E0B" }} />
                  ) : (
                    <FileText size={10} style={{ color: "#A78BFA" }} />
                  )}
                  <span
                    className="font-sans font-semibold"
                    style={{
                      fontSize: 10,
                      color: isDir ? "var(--color-midstream-att-dir-text)" : "var(--color-midstream-att-file-text)",
                    }}
                  >
                    {name}
                  </span>
                </span>
              );
            })}
          </div>
        )}

        {parsed.selections.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {parsed.selections.map((selection) => (
              <span
                key={selection.id}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                title={selection.path}
                style={{
                  backgroundColor: "color-mix(in srgb, var(--color-accent-info) 12%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--color-accent-info) 24%, transparent)",
                }}
              >
                <Code2 size={10} style={{ color: "var(--color-accent-info)" }} />
                <span
                  className="font-sans font-semibold"
                  style={{ fontSize: 10, color: "var(--color-midstream-att-file-text)" }}
                >
                  {selection.label || baseName(selection.path)}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Body text */}
        {parsed.text && (
          <p
            className="font-sans whitespace-pre-wrap break-words"
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--color-midstream-body)",
              margin: 0,
            }}
          >
            {parsed.text}
          </p>
        )}
      </div>
    </div>
  );
}
