import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Zap,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  AlertOctagon,
  AlertTriangle,
  Lightbulb,
  HelpCircle,
  Flag,
  Layers,
  RotateCw,
  FilePlus2,
  FileX2,
  Pencil,
  FileText,
  FolderOpen,
  Code2,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import type { ReviewForwardMeta } from "@/lib/live-review-events";
import { SEVERITY_STYLE } from "./live-review-severity-style";
import { formatRelativeTime, parseUserContent, baseName } from "./message-config";

// ---------------------------------------------------------------------------
// InjectedNoticeStrip — single-row, compact strips embedded inside an AI
// message bubble for mid-stream queued user messages and forwarded review
// feedback. Replaces the previous full-width independent cards which broke
// the visual continuity of the AI bubble.
// ---------------------------------------------------------------------------

export type InjectedNotice =
  | {
      readonly id: string;
      readonly kind: "midStream";
      readonly content: string;
      readonly displayContent?: string;
      readonly timestamp: number;
      readonly consumed: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "reviewForward";
      readonly meta: ReviewForwardMeta;
      readonly timestamp: number;
    };

interface InjectedNoticeStripProps {
  readonly notices: ReadonlyArray<InjectedNotice>;
}

export const InjectedNoticeStrip = memo(function InjectedNoticeStrip({
  notices,
}: InjectedNoticeStripProps) {
  if (notices.length === 0) return null;
  return (
    <div
      className="flex flex-col items-start"
      style={{ gap: 4, marginTop: 6, alignSelf: "flex-start", maxWidth: "100%" }}
    >
      {notices.map((n) =>
        n.kind === "midStream" ? (
          <MidStreamStrip key={n.id} notice={n} />
        ) : (
          <ReviewForwardStrip key={n.id} notice={n} />
        ),
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Mid-stream queued-message strip
// ---------------------------------------------------------------------------

function MidStreamStrip({
  notice,
}: {
  readonly notice: Extract<InjectedNotice, { kind: "midStream" }>;
}) {
  const { t } = useTranslation();
  const visible = notice.displayContent ?? notice.content;
  const parsed = useMemo(() => parseUserContent(visible), [visible]);

  const accent = notice.consumed
    ? "var(--color-accent-green)"
    : "var(--color-accent-amber)";
  const bg = notice.consumed
    ? "var(--color-midstream-bg-consumed)"
    : "var(--color-midstream-bg-pending)";

  const preview = parsed.text.replace(/\s+/g, " ").trim();
  const attachments = parsed.attachments.slice(0, 2);
  const selections = parsed.selections.slice(0, Math.max(0, 2 - attachments.length));
  const extraAttachments = parsed.attachments.length + parsed.selections.length - attachments.length - selections.length;

  return (
    <div
      className="inline-flex items-stretch min-w-0 max-w-full"
      style={{ backgroundColor: bg, borderRadius: 4, overflow: "hidden" }}
    >
      <div style={{ width: 2, backgroundColor: accent, flexShrink: 0 }} />
      <div
        className="flex items-center min-w-0"
        style={{ gap: 6, padding: "3px 8px" }}
      >
        <Zap
          size={11}
          style={{ color: accent, fill: accent, flexShrink: 0 }}
        />
        <span
          className="font-sans font-semibold shrink-0"
          style={{ fontSize: 10, color: accent, letterSpacing: "0.02em" }}
        >
          {notice.consumed
            ? t("chat.midStreamMessage.consumed")
            : t("chat.midStreamMessage.queued")}
        </span>
        {notice.consumed && (
          <CheckCircle2
            size={11}
            style={{ color: accent, flexShrink: 0 }}
          />
        )}

        {(attachments.length > 0 || selections.length > 0) && (
          <span className="inline-flex items-center shrink-0" style={{ gap: 4 }}>
            {attachments.map((att) => {
              const isDir = att.kind === "directory";
              return (
                <span
                  key={att.path}
                  className="inline-flex items-center"
                  style={{ gap: 3 }}
                  title={att.path}
                >
                  {isDir ? (
                    <FolderOpen size={9} style={{ color: "#F59E0B" }} />
                  ) : (
                    <FileText size={9} style={{ color: "#A78BFA" }} />
                  )}
                  <span
                    className="font-sans"
                    style={{ fontSize: 10, color: "var(--color-muted-foreground)" }}
                  >
                    {baseName(att.path)}
                  </span>
                </span>
              );
            })}
            {selections.map((selection) => (
              <span
                key={selection.id}
                className="inline-flex items-center"
                style={{ gap: 3 }}
                title={selection.path}
              >
                <Code2 size={9} style={{ color: "var(--color-accent-info)" }} />
                <span
                  className="font-sans"
                  style={{ fontSize: 10, color: "var(--color-muted-foreground)" }}
                >
                  {selection.label || baseName(selection.path)}
                </span>
              </span>
            ))}
            {extraAttachments > 0 && (
              <span
                className="font-sans"
                style={{ fontSize: 10, color: "var(--color-muted)" }}
              >
                +{extraAttachments}
              </span>
            )}
          </span>
        )}

        {preview && (
          <>
            <span
              className="shrink-0"
              style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
            >
              ·
            </span>
            <span
              className="font-sans truncate min-w-0"
              title={preview}
              style={{ fontSize: 11, color: "var(--color-muted-foreground)" }}
            >
              {preview}
            </span>
          </>
        )}

        <span
          className="shrink-0"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          ·
        </span>
        <span
          className="font-mono shrink-0"
          style={{ fontSize: 10, color: "var(--color-text-placeholder)" }}
        >
          {formatRelativeTime(notice.timestamp)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review-forward (Live Reviewer "Send to chat") strip — collapsible.
// ---------------------------------------------------------------------------

function ReviewForwardStrip({
  notice,
}: {
  readonly notice: Extract<InjectedNotice, { kind: "reviewForward" }>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const meta = notice.meta;
  const severityStyle = SEVERITY_STYLE[meta.severity];
  const showSeverity = meta.severity !== "unknown";

  const SeverityIcon: ReactElement | null = useMemo(() => {
    const props = { size: 9 } as const;
    switch (severityStyle.iconKey) {
      case "AlertOctagon":
        return <AlertOctagon {...props} />;
      case "AlertTriangle":
        return <AlertTriangle {...props} />;
      case "Lightbulb":
        return <Lightbulb {...props} />;
      case "CheckCircle2":
        return <CheckCircle2 {...props} />;
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

  const edgeColor = showSeverity
    ? severityStyle.accent
    : "var(--color-muted-foreground)";
  const borderColor = showSeverity
    ? severityStyle.border
    : "var(--color-border)";

  const modeLabel =
    meta.mode === "deep"
      ? t("chat.codeReview.liveReview.forwardCard.modeDeep")
      : t("chat.codeReview.liveReview.forwardCard.modeLite");

  return (
    <div
      className="flex flex-col min-w-0 max-w-full"
      style={{
        borderRadius: 4,
        overflow: "hidden",
        backgroundColor: "var(--color-card)",
        border: `1px solid ${borderColor}`,
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        title={
          expanded
            ? t("chat.codeReview.liveReview.forwardCard.collapse")
            : t("chat.codeReview.liveReview.forwardCard.expand")
        }
        className="text-left"
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--color-foreground)",
          minWidth: 0,
        }}
      >
        <div style={{ width: 2, backgroundColor: edgeColor, flexShrink: 0 }} />
        <div
          className="flex items-center min-w-0"
          style={{ gap: 6, padding: "3px 8px", flex: 1 }}
        >
          {showSeverity && (
            <span
              className="inline-flex items-center shrink-0"
              style={{
                gap: 3,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 3,
                color: severityStyle.accent,
                backgroundColor: severityStyle.bgSoft,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontFamily: "var(--font-sans)",
              }}
            >
              {SeverityIcon}
              {t(severityStyle.labelKey)}
            </span>
          )}

          <span
            title={scopeMeta.label}
            className="inline-flex items-center shrink-0"
            style={{
              gap: 2,
              fontSize: 9,
              fontWeight: 700,
              padding: "1px 4px",
              borderRadius: 3,
              color: scopeMeta.color,
              backgroundColor: `color-mix(in srgb, ${scopeMeta.color} 14%, transparent)`,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontFamily: "var(--font-sans)",
            }}
          >
            {scopeMeta.icon}
          </span>

          {firstFile && (
            <span
              title={filesTitle}
              className="font-mono shrink-0"
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--color-foreground)",
              }}
            >
              {firstFile.fileName}
            </span>
          )}

          {extraCount > 0 && (
            <span
              title={filesTitle}
              className="shrink-0"
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: "var(--color-muted-foreground)",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 3,
                padding: "0 4px",
                fontFamily: "var(--font-sans)",
              }}
            >
              +{extraCount}
            </span>
          )}

          {!expanded && meta.summary && (
            <>
              <span
                className="shrink-0"
                style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
              >
                ·
              </span>
              <span
                title={meta.summary}
                className="font-sans truncate min-w-0"
                style={{
                  fontSize: 11,
                  color: "var(--color-muted-foreground)",
                }}
              >
                {meta.summary}
              </span>
            </>
          )}

          <span
            className="shrink-0"
            style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}
          >
            ·
          </span>
          <span
            className="font-mono shrink-0"
            style={{ fontSize: 10, color: "var(--color-text-placeholder)" }}
          >
            {formatRelativeTime(notice.timestamp)}
          </span>

          <span
            className="shrink-0"
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "0 4px",
              borderRadius: 3,
              color: "var(--color-accent-purple)",
              backgroundColor:
                "color-mix(in srgb, var(--color-accent-purple) 14%, transparent)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontFamily: "var(--font-sans)",
            }}
          >
            {modeLabel}
          </span>

          {expanded ? (
            <ChevronDown
              size={12}
              style={{ color: "var(--color-muted)", flexShrink: 0 }}
            />
          ) : (
            <ChevronRight
              size={12}
              style={{ color: "var(--color-muted)", flexShrink: 0 }}
            />
          )}
        </div>
      </button>

      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${borderColor}`,
            backgroundColor: "var(--color-surface)",
          }}
        >
          {meta.taskTitle && (
            <div
              style={{
                padding: "8px 12px 2px",
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
              padding: "6px 12px",
              borderBottom: "1px solid var(--color-border)",
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {meta.files.map((f) => {
              const ActionIcon =
                f.action === "create" ? (
                  <FilePlus2
                    size={11}
                    style={{ color: "var(--color-accent-success)" }}
                  />
                ) : f.action === "delete" ? (
                  <FileX2
                    size={11}
                    style={{ color: "var(--color-diff-badge-removed)" }}
                  />
                ) : (
                  <Pencil
                    size={11}
                    style={{ color: "var(--color-accent-purple)" }}
                  />
                );
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
                    <span
                      style={{
                        color: "var(--color-accent-success)",
                        fontSize: 10,
                        flexShrink: 0,
                      }}
                    >
                      +{f.additions}
                    </span>
                  )}
                  {f.deletions > 0 && (
                    <span
                      style={{
                        color: "var(--color-diff-badge-removed)",
                        fontSize: 10,
                        flexShrink: 0,
                      }}
                    >
                      -{f.deletions}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <div
            style={{
              padding: "10px 12px 12px",
              fontSize: 12,
              color: "var(--color-foreground)",
              maxHeight: 420,
              overflowY: "auto",
            }}
          >
            <MarkdownRenderer content={meta.fullContent} variant="compact" />
          </div>
        </div>
      )}
    </div>
  );
}
