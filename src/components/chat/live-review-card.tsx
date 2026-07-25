import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  FilePlus2,
  FileX2,
  Pencil,
  RotateCw,
  SendHorizontal,
  MailCheck,
  AlertOctagon,
  Lightbulb,
  HelpCircle,
  Flag,
  Layers,
  ChevronRight,
  ChevronDown,
  MessageSquareText,
  Sparkles,
} from "lucide-react";
import { SEVERITY_STYLE } from "./live-review-severity-style";
import { useLiveReviewStore, type LiveReviewItem } from "@/stores/live-review-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useToastStore } from "@/stores/toast-store";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { toRelativePath } from "@/lib/code-review-service";
import { retryLiveReview } from "@/lib/live-review-service";
import {
  LIVE_REVIEW_SEND_TO_CHAT_EVENT,
  buildReviewSummary,
  type LiveReviewSendToChatDetail,
  type ReviewForwardFile,
  type ReviewForwardMeta,
} from "@/lib/live-review-events";

interface LiveReviewCardProps {
  readonly conversationId: string;
  readonly item: LiveReviewItem;
}

const STATUS_COLOR: Record<LiveReviewItem["status"], string> = {
  queued: "var(--color-muted)",
  streaming: "var(--color-accent-purple)",
  done: "var(--color-accent-success)",
  error: "#ef4444",
  stale: "var(--color-muted)",
};

