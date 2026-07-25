import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown, ChevronRight,
  AlertOctagon, AlertTriangle, Lightbulb, CheckCircle2, HelpCircle,
  Flag, Layers, RotateCw,
  FilePlus2, FileX2, Pencil,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import type { ReviewForwardMeta } from "@/lib/live-review-events";
import { SEVERITY_STYLE } from "./live-review-severity-style";

// ---------------------------------------------------------------------------
// LiveReviewForwardCard — single-row collapsible chat bubble for messages
// originating from the Live Reviewer panel ("Send to chat" button).
//
// Multi-file aware: collapsed pill shows the first file name + a "+N more"
// counter when the review covers multiple files; expanded body lists every
// file with its action icon and +/- counts before the review markdown.
//
// Layout (collapsed):
//   [3px severity edge] [SEV PILL] [SCOPE PILL] file.ext [+N] · summary… [LITE] ⌃
// On expand, a body section drops down with the file list + full markdown.
// ---------------------------------------------------------------------------

interface LiveReviewForwardCardProps {
  readonly meta: ReviewForwardMeta;
  readonly timestamp?: number;
}

export const LiveReviewForwardCard = memo(function LiveReviewForwardCard({
  meta,
}: LiveReviewForwardCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const modeLabel = meta.mode === "deep"
    ? t("chat.codeReview.liveReview.forwardCard.modeDeep")
    : t("chat.codeReview.liveReview.forwardCard.modeLite");

  const severityStyle = SEVERITY_STYLE[meta.severity];
  const showSeverity = meta.severity !== "unknown";
  const SeverityIcon: ReactElement | null = useMemo(() => {
    const props = { size: 11 } as const;
    switch (severityStyle.iconKey) {
      case "AlertOctagon": return <AlertOctagon {...props} />;
      case "AlertTriangle": return <AlertTriangle {...props} />;
      case "Lightbulb": return <Lightbulb {...props} />;
      case "CheckCircle2": return <CheckCircle2 {...props} />;
      case "HelpCircle":
      default:
        return <HelpCircle {...props} />;
    }
  }, [severityStyle.iconKey]);

  const scopeMeta = useMemo(() => {
    if (meta.scope === "milestone") {
      return {
        label: t("chat.codeReview.liveReview.scope.milestone"),
        icon: <Flag size={9} />,
        color: "var(--color-accent-blue)",
      };
    }
    if (meta.scope === "turn") {
      return {
        label: t("chat.codeReview.liveReview.scope.turn"),
        icon: <Layers size={9} />,
        color: "var(--color-accent-purple)",
      };
    }
    return {
      label: t("chat.codeReview.liveReview.scope.manual"),
      icon: <RotateCw size={9} />,
      color: "var(--color-muted)",
    };
  }, [meta.scope, t]);

  const firstFile = meta.files[0];
  const extraCount = meta.files.length - 1;
  const filesTitle = meta.files.map((f) => f.filePath).join("\n");

  // Edge color follows severity when present, else neutral muted edge
  const edgeColor = showSeverity ? severityStyle.accent : "var(--color-muted-foreground)";
  const borderColor = showSeverity ? severityStyle.border : "var(--color-border)";

  return (
    <div
      className="self-end"
      style={{
        maxWidth: 600,
        backgroundColor: "var(--color-card)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-card)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Header row: 3px edge + content + chevron ──────────────────── */}
      <button
        type="button"
        onClick={toggle}
        title={
          expanded
            ? t("chat.codeReview.liveReview.forwardCard.collapse")
            : t("chat.codeReview.liveReview.forwardCard.expand")
        }
        aria-expanded={expanded}
        className="text-left transition-colors"
        style={{
          display: "flex",
          alignItems: "stretch",
          padding: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--color-foreground)",
        }}
      >
        <div style={{ width: 3, alignSelf: "stretch", backgroundColor: edgeColor, flexShrink: 0 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
            padding: "8px 12px",
            border: `1px solid ${borderColor}`,
            borderLeft: "none",
            borderTopRightRadius: "var(--radius-md)",
            borderBottomRightRadius: expanded ? 0 : "var(--radius-md)",
            borderBottomLeftRadius: expanded ? 0 : "var(--radius-md)",
          }}
        >
          {/* Severity pill */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              flexShrink: 0,
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 4,
              color: severityStyle.accent,
              backgroundColor: severityStyle.bgSoft,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-sans)",
            }}
          >
            {SeverityIcon}
            {t(severityStyle.labelKey)}
          </span>

          {/* Scope pill */}
          <span
            title={scopeMeta.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              flexShrink: 0,
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 6px",
              borderRadius: 4,
              color: scopeMeta.color,
              backgroundColor: `color-mix(in srgb, ${scopeMeta.color} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${scopeMeta.color} 35%, transparent)`,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-sans)",
            }}
          >
            {scopeMeta.icon}
            {scopeMeta.label}
          </span>

          {/* File name (first file) */}
          {firstFile && (
            <span
              title={filesTitle}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--color-foreground)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {firstFile.fileName}
            </span>
          )}

          {/* Extra-files counter */}
          {extraCount > 0 && (
            <span
              title={filesTitle}
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--color-muted-foreground)",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 3,
                padding: "1px 6px",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              +{extraCount}
            </span>
          )}

          {/* Separator + truncated summary (collapsed only) */}
          {!expanded && meta.summary && (
            <>
              <span style={{ color: "var(--color-text-tertiary)", fontSize: 12, flexShrink: 0 }}>·</span>
              <span
                title={meta.summary}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  color: "var(--color-muted-foreground)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {meta.summary}
              </span>
            </>
          )}

          {/* Expanded: model name fills remaining space */}
          {expanded && (
            <>
              <span style={{ color: "var(--color-text-tertiary)", fontSize: 12, flexShrink: 0 }}>·</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  color: "var(--color-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {meta.reviewerModel}
              </span>
            </>
          )}

          {/* Mode pill (LITE / DEEP) */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              flexShrink: 0,
              fontSize: 9,
              fontWeight: 700,
              padding: "1px 6px",
              borderRadius: 3,
              color: "var(--color-accent-purple)",
              backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 14%, transparent)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-sans)",
            }}
          >
            {modeLabel}
          </span>

          {expanded
            ? <ChevronDown size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            : <ChevronRight size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />}
        </div>
      </button>

      {/* ── Expanded body: file list + full markdown ───────────────────── */}
      {expanded && (
        <div
          style={{
            border: `1px solid ${borderColor}`,
            borderTop: "none",
            borderBottomLeftRadius: "var(--radius-md)",
            borderBottomRightRadius: "var(--radius-md)",
            marginLeft: 3,
          }}
        >
          {meta.taskTitle && (
            <div
              style={{
                padding: "10px 16px 4px",
                fontSize: 11,
                color: "var(--color-muted-foreground)",
                fontStyle: "italic",
              }}
            >
              {meta.taskTitle}
            </div>
          )}

          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: "8px 16px",
              borderBottom: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {meta.files.map((f) => {
              const ActionIcon = f.action === "create"
                ? <FilePlus2 size={11} style={{ color: "var(--color-accent-success)" }} />
                : f.action === "delete"
                  ? <FileX2 size={11} style={{ color: "var(--color-diff-badge-removed)" }} />
                  : <Pencil size={11} style={{ color: "var(--color-accent-purple)" }} />;
              return (
                <li
                  key={f.filePath}
                  title={f.filePath}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--color-foreground)",
                    minWidth: 0,
                  }}
                >
                  {ActionIcon}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {f.filePath}
                  </span>
                  {f.additions > 0 && (
                    <span style={{ color: "var(--color-accent-success)", fontSize: 10, flexShrink: 0 }}>
                      +{f.additions}
                    </span>
                  )}
                  {f.deletions > 0 && (
                    <span style={{ color: "var(--color-diff-badge-removed)", fontSize: 10, flexShrink: 0 }}>
                      -{f.deletions}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <div
            style={{
              padding: "12px 16px 14px",
              fontSize: 12,
              color: "var(--color-foreground)",
              maxHeight: 480,
              overflowY: "auto",
            }}
          >
            <MarkdownRenderer content={meta.fullContent} variant="compact" />
          </div>
        </div>
      )}
    </div>
  );
});
