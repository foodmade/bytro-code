import { useCallback, useRef, useState, useEffect, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  FolderOpen,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Undo2,
  Loader2,
  MousePointerClick,
  RefreshCw,
  Sparkles,
  Code2,
  Target,
} from "lucide-react";
import { ImageLightbox } from "./image-lightbox";
import { cn } from "@/lib/utils";
import { useCheckpointStore, type Checkpoint } from "@/stores/checkpoint-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useChatStore } from "@/stores/chat-store";
import {
  formatRelativeTime,
  parseUserContent,
  baseName,
  type AttachmentBlock,
  type SelectionSnippetRef,
  type ContentSegment,
  type ElementContext,
  type SlideElementContext,
} from "./message-config";
import type { ChatMessageProps } from "./chat-message";

// ---------------------------------------------------------------------------
// PathTooltip — custom tooltip with path display and copy button
// ---------------------------------------------------------------------------

function PathTooltip({ path, visible }: { readonly path: string; readonly visible: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [path],
  );

  if (!visible) return null;

  return (
    <div
      className="absolute bottom-full left-1/2 mb-2 z-[100] animate-fade-in"
      style={{ transform: "translateX(-50%)" }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg"
        style={{
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border-strong)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          maxWidth: 420,
        }}
      >
        <span
          className="text-[11px] font-mono text-text-tertiary truncate select-all"
          style={{ direction: "rtl", textAlign: "left" }}
        >
          {path}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded transition-colors hover:bg-border-light"
        >
          {copied ? (
            <Check size={11} className="text-[#10B981]" />
          ) : (
            <Copy size={11} className="text-text-tertiary" />
          )}
          <span
            className="text-[10px] font-sans"
            style={{ color: copied ? "#10B981" : "var(--color-text-tertiary)" }}
          >
            {copied ? "Copied" : "Copy"}
          </span>
        </button>
      </div>
      {/* Arrow */}
      <div
        className="absolute left-1/2 -bottom-1"
        style={{
          transform: "translateX(-50%)",
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "5px solid var(--color-border-strong)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttachmentChip — inline chip for a file or directory attachment
// ---------------------------------------------------------------------------

function AttachmentChip({ attachment }: { readonly attachment: AttachmentBlock }) {
  const [hover, setHover] = useState(false);
  const isDir = attachment.kind === "directory";
  const name = baseName(attachment.path);

  return (
    <span
      className="relative inline-flex items-center gap-1.5 px-2 py-1 rounded-md cursor-default"
      style={{
        backgroundColor: isDir ? "rgba(245,158,11,0.1)" : "rgba(var(--theme-accent-rgb),0.1)",
        border: `1px solid ${isDir ? "rgba(245,158,11,0.2)" : "rgba(var(--theme-accent-rgb),0.2)"}`,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <PathTooltip path={attachment.path} visible={hover} />
      {isDir ? (
        <FolderOpen size={12} className="shrink-0" style={{ color: "#F59E0B" }} />
      ) : (
        <FileText size={12} className="shrink-0" style={{ color: "#A78BFA" }} />
      )}
      <span
        className="text-[11px] font-semibold font-sans"
        style={{ color: isDir ? "#FBBF24" : "#C4B5FD" }}
      >
        {name}
      </span>
    </span>
  );
}

function isPastedTextAttachment(attachment: AttachmentBlock): boolean {
  return (
    attachment.source === "pasted-text" || /^pasted-text-\d+\.txt$/i.test(baseName(attachment.path))
  );
}

function getTextPreview(text: string | undefined): string {
  if (!text) return "";
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function PastedTextMessageCard({
  attachment,
  content,
}: {
  readonly attachment: AttachmentBlock;
  readonly content?: string;
}) {
  const { t } = useTranslation();
  const title = getTextPreview(content || attachment.content) || t("chat.pastedText.title");

  return (
    <span className="user-pasted-text-card">
      <span className="user-pasted-text-card__icon" aria-hidden>
        <FileText size={16} />
      </span>
      <span className="user-pasted-text-card__body">
        <span className="user-pasted-text-card__title" title={title}>
          {title}
        </span>
        <span className="user-pasted-text-card__meta">{t("chat.pastedText.label")}</span>
      </span>
    </span>
  );
}

function MessageAttachment({
  attachment,
  content,
}: {
  readonly attachment: AttachmentBlock;
  readonly content?: string;
}) {
  if (isPastedTextAttachment(attachment)) {
    return <PastedTextMessageCard attachment={attachment} content={content} />;
  }
  return <AttachmentChip attachment={attachment} />;
}

function SelectionChip({ selection }: { readonly selection: SelectionSnippetRef }) {
  const [hover, setHover] = useState(false);
  const label = selection.label || baseName(selection.path) || selection.id;

  return (
    <span
      className="relative inline-flex items-center gap-1.5 px-2 py-1 rounded-md cursor-default"
      style={{
        backgroundColor: "color-mix(in srgb, var(--color-accent-info) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-accent-info) 24%, transparent)",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {selection.path && <PathTooltip path={selection.path} visible={hover} />}
      <Code2 size={12} className="shrink-0" style={{ color: "var(--color-accent-info)" }} />
      <span
        className="text-[11px] font-semibold font-sans"
        style={{ color: "var(--color-muted-foreground)" }}
      >
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ElementChip — compact indicator for selected DOM element context
// ---------------------------------------------------------------------------

function ElementChip({ context }: { readonly context: ElementContext }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md"
      style={{
        backgroundColor: "rgba(var(--theme-accent-rgb),0.1)",
        border: "1px solid rgba(var(--theme-accent-rgb),0.2)",
      }}
    >
      <MousePointerClick size={12} className="shrink-0" style={{ color: "#A855F7" }} />
      <span className="text-[11px] font-semibold font-mono" style={{ color: "#C4B5FD" }}>
        &lt;{context.tagName}&gt;
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// SlideElementChip — indicator for selected slide element context
// ---------------------------------------------------------------------------

function SlideElementChip({ context }: { readonly context: SlideElementContext }) {
  const { t } = useTranslation();
  const typeName = t(`slideshow.element.${context.elementType}`, {
    defaultValue: context.elementType,
  });
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md"
      style={{
        backgroundColor: "rgba(var(--theme-accent-rgb),0.1)",
        border: "1px solid rgba(var(--theme-accent-rgb),0.2)",
      }}
    >
      <MousePointerClick size={12} className="shrink-0" style={{ color: "#A855F7" }} />
      <span
        className="text-[11px] font-semibold font-sans truncate"
        style={{ color: "#C4B5FD", maxWidth: 320 }}
      >
        {t("slideshow.element.page", { defaultValue: "Page" })} {context.page} &rsaquo; {typeName}:{" "}
        {context.textPreview}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ModeChip — visible badge for `$mode` quick-toggles active when the user
// submitted this turn. Mirrors the inline chip style from the input box but
// is a static read-only indicator (no close button) since past turns can't
// be edited.
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<string, string> = {
  imagegen: "use imagegen",
};

function ModeChip({ mode }: { readonly mode: string }) {
  const label = MODE_LABELS[mode] ?? mode;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium font-sans"
      style={{
        backgroundColor: "rgba(var(--theme-accent-rgb),0.15)",
        border: "1px solid rgba(192,132,252,0.4)",
        color: "#E9D5FF",
        letterSpacing: "0.2px",
      }}
    >
      <Sparkles size={11} style={{ color: "#C084FC" }} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleText — long user messages with expand/collapse
// ---------------------------------------------------------------------------

const COLLAPSE_HEIGHT = 120;

function CollapsibleText({ text }: { readonly text: string }) {
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [isOverflow, setIsOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setIsOverflow(el.scrollHeight > COLLAPSE_HEIGHT);
  }, [text]);

  return (
    <div className="relative">
      <p
        ref={contentRef}
        className={cn(
          "text-[14px] font-sans whitespace-pre-wrap break-words transition-[max-height] duration-200 ease-in-out",
          !expanded && isOverflow && "overflow-hidden",
        )}
        style={{
          lineHeight: 1.5,
          color: "var(--color-foreground)",
          maxHeight: !expanded && isOverflow ? COLLAPSE_HEIGHT : undefined,
        }}
      >
        {text}
      </p>
      {isOverflow && !expanded && (
        <div
          className="absolute bottom-0 left-0 right-0 h-10 pointer-events-none"
          style={{
            background: "linear-gradient(transparent, var(--user-bubble-bg))",
          }}
        />
      )}
      {isOverflow && (
        <button
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-1 mt-1 text-[11px] font-sans transition-colors"
          style={{ color: "var(--color-foreground)", opacity: 0.7 }}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} />
              <span>Show less</span>
            </>
          ) : (
            <>
              <ChevronDown size={12} />
              <span>Show more</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CollapsibleSegments — renders ordered text + attachment segments with
// expand/collapse for long content
// ---------------------------------------------------------------------------

function CollapsibleSegments({
  segments,
  attachmentContentByPath,
}: {
  readonly segments: ReadonlyArray<ContentSegment>;
  readonly attachmentContentByPath: ReadonlyMap<string, string>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflow, setIsOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setIsOverflow(el.scrollHeight > COLLAPSE_HEIGHT);
  }, [segments]);

  return (
    <div className="relative">
      <div
        ref={contentRef}
        className={cn(
          "text-[14px] font-sans whitespace-pre-wrap break-words transition-[max-height] duration-200 ease-in-out",
          !expanded && isOverflow && "overflow-hidden",
        )}
        style={{
          lineHeight: 1.5,
          color: "var(--color-foreground)",
          maxHeight: !expanded && isOverflow ? COLLAPSE_HEIGHT : undefined,
        }}
      >
        {segments.map((seg, i) => {
          if (seg.type === "attachment") {
            return (
              <MessageAttachment
                key={`att-${i}`}
                attachment={seg.attachment}
                content={attachmentContentByPath.get(seg.attachment.path)}
              />
            );
          }
          if (seg.type === "selection") {
            return <SelectionChip key={`sel-${i}`} selection={seg.selection} />;
          }
          return <span key={`txt-${i}`}>{seg.text}</span>;
        })}
      </div>
      {isOverflow && !expanded && (
        <div
          className="absolute bottom-0 left-0 right-0 h-10 pointer-events-none"
          style={{
            background: "linear-gradient(transparent, var(--user-bubble-bg))",
          }}
        />
      )}
      {isOverflow && (
        <button
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-1 mt-1 text-[11px] font-sans transition-colors"
          style={{ color: "var(--color-foreground)", opacity: 0.7 }}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} />
              <span>Show less</span>
            </>
          ) : (
            <>
              <ChevronDown size={12} />
              <span>Show more</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useLinkedCheckpoint — find the checkpoint associated with this user message
// ---------------------------------------------------------------------------

/**
 * Given the timestamp of a user message, returns the most recent checkpoint
 * whose timestamp falls between this user message and the next one.
 * A checkpoint is "linked" to a user message if it was created during the turn
 * that this user message initiated.
 */
/** Selector that returns user-message timestamps as a joined string key.
 *  This is referentially stable during streaming (which only mutates assistant
 *  message content) and avoids creating new array objects every render. */
const selectUserTimestampKey = (s: {
  messages: ReadonlyArray<{ role: string; timestamp: number }>;
}): string => {
  let key = "";
  for (const m of s.messages) {
    if (m.role === "user") {
      if (key) key += ",";
      key += m.timestamp;
    }
  }
  return key;
};

function useLinkedCheckpoint(messageTimestamp: number | undefined): Checkpoint | null {
  const conversationId = useConversationStore((s) => s.activeConversationId);
  const checkpoints = useCheckpointStore(
    (s) => s.getConversationCheckpoints(conversationId).checkpoints,
  );
  const userTimestampKey = useChatStore(selectUserTimestampKey);

  return useMemo(() => {
    if (!messageTimestamp || checkpoints.length === 0) return null;

    const userTimestamps = userTimestampKey ? userTimestampKey.split(",").map(Number) : [];
    const myIndex = userTimestamps.indexOf(messageTimestamp);
    if (myIndex < 0) return null;

    const nextUserTimestamp =
      myIndex < userTimestamps.length - 1 ? userTimestamps[myIndex + 1] : Infinity;

    // Find the latest checkpoint between this user message and the next
    let best: Checkpoint | null = null;
    for (const cp of checkpoints) {
      if (cp.timestamp > messageTimestamp && cp.timestamp < nextUserTimestamp) {
        if (!best || cp.timestamp > best.timestamp) {
          best = cp;
        }
      }
    }
    return best;
  }, [messageTimestamp, checkpoints, userTimestampKey]);
}

// ---------------------------------------------------------------------------
// MessageActions — Copy + Revert actions shown below user message bubble
// ---------------------------------------------------------------------------

function MessageActions({
  text,
  checkpoint,
  onRetry,
  sentAsGoal,
}: {
  readonly text: string;
  readonly checkpoint: Checkpoint | null;
  readonly onRetry?: () => void;
  readonly sentAsGoal?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const conversationId = useConversationStore((s) => s.activeConversationId);
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const isRestoring = useCheckpointStore(
    (s) => s.getConversationCheckpoints(conversationId).isRestoring,
  );
  const restoreCheckpoint = useCheckpointStore((s) => s.restoreCheckpoint);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  const handleRestore = useCallback(() => {
    if (!checkpoint || isRestoring || !workspacePath) return;
    const confirmed = window.confirm(
      t(
        "chat.checkpoint.confirmRestore",
        "This will discard uncommitted changes and restore to this checkpoint. Continue?",
      ),
    );
    if (!confirmed) return;
    restoreCheckpoint(conversationId, workspacePath, checkpoint.id);
  }, [conversationId, workspacePath, isRestoring, restoreCheckpoint, checkpoint, t]);

  const actionBtnClass =
    "flex items-center gap-1 px-1.5 py-1 cursor-pointer rounded-md text-muted font-sans text-[11px] font-medium transition-all duration-150 hover:text-muted-foreground hover:bg-foreground/8";

  return (
    <div className="message-actions flex justify-end gap-0.5" style={{ marginRight: 4 }}>
      {text && (
        <button onClick={handleCopy} className={cn(actionBtnClass, copied && "!text-accent-green")}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? t("chat.copied", "Copied") : t("chat.copy", "Copy")}</span>
        </button>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className={actionBtnClass}
          title={t("chat.userActions.retryTitle", "Retry this message")}
        >
          <RefreshCw size={13} />
          <span>{t("chat.userActions.retry", "Retry")}</span>
        </button>
      )}
      {sentAsGoal && (
        <span
          className={cn(actionBtnClass, "cursor-default hover:bg-transparent hover:text-muted")}
          title={t("chat.userActions.sentAsGoalTitle", "This message was sent as a goal")}
        >
          <Target size={13} />
          <span>{t("chat.userActions.sentAsGoal", "Sent as goal")}</span>
        </span>
      )}
      {checkpoint && (
        <button
          onClick={handleRestore}
          disabled={isRestoring}
          className={cn(
            actionBtnClass,
            "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted",
          )}
          title={t("chat.checkpoint.restoreTo", "Restore to this checkpoint")}
        >
          {isRestoring ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
          <span>{t("chat.revert", "Revert")}</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserAvatar
// ---------------------------------------------------------------------------

function UserAvatar() {
  return (
    <div
      className="flex items-center justify-center w-8 h-8 rounded-full overflow-hidden text-[13px] font-semibold font-sans"
      style={{
        backgroundColor: "var(--color-border-light)",
        color: "var(--color-foreground)",
      }}
    >
      Y
    </div>
  );
}

// ---------------------------------------------------------------------------
// UserMessage — right-aligned blue bubble
// ---------------------------------------------------------------------------

export function UserMessage({
  content,
  displayContent,
  timestamp,
  media,
  onRetry,
  onRetryMessage,
  sentAsGoal,
}: ChatMessageProps) {
  const visibleContent = displayContent ?? content;
  const parsed = useMemo(() => parseUserContent(visibleContent), [visibleContent]);
  const attachmentContentByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const attachment of parseUserContent(content).attachments) {
      if (attachment.content) {
        byPath.set(attachment.path, attachment.content);
      }
    }
    return byPath;
  }, [content]);
  const handleRetry = useCallback(() => {
    if (onRetry) {
      onRetry();
      return;
    }
    onRetryMessage?.(content, media, displayContent);
  }, [content, displayContent, media, onRetry, onRetryMessage]);
  const retryHandler = onRetry || onRetryMessage ? handleRetry : undefined;
  // Check if attachments appear interleaved with text (not all at start/end)
  const hasInlineAttachments = useMemo(() => {
    const { segments } = parsed;
    if (segments.length < 2) return false;
    // If there's at least one text segment before a chip, or chip between texts
    let foundText = false;
    for (const seg of segments) {
      if (seg.type === "text") foundText = true;
      else if ((seg.type === "attachment" || seg.type === "selection") && foundText) return true;
    }
    return false;
  }, [parsed]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const linkedCheckpoint = useLinkedCheckpoint(timestamp);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-3 justify-end min-w-0">
          <div
            className="message-group flex flex-col items-end gap-1 min-w-0"
            style={{ maxWidth: "min(680px, 85%)" }}
          >
            <div
              className="flex flex-col items-end gap-1.5 min-w-0 overflow-hidden max-w-full"
              style={
                {
                  padding: "8px 14px",
                  borderRadius: "14px 4px 14px 14px",
                  background: "var(--user-bubble-bg)",
                  border:
                    "1px solid color-mix(in srgb, var(--color-user-bubble-border) 45%, transparent)",
                  "--user-bubble-bg":
                    "color-mix(in srgb, var(--color-user-bubble) 22%, var(--color-background))",
                } as CSSProperties
              }
            >
              {media && media.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {media.map((item, i) => {
                    const src = `data:${item.mediaType};base64,${item.data}`;
                    return (
                      <img
                        key={i}
                        src={src}
                        alt=""
                        className="w-16 h-16 rounded object-cover border border-[var(--color-border)] cursor-pointer hover:brightness-110 transition-[filter]"
                        onClick={() => setLightboxSrc(src)}
                      />
                    );
                  })}
                </div>
              )}
              {parsed.modes.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {parsed.modes.map((m) => (
                    <ModeChip key={m} mode={m} />
                  ))}
                </div>
              )}
              {parsed.elementContext && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <ElementChip context={parsed.elementContext} />
                </div>
              )}
              {parsed.slideElementContext && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <SlideElementChip context={parsed.slideElementContext} />
                </div>
              )}
              {parsed.segments.length > 0 && hasInlineAttachments ? (
                <CollapsibleSegments
                  segments={parsed.segments}
                  attachmentContentByPath={attachmentContentByPath}
                />
              ) : (
                <>
                  {(parsed.attachments.length > 0 || parsed.selections.length > 0) && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {parsed.attachments.map((att) => (
                        <MessageAttachment
                          key={att.path}
                          attachment={att}
                          content={attachmentContentByPath.get(att.path)}
                        />
                      ))}
                      {parsed.selections.map((selection) => (
                        <SelectionChip key={selection.id} selection={selection} />
                      ))}
                    </div>
                  )}
                  {parsed.text && <CollapsibleText text={parsed.text} />}
                </>
              )}
            </div>
            <MessageActions
              text={parsed.text}
              checkpoint={linkedCheckpoint}
              onRetry={retryHandler}
              sentAsGoal={sentAsGoal}
            />
          </div>

          <div className="flex flex-col items-center gap-1 shrink-0">
            <UserAvatar />
            {timestamp && (
              <span className="text-[10px] font-mono text-text-tertiary">
                {formatRelativeTime(timestamp)}
              </span>
            )}
          </div>
        </div>
      </div>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