export function LiveReviewCard({ conversationId, item }: LiveReviewCardProps) {
  const { t } = useTranslation();
  const removeReview = useLiveReviewStore((s) => s.removeReview);
  const markForwarded = useLiveReviewStore((s) => s.markForwarded);
  const workspace = useWorkspaceStore((s) => s.activeWorkspace);
  const isForwarded = item.forwardedAt != null;

  // Use the reviewer label captured at scheduling time — see LiveReviewItem.
  // Reading the live providerOverride here would silently rewrite history if
  // the user switched models after the review completed, including the value
  // that gets forwarded to main chat in the meta payload.
  const reviewerModel = item.reviewerModel ?? "";
  // Task-title section starts collapsed: it's contextual hint (last assistant
  // message for TURN reviews, completed-todo content for MILESTONE) which is
  // often a wall of markdown the user already saw in the main chat.  Showing
  // it inline, plain-text and clamped looked broken (see screenshot bug).
  const [taskExpanded, setTaskExpanded] = useState(false);
  const showSeverity = item.status === "done";
  const severityStyle = SEVERITY_STYLE[item.severity];

  const SeverityIcon: ReactElement | null = useMemo(() => {
    if (!showSeverity) return null;
    const props = { size: 11 } as const;
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
  }, [severityStyle.iconKey, showSeverity]);

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of item.files) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [item.files]);

  const handleRemove = useCallback(() => {
    removeReview(conversationId, item.reviewId);
  }, [conversationId, item.reviewId, removeReview]);

  const handleRetry = useCallback(() => {
    retryLiveReview(conversationId, item);
  }, [conversationId, item]);

  // Reviews flagged "ok" have nothing actionable, so hide the optimize CTA
  // entirely — clicking it would just inject a "looks good" message into the
  // main chat and trigger pointless rework.
  const canSendToChat =
    item.status === "done" && !!item.content.trim() && !isForwarded && item.severity !== "ok";
  const handleSendToChat = useCallback(() => {
    if (!canSendToChat) return;

    const reviewStore = useLiveReviewStore.getState();
    const trimmed = item.content.trim();
    const wsPath = workspace?.path ?? "";
    const forwardFiles: ReviewForwardFile[] = item.files.map((f) => {
      const relPath = wsPath ? toRelativePath(f.filePath, wsPath) : f.filePath;
      const parts = relPath.split(/[\\/]/);
      const fileName = parts[parts.length - 1] || relPath;
      return {
        filePath: relPath,
        fileName,
        action: f.action,
        additions: f.additions,
        deletions: f.deletions,
      };
    });

    const filesLine = forwardFiles.map((f) => `\`${f.filePath}\``).join(", ");
    const prefix = t("chat.codeReview.liveReview.injectionPrefixBatch", {
      count: forwardFiles.length,
      files: filesLine,
    });
    const prompt = `${prefix}\n\n${trimmed}`;

    const reviewMeta: ReviewForwardMeta = {
      source: "live-review",
      mode: reviewStore.mode,
      scope: item.scope,
      files: forwardFiles,
      taskTitle: item.taskTitle,
      reviewerModel,
      summary: buildReviewSummary(trimmed),
      fullContent: trimmed,
      severity: item.severity,
      reviewId: item.reviewId,
      reviewedAt: item.startedAt,
    };
    const detail: LiveReviewSendToChatDetail = { conversationId, prompt, meta: reviewMeta };
    window.dispatchEvent(new CustomEvent(LIVE_REVIEW_SEND_TO_CHAT_EVENT, { detail }));
    markForwarded(conversationId, item.reviewId);
    useToastStore.getState().addToast("info", t("chat.codeReview.liveReview.sentToast"));
  }, [
    canSendToChat,
    conversationId,
    item.content,
    item.files,
    item.reviewId,
    item.scope,
    item.severity,
    item.startedAt,
    item.taskTitle,
    markForwarded,
    reviewerModel,
    t,
    workspace?.path,
  ]);

  const StatusIcon = useMemo(() => {
    switch (item.status) {
      case "streaming":
        return (
          <Loader2 size={11} className="animate-spin" style={{ color: STATUS_COLOR.streaming }} />
        );
      case "done":
        return <CheckCircle2 size={11} style={{ color: STATUS_COLOR.done }} />;
      case "error":
        return <AlertTriangle size={11} style={{ color: STATUS_COLOR.error }} />;
      case "queued":
      case "stale":
        return <Clock size={11} style={{ color: STATUS_COLOR.stale }} />;
      default:
        return null;
    }
  }, [item.status]);

  const statusLabel = useMemo(() => {
    switch (item.status) {
      case "queued":
        return t("chat.codeReview.liveReview.statusQueued");
      case "streaming":
        return t("chat.codeReview.liveReview.statusStreaming");
      case "done":
        return t("chat.codeReview.liveReview.statusDone");
      case "error":
        return t("chat.codeReview.liveReview.statusError");
      case "stale":
        return t("chat.codeReview.liveReview.statusStale");
      default:
        return "";
    }
  }, [item.status, t]);

  const scopeMeta = useMemo(() => {
    if (item.scope === "milestone") {
      return {
        label: t("chat.codeReview.liveReview.scope.milestone"),
        icon: <Flag size={10} />,
        color: "var(--color-accent-blue)",
      };
    }
    if (item.scope === "turn") {
      return {
        label: t("chat.codeReview.liveReview.scope.turn"),
        icon: <Layers size={10} />,
        color: "var(--color-accent-purple)",
      };
    }
    return {
      label: t("chat.codeReview.liveReview.scope.manual"),
      icon: <RotateCw size={10} />,
      color: "var(--color-muted)",
    };
  }, [item.scope, t]);

  // Left accent stripe — mirrors the conversation area's mid-stream-card
  // language: a single 3px left bar carries the semantic, no floating shadow
  // and no 4-side box.  Always present so every card reads as a lightweight
  // info block glued to the panel rather than a "PR-style" elevated ticket:
  //   done      → severity accent (unknown falls back to neutral)
  //   error     → red, streaming → violet, queued/stale → neutral
  //   forwarded → success green (whole card additionally dimmed)
  const stripeColor = isForwarded
    ? "var(--color-accent-success)"
    : item.status === "error"
      ? STATUS_COLOR.error
      : item.status === "streaming"
        ? STATUS_COLOR.streaming
        : showSeverity && item.severity !== "unknown"
          ? severityStyle.accent
          : "var(--color-border-strong)";

  return (
    <div
      style={{
        // Tinted surface instead of an elevated card: a very light wash of the
        // stripe color over --color-surface keeps it flat and blended into the
        // panel background (no --shadow-card, no 4-side border).
        backgroundColor: isForwarded
          ? "color-mix(in srgb, var(--color-surface) 55%, transparent)"
          : `color-mix(in srgb, ${stripeColor} 5%, var(--color-surface))`,
        borderLeft: `3px solid ${
          isForwarded
            ? "color-mix(in srgb, var(--color-accent-success) 55%, transparent)"
            : stripeColor
        }`,
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        flexShrink: 0,
        opacity: isForwarded ? 0.72 : 1,
        transition: "opacity 0.2s, background-color 0.2s, border-color 0.2s",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: 1,
          }}
        >
          {/* Scope badge (MILESTONE / TURN) */}
          <span
            title={scopeMeta.label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 7px",
              borderRadius: 4,
              backgroundColor: `color-mix(in srgb, ${scopeMeta.color} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${scopeMeta.color} 35%, transparent)`,
              color: scopeMeta.color,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              fontFamily: "var(--font-sans)",
              flexShrink: 0,
            }}
          >
            {scopeMeta.icon}
            {scopeMeta.label}
          </span>

          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              fontWeight: 500,
              color: "var(--color-muted-foreground)",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {t("chat.codeReview.liveReview.fileCount", { count: item.files.length })}
          </span>

          {totals.add > 0 && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--color-accent-success)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {t("chat.codeReview.liveReview.additions", { count: totals.add })}
            </span>
          )}
          {totals.del > 0 && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--color-diff-badge-removed)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {t("chat.codeReview.liveReview.deletions", { count: totals.del })}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {showSeverity && item.severity !== "unknown" && (
            <span
              title={t(severityStyle.labelKey)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 4,
                backgroundColor: severityStyle.bgSoft,
                border: `1px solid ${severityStyle.border}`,
                fontSize: 10,
                fontWeight: 700,
                color: severityStyle.accent,
                whiteSpace: "nowrap",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              {SeverityIcon}
              {t(severityStyle.labelKey)}
            </span>
          )}
          {isForwarded && (
            <span
              title={t("chat.codeReview.liveReview.alreadyForwarded")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 4,
                backgroundColor: "color-mix(in srgb, var(--color-accent-success) 14%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--color-accent-success) 35%, transparent)",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--color-accent-success)",
                whiteSpace: "nowrap",
              }}
            >
              <MailCheck size={11} />
              {t("chat.codeReview.liveReview.forwardedBadge")}
            </span>
          )}
          {/* Status badge — hidden in the `done` state because the severity
              pill already conveys "review finished + verdict"; an extra
              "已完成 / Done" pill would just be visual noise.  Other states
              (streaming / error / queued / stale) still need a clear signal,
              so they keep the badge. */}
          {item.status !== "done" && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 8px",
                borderRadius: 4,
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                fontSize: 10,
                fontWeight: 500,
                color: STATUS_COLOR[item.status],
                whiteSpace: "nowrap",
              }}
            >
              {StatusIcon}
              {statusLabel}
            </span>
          )}
          <button
            type="button"
            onClick={handleRemove}
            title={t("chat.codeReview.liveReview.removeFile")}
            style={{
              width: 22,
              height: 22,
              borderRadius: 4,
              border: "none",
              background: "none",
              cursor: "pointer",
              color: "var(--color-muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={11} />
          </button>
        </div>
      </div>

      {/* Optional task-title section — collapsible, rendered as markdown when
          expanded so headings / lists / code spans inside the assistant's
          summary or todo text don't render as raw plain text. */}
      {item.taskTitle && (
        <div>
          <button
            type="button"
            onClick={() => setTaskExpanded((v) => !v)}
            aria-expanded={taskExpanded}
            className="w-full flex items-center cursor-pointer"
            style={{
              gap: 6,
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: "var(--color-muted-foreground)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              textAlign: "left",
            }}
          >
            {taskExpanded ? (
              <ChevronDown size={11} style={{ flexShrink: 0 }} />
            ) : (
              <ChevronRight size={11} style={{ flexShrink: 0 }} />
            )}
            <MessageSquareText size={11} style={{ flexShrink: 0, color: "var(--color-muted)" }} />
            <span
              style={{
                fontWeight: 600,
                color: "var(--color-muted-foreground)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {item.scope === "milestone"
                ? t("chat.codeReview.liveReview.taskTitle.milestone")
                : t("chat.codeReview.liveReview.taskTitle.turn")}
            </span>
            {!taskExpanded && (
              <span
                title={item.taskTitle}
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: "var(--color-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {item.taskTitle.replace(/\s+/g, " ").trim()}
              </span>
            )}
          </button>
          {taskExpanded && (
            <div
              style={{
                padding: "0 12px 10px 26px",
                fontSize: 11,
                color: "var(--color-foreground)",
                maxHeight: 240,
                overflowY: "auto",
              }}
            >
              <MarkdownRenderer content={item.taskTitle} variant="compact" />
            </div>
          )}
        </div>
      )}

      {/* File list — one row per file */}
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: "4px 12px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 3,
          maxHeight: 140,
          overflowY: "auto",
        }}
      >
        {item.files.map((f) => {
          const relPath = workspace?.path ? toRelativePath(f.filePath, workspace.path) : f.filePath;
          const parts = relPath.split(/[\\/]/);
          const fileName = parts[parts.length - 1] || relPath;
          const ActionIcon =
            f.action === "create" ? (
              <FilePlus2 size={11} style={{ color: "var(--color-accent-success)" }} />
            ) : f.action === "delete" ? (
              <FileX2 size={11} style={{ color: "var(--color-diff-badge-removed)" }} />
            ) : (
              <Pencil size={11} style={{ color: "var(--color-accent-purple)" }} />
            );

          return (
            <li
              key={f.filePath}
              title={relPath}
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
                {fileName}
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

      {/* Body */}
      <div
        style={{
          padding: "4px 12px 12px",
          fontSize: 12,
          color: "var(--color-foreground)",
          maxHeight: 360,
          overflowY: "auto",
        }}
      >
        {item.status === "error" ? (
          <div style={{ color: "#ef4444", fontFamily: "var(--font-sans)" }}>
            {t("chat.codeReview.liveReview.errorPrefix")}
            {item.error}
          </div>
        ) : item.content ? (
          <MarkdownRenderer content={item.content} variant="compact" />
        ) : (
          <div style={{ color: "var(--color-muted)", fontStyle: "italic" }}>
            {t("chat.codeReview.liveReview.statusStreaming")}
          </div>
        )}
      </div>

      {/* Footer — reviewer credit on the left, primary CTA (optimize/retry)
          on the right.  Hidden when there's nothing actionable AND the user
          has nothing useful to read here (i.e. ok-severity reviews don't
          render a footer because severity badge alone tells the story). */}
      {(canSendToChat || item.status === "error") && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "10px 12px 12px",
          }}
        >
          {/* Reviewer credit */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
              flex: 1,
            }}
          >
            <Sparkles size={10} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 10,
                fontWeight: 500,
                color: "var(--color-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {t("chat.codeReview.liveReview.reviewerCredit", { model: reviewerModel })}
            </span>
          </div>
          {canSendToChat && (
            <button
              type="button"
              onClick={handleSendToChat}
              className="native-css-hover"
              style={
                {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#FFFFFF",
                  backgroundImage:
                    "linear-gradient(135deg, var(--color-accent-purple) 0%, color-mix(in srgb, var(--color-accent-purple) 70%, #000) 100%)",
                  border: "none",
                  cursor: "pointer",
                  boxShadow:
                    "0 2px 8px color-mix(in srgb, var(--color-accent-purple) 27%, transparent)",
                  flexShrink: 0,
                  "--native-hover-filter": "brightness(1.1)",
                } as React.CSSProperties
              }
            >
              <SendHorizontal size={12} />
              {t("chat.codeReview.liveReview.sendToChat")}
            </button>
          )}
          {item.status === "error" && (
            <button
              type="button"
              onClick={handleRetry}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 11px",
                borderRadius: 8,
                fontFamily: "var(--font-sans)",
                fontSize: 11,
                fontWeight: 500,
                color: "var(--color-muted-foreground)",
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border-strong)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <RotateCw size={12} />
              {t("chat.codeReview.liveReview.retry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
