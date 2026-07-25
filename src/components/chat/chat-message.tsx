import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Copy,
  Check,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  GitFork,
  Timer,
  Hash,
} from "lucide-react";
import { ImageLightbox } from "./image-lightbox";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { CodeBlock } from "./code-block";
import { ToolCallList } from "./tool-call-block";
import { TaskNoticeChip } from "./task-notice-chip";
import type { ToolCall, ThinkingEntry, TurnUsageData } from "@/stores/chat-store";
import type { AgentRole } from "@/types";
import { Presentation, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { useSlideshowStore } from "@/stores/slideshow-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useChatStore } from "@/stores/chat-store";
import { useToastStore } from "@/stores/toast-store";
import { formatError } from "@/lib/format-error";
import { parseSlideshowJson } from "@/lib/slideshow-parser";
import { useTranslation } from "react-i18next";
import {
  resolveAgentConfig,
  formatTime,
} from "./message-config";
import { UserMessage } from "./user-message";
import { MidStreamMessageCard } from "./mid-stream-message-card";
import { CommandInvocationCard } from "./command-invocation-card";
import type { CommandInvocationMeta } from "@/stores/chat-store";
import { LiveReviewForwardCard } from "./live-review-forward-card";
import { InjectedNoticeStrip, type InjectedNotice } from "./injected-notice-strip";
import type { ReviewForwardMeta } from "@/lib/live-review-events";
import { ThinkingBlock } from "./thinking-block";
import { formatDuration } from "@/lib/format-duration";
import { useSmoothStreamText } from "./use-smooth-stream-text";
import {
  buildSegments,
  findStableStreamingMarkdownBoundary,
  getVisibleMessageContentLength,
  normalizeMessageContent,
} from "./chat-message-segments";
import "highlight.js/styles/github-dark-dimmed.min.css";

// ---------------------------------------------------------------------------
// MessageActions — hover-reveal action bar
// ---------------------------------------------------------------------------

function MessageActions({
  content,
  role,
  modelTag,
  messageId,
}: {
  readonly content: string;
  readonly role: AgentRole;
  readonly modelTag?: string;
  readonly messageId: string;
}) {
  const { t } = useTranslation();
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [forking, setForking] = useState(false);

  const config = resolveAgentConfig(role, modelTag);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopiedMsg(true);
    setTimeout(() => setCopiedMsg(false), 2000);
  }, [content]);

  // Fork the current conversation at this message into a new one. The copied
  // history renders immediately; the forked conversation's first turn forks a
  // real SDK session (forkSession + resumeSessionAt) so it branches into its own
  // JSONL without touching the source. See conversation-store.forkConversation.
  const handleFork = useCallback(async () => {
    const conversationId = useConversationStore.getState().activeConversationId;
    if (!conversationId || forking) return;
    setForking(true);
    try {
      const forked = await useConversationStore
        .getState()
        .forkConversation(conversationId, messageId);
      await useChatStore.getState().loadMessages(forked.id);
    } catch (e) {
      useToastStore
        .getState()
        .addToast("error", t("chat.forkFailed", { message: formatError(e) }));
    } finally {
      setForking(false);
    }
  }, [messageId, forking, t]);

  return (
    <div className="message-actions flex items-center gap-0.5" style={{ paddingTop: 4 }}>
      <button
        onClick={handleCopy}
        className="flex items-center gap-[5px] px-2 py-1 rounded text-text-placeholder hover:text-text-tertiary hover:bg-hover-overlay/5 transition-colors"
      >
        {copiedMsg ? (
          <Check size={13} className="text-[#10B981] animate-bounce-scale" />
        ) : (
          <Copy size={13} />
        )}
        <span className="text-[11px] font-sans">{copiedMsg ? "Copied" : "Copy"}</span>
      </button>
      <button
        onClick={() => setLiked(!liked)}
        className={cn(
          "flex items-center justify-center px-2 py-1 rounded transition-colors",
          liked ? "animate-bounce-scale" : "",
          "hover:bg-hover-overlay/5",
        )}
      >
        <ThumbsUp
          size={13}
          style={{ color: liked ? config.brandColor : "var(--color-text-placeholder)" }}
          fill={liked ? config.brandColor : "none"}
        />
      </button>
      <button
        onClick={() => setDisliked(!disliked)}
        className={cn(
          "flex items-center justify-center px-2 py-1 rounded transition-colors",
          disliked ? "animate-bounce-scale" : "",
          "hover:bg-hover-overlay/5",
        )}
      >
        <ThumbsDown
          size={13}
          style={{ color: disliked ? "#EF4444" : "var(--color-text-placeholder)" }}
          fill={disliked ? "#EF4444" : "none"}
        />
      </button>
      <button
        onClick={handleFork}
        disabled={forking}
        title={t("chat.forkFromHere")}
        className="flex items-center justify-center px-2 py-1 rounded text-text-placeholder hover:text-text-tertiary hover:bg-hover-overlay/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <GitFork size={13} />
      </button>
      <button
        disabled
        className="flex items-center gap-[5px] px-2 py-1 rounded text-border-strong cursor-not-allowed opacity-40"
        title="Retry (coming soon)"
      >
        <RefreshCw size={13} />
        <span className="text-[11px] font-sans">Retry</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StreamingDots — 3-dot breathing pulse
// ---------------------------------------------------------------------------

function StreamingDots({ color }: { readonly color: string }) {
  return (
    <div className="flex items-center gap-1.5" style={{ paddingTop: 2 }}>
      <span className="w-1.5 h-1.5 rounded-full animate-dot-pulse" style={{ backgroundColor: color }} />
      <span className="w-1.5 h-1.5 rounded-full animate-dot-pulse-delay-1" style={{ backgroundColor: color }} />
      <span className="w-1.5 h-1.5 rounded-full animate-dot-pulse-delay-2" style={{ backgroundColor: color }} />
    </div>
  );
}

function formatUsageNumber(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

function TurnUsageMeta({
  usage,
  durationMs,
}: {
  readonly usage?: TurnUsageData;
  readonly durationMs: number;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith("zh") ? "zh-CN" : "en-US";
  const tokenTitle = usage
    ? t("chat.tokenUsage.turnBreakdown", {
        input: formatUsageNumber(usage.inputTokens, locale),
        output: formatUsageNumber(usage.outputTokens, locale),
        cacheRead: formatUsageNumber(usage.cacheReadTokens, locale),
        cacheWrite: formatUsageNumber(usage.cacheCreationTokens, locale),
      })
    : undefined;

  if (!usage && durationMs <= 0) return null;

  return (
    <div className="flex items-center gap-3" style={{ flexShrink: 0 }}>
      {usage && (
        <div className="flex items-center gap-1" title={tokenTitle} aria-label={tokenTitle}>
          <Hash size={11} color="var(--color-text-placeholder)" strokeWidth={2} />
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--color-text-placeholder)",
              whiteSpace: "nowrap",
            }}
          >
            {t("chat.tokenUsage.turnTokens", {
              tokens: formatUsageNumber(usage.totalTokens, locale),
            })}
          </span>
        </div>
      )}
      {durationMs > 0 && (
        <div className="flex items-center gap-1">
          <Timer size={11} color="var(--color-text-placeholder)" strokeWidth={2} />
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: "var(--color-text-placeholder)",
              whiteSpace: "nowrap",
            }}
          >
            {formatDuration(durationMs)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Adapter to pass CodeBlock component to MarkdownRenderer */
function renderCodeBlock({ language, children }: { language: string; children: React.ReactNode }) {
  if (language === "slideshow") {
    return <SlideshowCodeBlockCard rawSource={children} />;
  }
  return <CodeBlock language={language}>{children}</CodeBlock>;
}

const ChatMarkdownChunk = memo(function ChatMarkdownChunk({
  text,
  lightweight = false,
}: {
  readonly text: string;
  readonly lightweight?: boolean;
}) {
  return (
    <MarkdownRenderer
      content={text}
      variant="chat"
      codeBlock={renderCodeBlock}
      lightweight={lightweight}
    />
  );
});

function StreamingMarkdownSegment({
  text,
  isStreaming,
}: {
  readonly text: string;
  readonly isStreaming: boolean;
}) {
  const stableBoundary = useMemo(
    () => isStreaming ? findStableStreamingMarkdownBoundary(text) : 0,
    [isStreaming, text],
  );

  if (!isStreaming || stableBoundary <= 0) {
    return <ChatMarkdownChunk text={text} lightweight={isStreaming} />;
  }

  const stableText = text.slice(0, stableBoundary);
  const liveText = text.slice(stableBoundary);

  return (
    <div className="streaming-markdown-segment">
      <ChatMarkdownChunk text={stableText} />
      {liveText && (
        <div className="streaming-markdown-tail">
          <ChatMarkdownChunk text={liveText} lightweight />
        </div>
      )}
    </div>
  );
}

/** Compact card replacing raw slideshow JSON in chat messages */
function SlideshowCodeBlockCard({ rawSource }: { readonly rawSource?: React.ReactNode }) {
  const { t } = useTranslation();
  const storeData = useSlideshowStore((s) => s.slideshowData);
  const isStreaming = useSlideshowStore((s) => s.isStreaming);
  const openPanel = useSlideshowStore((s) => s.openPanel);
  const loadFromRawJson = useSlideshowStore((s) => s.loadFromRawJson);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const [expanded, setExpanded] = useState(false);

  const rawText = typeof rawSource === "string"
    ? rawSource
    : rawSource != null
      ? String(rawSource)
      : "";

  // Local parse so card is self-sufficient (works for historical conversations
  // even when the detector hook hasn't populated the store)
  const localData = useMemo(
    () => rawText ? parseSlideshowJson(rawText, true).data : null,
    [rawText],
  );

  // Prefer store data (live streaming), fall back to local parse (history)
  const slideshowData = storeData ?? localData;
  const slideCount = slideshowData?.slides?.length ?? 0;
  const title = slideshowData?.title ?? "";

  const handleOpenPreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeConversationId) {
      // Ensure store is populated before opening panel
      if (rawText && !storeData) {
        loadFromRawJson(rawText);
      }
      openPanel(activeConversationId, "");
    }
  };

  return (
    <div className="slideshow-code-card" style={{ margin: "4px 0", width: "100%", borderRadius: 8, border: "1px solid var(--color-border)", backgroundColor: "var(--color-surface)", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
      >
        <Presentation size={18} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title || (isStreaming ? t("slideshow.generating") : t("slideshow.panelTitle"))}
          </span>
          <span style={{ fontSize: 11, color: "var(--color-muted)" }}>
            {isStreaming
              ? `${t("slideshow.generating")} ${slideCount} ${t("slideshow.slides")}`
              : `${slideCount} ${t("slideshow.slides")}`}
          </span>
        </div>
        {/* Open preview button */}
        <button
          type="button"
          onClick={handleOpenPreview}
          className="slideshow-card-btn"
          title={t("slideshow.openPreview")}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "4px 8px", borderRadius: 4,
            fontSize: 11, fontWeight: 500,
            color: "var(--color-accent-purple)",
            backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 10%, transparent)",
            border: "none", cursor: "pointer", flexShrink: 0,
          }}
        >
          <Eye size={13} />
          {t("slideshow.preview")}
        </button>
        {/* Expand toggle */}
        {expanded
          ? <ChevronDown size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />
          : <ChevronRight size={14} style={{ color: "var(--color-muted)", flexShrink: 0 }} />}
      </div>
      {/* Expandable source code */}
      {expanded && rawText && (
        <div style={{
          borderTop: "1px solid var(--color-border)",
          maxHeight: 200, overflowY: "auto",
          backgroundColor: "var(--color-surface-dark)",
        }}>
          <pre style={{
            margin: 0, padding: "10px 14px",
            fontSize: 11, lineHeight: 1.5,
            color: "var(--color-muted-foreground)",
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}>
            {rawText}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatMessageProps {
  readonly id?: string;
  readonly role: AgentRole;
  readonly content: string;
  /** User-facing display text when content contains hidden system instructions. */
  readonly displayContent?: string;
  readonly modelTag?: string;
  readonly timestamp?: number;
  readonly isStreaming?: boolean;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
  readonly media?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>;
  readonly thinkingBlocks?: ReadonlyArray<ThinkingEntry>;
  readonly midStream?: boolean;
  readonly midStreamConsumed?: boolean;
  /** Live elapsed ms for the active streaming message. */
  readonly elapsedMs?: number;
  /** Duration (ms) of the completed turn — shown at bottom-right of the card. */
  readonly turnDuration?: number;
  /** Persisted per-turn token and duration metrics for this assistant message. */
  readonly turnUsage?: TurnUsageData;
  /** Retry callback — resends this user message (with images). */
  readonly onRetry?: () => void;
  /** Stable retry dispatcher used by chat-panel to avoid per-render closures
   *  on every historical user message during streaming updates. */
  readonly onRetryMessage?: (
    content: string,
    media?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>,
    displayContent?: string,
  ) => void;
  /** Slash-command metadata when the message was classified as an SDK
   *  command. Triggers compact-card rendering instead of a normal bubble. */
  readonly commandInvocation?: CommandInvocationMeta;
  /** True when this user message was submitted through Codex Goals mode. */
  readonly sentAsGoal?: boolean;
  /** Review-forward metadata when the message originated from the Live
   *  Reviewer panel ("Send to chat").  Triggers compact-card rendering. */
  readonly reviewForward?: ReviewForwardMeta;
  /** Mid-stream queued user messages and forwarded review feedback that
   *  arrived while this AI message was being produced. Rendered as compact
   *  inline strips at the bottom of the bubble instead of as independent
   *  message slots, preserving the visual continuity of the AI bubble. */
  readonly injectedNotices?: ReadonlyArray<InjectedNotice>;
  /** True when this assistant message is the LLM's response to one or more
   *  injected mid-stream / review-forward user messages absorbed into the
   *  preceding AI bubble. Suppresses avatar/name/timestamp header so the
   *  message reads as a continuation of the previous bubble rather than a
   *  brand-new one — keeping the conversation visually unbroken. */
  readonly isContinuation?: boolean;
  /** True when this host assistant message has one or more continuation
   *  segments following it (i.e. its `injectedNotices` triggered the LLM to
   *  produce more assistant turns). When set, this bubble suppresses its own
   *  MessageActions / Timer / StreamingDots so the strip and the continuation
   *  content sit flush — those controls are rendered once at the end of the
   *  whole continuation chain instead. */
  readonly hasContinuation?: boolean;
}

// ---------------------------------------------------------------------------
// AgentMessage — left-aligned dark bubble
// ---------------------------------------------------------------------------

function AgentMessage({
  id,
  role,
  content,
  modelTag,
  timestamp,
  isStreaming = false,
  toolCalls,
  media,
  thinkingBlocks,
  elapsedMs,
  turnDuration,
  turnUsage,
  injectedNotices,
  isContinuation = false,
  hasContinuation = false,
}: ChatMessageProps) {
  const config = resolveAgentConfig(role, modelTag);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const smoothContent = useSmoothStreamText(content, isStreaming);
  const isRevealActive = isStreaming || smoothContent.isAnimating;
  const isComplete = !isRevealActive && content.length > 0;

  // Duration to display: live elapsed during streaming, fixed value after completion
  const displayDuration = isStreaming ? (elapsedMs ?? 0) : (turnUsage?.durationMs ?? turnDuration ?? 0);

  const normalized = useMemo(
    () => normalizeMessageContent(content, thinkingBlocks),
    [content, thinkingBlocks],
  );
  const visibleContentLength = useMemo(
    () => {
      return getVisibleMessageContentLength({
        sourceContent: content,
        visibleSourceContent: smoothContent.text,
        normalized,
        isRevealActive,
      });
    },
    [content, isRevealActive, normalized, smoothContent.text],
  );
  const segments = useMemo(
    () => buildSegments(
      normalized.content,
      toolCalls,
      normalized.thinkingBlocks,
      normalized.mapOffset,
      visibleContentLength,
    ),
    [normalized, toolCalls, visibleContentLength],
  );
  const lastTextSegmentIndex = useMemo(
    () => segments.reduce((last, seg, idx) => (seg.kind === "text" ? idx : last), -1),
    [segments],
  );

  return (
    <>
    <div className="flex gap-3 min-w-0">
      {isContinuation ? (
        <div className="w-8 shrink-0" aria-hidden="true" />
      ) : (
        <div
          className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 text-[13px] font-bold font-sans overflow-hidden"
          style={{ backgroundColor: config.avatarBg, color: config.avatarTextColor }}
        >
          {config.iconUrl ? (
            <img src={config.iconUrl} alt={config.label} className="w-full h-full object-cover" />
          ) : (
            config.avatar
          )}
        </div>
      )}

      <div
        className="message-group flex flex-col gap-2 min-w-0 overflow-hidden"
        style={{
          maxWidth: "min(760px, 90%)",
          padding: "4px 0",
        }}
      >
        {!isContinuation && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold font-sans" style={{ color: config.nameColor }}>
              {config.label}
            </span>
            {modelTag && (
              <span className="text-[10px] font-mono" style={{ color: config.modelColor }}>
                {modelTag}
              </span>
            )}
            {timestamp && (
              <span className="text-[11px] font-mono text-text-tertiary">
                {formatTime(timestamp)}
              </span>
            )}
          </div>
        )}

        <div className="message-segment-list">
          {segments.map((seg, idx) => {
            if (seg.kind === "thinking") {
              return (
                <ThinkingBlock
                  key={`th-${idx}`}
                  thinking={seg.entry.text}
                  isThinking={isStreaming && seg.isLastBlock && !seg.entry.complete}
                />
              );
            }
            if (seg.kind === "notices") {
              return <TaskNoticeChip key={`n-${idx}`} notices={seg.notices} />;
            }
            if (seg.kind === "text") {
              return (
                <div
                  key={`t-${idx}`}
                  className={cn(
                    "message-text-segment",
                    isRevealActive && idx === lastTextSegmentIndex && "message-text-segment--streaming",
                  )}
                >
                  <StreamingMarkdownSegment
                    text={seg.text}
                    isStreaming={isRevealActive && idx === lastTextSegmentIndex}
                  />
                </div>
              );
            }
            return (
              <div key={`tc-${idx}`} className="message-tool-segment">
                <ToolCallList toolCalls={seg.calls} />
              </div>
            );
          })}
        </div>

        {media && media.length > 0 && (
          <div className="flex flex-col gap-2">
            {media.map((item, i) => {
              if (item.mediaType.startsWith("image/")) {
                const src = `data:${item.mediaType};base64,${item.data}`;
                return (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    className="max-w-full rounded-lg border border-border-light cursor-pointer hover:brightness-110 transition-[filter]"
                    style={{ maxHeight: 400 }}
                    onClick={() => setLightboxSrc(src)}
                  />
                );
              }
              if (item.mediaType.startsWith("audio/")) {
                return <audio key={i} controls src={`data:${item.mediaType};base64,${item.data}`} className="w-full" />;
              }
              if (item.mediaType.startsWith("video/")) {
                return <video key={i} controls src={`data:${item.mediaType};base64,${item.data}`} className="max-w-full rounded-lg" style={{ maxHeight: 400 }} />;
              }
              return null;
            })}
          </div>
        )}

        {isStreaming && !hasContinuation && (
          <StreamingDots color={config.brandColor || "var(--color-accent-purple)"} />
        )}
        {injectedNotices && injectedNotices.length > 0 && (
          <InjectedNoticeStrip notices={injectedNotices} />
        )}
        {!hasContinuation && (isComplete || isStreaming) && (
          <div className="flex items-center justify-between">
            {isComplete && id ? <MessageActions content={content} role={role} modelTag={modelTag} messageId={id} /> : <div />}
            <TurnUsageMeta usage={turnUsage} durationMs={displayDuration} />
          </div>
        )}
      </div>
    </div>
    {lightboxSrc && (
      <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ChatMessage — dispatcher
// ---------------------------------------------------------------------------

export const ChatMessage = memo(function ChatMessage(props: ChatMessageProps) {
  let inner: ReactNode;
  // Structured-form messages take precedence over delivery-mode flags:
  // a forwarded review or a slash-command invocation always renders as its
  // compact card, regardless of whether it was sent fresh-turn or mid-stream.
  if (props.role === "user" && props.reviewForward) {
    // Forwarded review feedback — compact, collapsible card; the LLM still
    // sees the full content via `props.content`, only the UI bubble is
    // replaced with the structured card.
    inner = (
      <LiveReviewForwardCard
        meta={props.reviewForward}
        timestamp={props.timestamp}
      />
    );
  } else if (props.role === "user" && props.commandInvocation) {
    // Slash-command invocations render as a compact card instead of a normal
    // user bubble — mirrors the terminal Claude Code behavior where /compact /
    // /init / etc. don't show up as user-typed text.
    inner = (
      <CommandInvocationCard
        invocation={props.commandInvocation}
        timestamp={props.timestamp}
      />
    );
  } else if (props.role === "user" && props.midStream) {
    inner = (
      <MidStreamMessageCard
        content={props.content}
        displayContent={props.displayContent}
        timestamp={props.timestamp}
        consumed={props.midStreamConsumed}
      />
    );
  } else if (props.role === "user") {
    inner = <UserMessage {...props} />;
  } else {
    inner = <AgentMessage {...props} />;
  }
  // content-visibility:auto lets the browser skip layout/paint for off-screen
  // messages — critical for long conversations (hundreds of messages).
  // The --continuation modifier is applied when this assistant message is a
  // continuation segment of a host bubble (i.e. the LLM's reply to absorbed
  // mid-stream / review-forward injections). The modifier cancels the
  // chat-messages-column gap and shrinks contain-intrinsic-size so the slot
  // sits flush against the host bubble instead of being separated by the
  // default 20px column gap.
  const slotClass =
    props.role !== "user" && props.isContinuation
      ? "cv-message-slot cv-message-slot--continuation"
      : "cv-message-slot";
  return (
    <div className={slotClass} data-message-id={props.id} data-message-role={props.role}>
      {inner}
    </div>
  );
});

// ---------------------------------------------------------------------------
// TimeDivider
// ---------------------------------------------------------------------------

export function TimeDivider({ timestamp }: { readonly timestamp: number }) {
  const label = formatTime(timestamp);

  return (
    <div className="flex items-center gap-3 animate-fade-in" style={{ padding: "4px 0" }}>
      <div className="flex-1 h-px animate-line-extend" style={{ backgroundColor: "var(--color-border)" }} />
      <span className="text-[10px] font-mono text-text-placeholder">{label}</span>
      <div className="flex-1 h-px animate-line-extend" style={{ backgroundColor: "var(--color-border)" }} />
    </div>
  );
}
