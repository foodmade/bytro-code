import { useRef, useState, useCallback, useMemo, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChatMessage, TimeDivider } from "./chat-message";
import type { InjectedNotice } from "./injected-notice-strip";
import { ChatOutline } from "./chat-outline";
import { CliMissingCard } from "./cli-missing-card";
import { AgentLoading } from "./agent-loading";
import { StreamRetryBanner } from "./stream-retry-banner";
import { AgentStatusPanel } from "./agent-status-panel";
import { ChatInput } from "./chat-input";
import { ChatTokenWave } from "./chat-token-wave";
import { ToolConfirmDialog } from "./tool-confirm-dialog";
import { AskUserQuestionDialog } from "./ask-user-question-dialog";
import { ContextFilesBar } from "./context-files-bar";
import { FileListPanel } from "./file-list-panel";
import { SessionTabBar } from "./session-tab-bar";
import { ReviewModal } from "./review-modal";
import { DiffViewerModal, TurnDiffBar } from "./turn-diff-panel";
import { synthesizeUnifiedDiff } from "@/lib/tool-calls-to-unified-diff";
import { splitDiffWithPaths, mergeSameFileDiffs } from "@/lib/diff-utils";
import { NodeRuntimeBanner } from "./node-runtime-banner";
import { ProjectMemoryBanner } from "./project-memory-banner";
import { SelectionToolbar } from "./selection-toolbar";
import { QuotePreviewBar } from "./quote-preview-bar";
import { ChatEmptyState } from "./chat-empty-state";
import { ImageLightbox } from "./image-lightbox";

import { ArrowDown, MousePointerClick, X } from "lucide-react";
import { useChatStore, useAppStore, useConversationStore, useStreamStateStore, useCheckpointStore, useWorkspaceStore, useGitStore, useTerminalStore, useAgentStatusStore } from "@/stores";
import { usePreviewStore } from "@/stores/preview-store";
import { createNativeContextMenuItem, nativeMenuSeparator, popupNativeContextMenu, type NativeContextMenuItem } from "@/lib/native-context-menu";
import { useAutoScroll, useChatStreaming, usePinToBottomOnSwitch, useTextSelection, formatElementPrompt, useViteErrorFeedback } from "@/hooks";
import { useConversationSwitch } from "@/hooks/use-conversation-switch";
import { useConversationStatus } from "@/hooks/use-conversation-status";
import { useSlideshowDetector } from "@/hooks/use-slideshow-detector";
import { useSlideshowStore } from "@/stores/slideshow-store";
import type { ChatStreamingOptions } from "@/hooks/use-chat-streaming";
import type { SplitPaneId } from "@/stores";

/**
 * Compact pill showing the selected DOM element from the preview inspector.
 * Matches pencil design node wqzEg (ElementContext).
 */
function ElementContextPill({
  tagName,
  textContent,
  onDismiss,
}: {
  readonly tagName: string;
  readonly textContent: string;
  readonly onDismiss: () => void;
}) {
  const label = `<${tagName}>${textContent ? ` ${textContent.slice(0, 40)}` : ""}`;
  return (
    <div
      className="flex items-center shrink-0"
      style={{
        gap: 6,
        padding: "5px 10px",
        borderRadius: 6,
        backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 12%, var(--color-surface))",
        border: "1px solid color-mix(in srgb, var(--color-accent-purple) 19%, transparent)",
      }}
    >
      <MousePointerClick size={12} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
      <span
        className="truncate"
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
          color: "var(--color-accent-purple)",
        }}
      >
        {label}
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 hover:opacity-80 transition-opacity"
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 0 }}
      >
        <X size={12} style={{ color: "var(--color-muted)" }} />
      </button>
    </div>
  );
}

function isEditableContextMenuTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("input, textarea, select, [role='textbox']")) return true;
  const editable = target.closest("[contenteditable]");
  return editable instanceof HTMLElement && editable.contentEditable !== "false";
}

/**
 * Compact pill showing the selected slide element from the slideshow preview.
 * Follows the same pattern as ElementContextPill above.
 */
function SlideElementPill({
  slideIndex,
  elementType,
  textPreview,
  onDismiss,
}: {
  readonly slideIndex: number;
  readonly elementType: string;
  readonly textPreview: string;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const typeLabel = t(`slideshow.element.${elementType}`, { defaultValue: elementType });
  const label = `${t("slideshow.element.page", { defaultValue: "Page" })} ${slideIndex + 1} › ${typeLabel}: ${textPreview}`;
  return (
    <div
      className="flex items-center shrink-0"
      style={{
        gap: 6,
        padding: "5px 10px",
        borderRadius: 6,
        backgroundColor: "color-mix(in srgb, var(--color-accent-purple) 12%, var(--color-surface))",
        border: "1px solid color-mix(in srgb, var(--color-accent-purple) 19%, transparent)",
      }}
    >
      <MousePointerClick size={12} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
      <span
        className="truncate"
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 11,
          color: "var(--color-accent-purple)",
        }}
      >
        {label}
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 hover:opacity-80 transition-opacity"
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 0 }}
      >
        <X size={12} style={{ color: "var(--color-muted)" }} />
      </button>
    </div>
  );
}

/** Insert a time divider when the gap between messages exceeds this value. */
const TIME_DIVIDER_GAP_MS = 5 * 60 * 1000; // 5 minutes

/** How close to the top (in px) before triggering a load-more. */
const SCROLL_TOP_THRESHOLD = 80;
const EMPTY_MESSAGES: readonly [] = [];

interface ChatPanelProps {
  readonly chatStreamingOptions?: ChatStreamingOptions;
  readonly hideSessionTabs?: boolean;
  readonly conversationId?: string | null;
  readonly paneId?: SplitPaneId;
  readonly isFocused?: boolean;
  readonly compact?: boolean;
}

export function ChatPanel({
  chatStreamingOptions,
  hideSessionTabs = false,
  conversationId: scopedConversationId,
  paneId,
  isFocused = true,
  compact,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const clearConversationCompleted = useStreamStateStore((s) => s.clearConversationCompleted);
  const hasScopedConversationId = scopedConversationId !== undefined;
  const resolvedConversationId = hasScopedConversationId ? scopedConversationId : activeConversationId;
  const isScopedDraftPane = hasScopedConversationId && resolvedConversationId === null;
  const messages = useChatStore(
    useCallback((state) => {
      if (isScopedDraftPane) {
        return EMPTY_MESSAGES;
      }
      if (!resolvedConversationId || resolvedConversationId === activeConversationId) {
        return state.messages;
      }
      return state._snapshots[resolvedConversationId]?.messages ?? EMPTY_MESSAGES;
    }, [activeConversationId, isScopedDraftPane, resolvedConversationId]),
  );
  const retryAttempt = useStreamStateStore((s) => s.retryAttempt);
  const retryMaxAttempts = useStreamStateStore((s) => s.retryMaxAttempts);
  const hasMoreMessages = useChatStore(
    useCallback((state) => {
      if (isScopedDraftPane) {
        return false;
      }
      if (!resolvedConversationId || resolvedConversationId === activeConversationId) {
        return state.hasMoreMessages;
      }
      return state._snapshots[resolvedConversationId]?.hasMoreMessages ?? false;
    }, [activeConversationId, isScopedDraftPane, resolvedConversationId]),
  );
  const isLoadingOlder = useChatStore(
    useCallback((state) => {
      if (isScopedDraftPane) {
        return false;
      }
      if (!resolvedConversationId || resolvedConversationId === activeConversationId) {
        return state.isLoadingOlder;
      }
      return state._snapshots[resolvedConversationId]?.isLoadingOlder ?? false;
    }, [activeConversationId, isScopedDraftPane, resolvedConversationId]),
  );
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const ensureSnapshotLoaded = useChatStore((s) => s.ensureSnapshotLoaded);
  const { getRunState } = useConversationStatus();
  const runState = useMemo(
    () => getRunState(resolvedConversationId),
    [getRunState, resolvedConversationId],
  );
  const lastTurnDurationForPane = useAgentStatusStore(
    useCallback((state) => {
      if (isScopedDraftPane) return null;
      if (!resolvedConversationId) return null;
      if (resolvedConversationId === activeConversationId) {
        return state.lastTurnDurationMs;
      }
      return state._agentStatusCache[resolvedConversationId]?.lastTurnDurationMs ?? null;
    }, [activeConversationId, isScopedDraftPane, resolvedConversationId]),
  );
  const isForegroundConversation = resolvedConversationId != null && resolvedConversationId === activeConversationId;
  const isCompactPane = compact ?? false;
  const retryAttemptForPane =
    isForegroundConversation && runState.isRunning ? retryAttempt : null;
  const retryMaxAttemptsForPane =
    isForegroundConversation && runState.isRunning ? retryMaxAttempts : null;
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const layoutRef = useRef<HTMLDivElement>(null);
  const loadCheckpoints = useCheckpointStore((s) => s.loadCheckpoints);
  const scrollResetKey = `${resolvedConversationId ?? ""}:chat:${paneId ?? "default"}`;
  const { scrollRef, setScrollRef, scrollElement, isAtBottom, scrollToBottom } = useAutoScroll(messages, isLoadingOlder, scrollResetKey);
  usePinToBottomOnSwitch(scrollRef, scrollResetKey, scrollElement);

  const { selectedText, hasSelection, toolbarPosition } = useTextSelection(scrollRef, layoutRef);
  const isLikelyMacWebKit = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
    const ua = navigator.userAgent;
    return /Mac/i.test(platform) && /AppleWebKit/i.test(ua);
  }, []);

  // Detect ```slideshow blocks in assistant messages → update slideshow store
  useSlideshowDetector();

  useEffect(() => {
    if (resolvedConversationId && resolvedConversationId !== activeConversationId) {
      void ensureSnapshotLoaded(resolvedConversationId);
    }
  }, [activeConversationId, ensureSnapshotLoaded, resolvedConversationId]);

  useEffect(() => {
    if (!isFocused || !resolvedConversationId) {
      return;
    }
    clearConversationCompleted(resolvedConversationId);
  }, [clearConversationCompleted, isFocused, resolvedConversationId]);

  // Load persisted checkpoints from git log when conversation changes
  useEffect(() => {
    if (resolvedConversationId && workspacePath) {
      loadCheckpoints(resolvedConversationId, workspacePath);
    }
  }, [resolvedConversationId, workspacePath, loadCheckpoints]);

  useEffect(() => {
    if (!isLikelyMacWebKit || !resolvedConversationId || messages.length === 0) {
      return;
    }

    let rafId = 0;
    rafId = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;

      // Force WebKit to flush the new conversation layout, then re-apply the
      // current scroll position so macOS Tauri WebView paints immediately.
      void el.clientHeight;
      void el.scrollHeight;
      el.scrollTo({ top: el.scrollTop, behavior: "auto" });
    });

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isLikelyMacWebKit, resolvedConversationId, messages.length, scrollRef]);

  const [quotedText, setQuotedText] = useState<string | null>(null);
  const handleQuote = useCallback((text: string) => { setQuotedText(text); }, []);
  const handleDismissQuote = useCallback(() => { setQuotedText(null); }, []);

  // ── Turn Diff modal / pill (Codex mode) ──
  // "minimized" = pill above input, "modal" = full viewer, "closed" = hidden
  const [turnDiffView, setTurnDiffView] = useState<"minimized" | "modal" | "closed">("minimized");
  // Track reverted files: filePath → messageId at revert time.
  // Diffs from messages at or before the reverted messageId are excluded from
  // the accumulation, so new edits from later turns show as fresh entries.
  const [revertedFileAtMsg, setRevertedFileAtMsg] = useState<ReadonlyMap<string, string>>(new Map());

  // Accumulate diffs from ALL assistant turns.
  // Same file across turns: merge hunks so all edits are visible.
  // Skip diffs from turns that have been reverted.
  const [activeTurnDiff, fileMessageMap] = useMemo(() => {
    const fileMap = new Map<string, { diffs: string[]; messageId: string }>();
    // Pre-compute message index for ordering comparison
    const msgIndexMap = new Map(messages.map((m, i) => [m.id, i]));

    for (const msg of messages) {
      if (msg.role === "user") continue;
      const diff = msg.turnDiff ?? synthesizeUnifiedDiff(msg.toolCalls);
      if (!diff) continue;

      for (const { filePath, diff: sectionDiff } of splitDiffWithPaths(diff)) {
        // Skip diffs from turns at or before the reverted point
        const revertedAtId = revertedFileAtMsg.get(filePath);
        if (revertedAtId) {
          const revertedIdx = msgIndexMap.get(revertedAtId);
          const currentIdx = msgIndexMap.get(msg.id);
          if (revertedIdx != null && currentIdx != null && currentIdx <= revertedIdx) {
            continue;
          }
        }

        const existing = fileMap.get(filePath);
        if (existing) {
          existing.diffs.push(sectionDiff);
          existing.messageId = msg.id;
        } else {
          fileMap.set(filePath, { diffs: [sectionDiff], messageId: msg.id });
        }
      }
    }

    if (fileMap.size === 0) {
      return [undefined, new Map<string, string>()] as const;
    }

    const diffParts: string[] = [];
    const resultMap = new Map<string, string>();
    for (const [filePath, { diffs, messageId }] of fileMap) {
      diffParts.push(mergeSameFileDiffs(diffs));
      resultMap.set(filePath, messageId);
    }

    return [diffParts.join("\n"), resultMap] as const;
  }, [messages, revertedFileAtMsg]);

  // Files that were reverted AND have no new (post-revert) diffs
  const displayRevertedFiles = useMemo(() => {
    const result = new Set<string>();
    for (const [filePath] of revertedFileAtMsg) {
      if (!fileMessageMap.has(filePath)) {
        result.add(filePath);
      }
    }
    return result;
  }, [revertedFileAtMsg, fileMessageMap]);
  // Auto-show bar when diff content changes (new turn or new file edit)
  const prevDiffRef = useRef(activeTurnDiff);
  useEffect(() => {
    if (activeTurnDiff && activeTurnDiff !== prevDiffRef.current) {
      setTurnDiffView((v) => v === "closed" ? "minimized" : v);
    }
    prevDiffRef.current = activeTurnDiff;
  }, [activeTurnDiff]);

  // Selected DOM element from preview inspector
  const selectedElement = usePreviewStore((s) => s.selectedElement);
  const clearSelectedElement = usePreviewStore((s) => s.clearSelectedElement);
  const handleDismissElement = useCallback(() => {
    clearSelectedElement();
  }, [clearSelectedElement]);

  // Selected slide element from slideshow preview
  const selectedSlideElement = useSlideshowStore((s) => s.selectedSlideElement);
  const clearSlideElement = useSlideshowStore((s) => s.clearSlideElement);
  const handleDismissSlideElement = useCallback(() => {
    clearSlideElement();
  }, [clearSlideElement]);

  // ── Chat area context menu ──
  const { handleCreate: handleCreateSession, handleRemoveTab, handleSelect } = useConversationSwitch();
  const toggleGitPanel = useGitStore((s) => s.togglePanel);

  // Copy a data-URL or remote image to the clipboard as a PNG blob
  const copyImageToClipboard = useCallback(async (src: string) => {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      // Clipboard API requires image/png; convert if necessary
      const pngBlob = blob.type === "image/png"
        ? blob
        : await new Promise<Blob>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              const canvas = document.createElement("canvas");
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(img, 0, 0);
              canvas.toBlob((b) => {
                if (b) resolve(b);
                else reject(new Error("toBlob returned null"));
              }, "image/png");
            };
            img.onerror = () => reject(new Error("Image load failed"));
            img.src = src;
          });
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
    } catch {
      // Fallback: noop — clipboard write may fail in some environments
    }
  }, []);

  // Open image in the ImageLightbox component already used in ChatMessage
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const handleChatContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isEditableContextMenuTarget(target)) return;

    e.preventDefault();
    if (!target) return;
    const imgEl = target.tagName === "IMG"
      ? (target as HTMLImageElement)
      : target.closest("img") as HTMLImageElement | null;
    const separator = nativeMenuSeparator();
    const items: NativeContextMenuItem[] = [];

    if (imgEl?.src) {
      const src = imgEl.src;
      items.push(
        createNativeContextMenuItem("bytro-chat-copy-image", t("chat.contextMenu.copyImage"), () => copyImageToClipboard(src)),
        createNativeContextMenuItem("bytro-chat-preview-image", t("chat.contextMenu.previewImage"), () => setLightboxSrc(src)),
        separator,
      );
    }

    items.push(
      createNativeContextMenuItem("bytro-chat-new-session", t("chat.contextMenu.newSession"), () => handleCreateSession()),
      createNativeContextMenuItem("bytro-chat-close-current", t("chat.contextMenu.closeCurrent"), () => {
        if (resolvedConversationId) {
          handleRemoveTab(resolvedConversationId);
        }
      }, { enabled: Boolean(resolvedConversationId) }),
      createNativeContextMenuItem("bytro-chat-new-terminal", t("chat.contextMenu.newTerminal"), () => {
        if (workspacePath) {
          useTerminalStore.getState().openPopup(workspacePath);
        }
      }, { enabled: Boolean(workspacePath) }),
      separator,
      createNativeContextMenuItem("bytro-chat-code-review", t("chat.contextMenu.codeReview"), () => {}),
      createNativeContextMenuItem("bytro-chat-open-diff", t("chat.contextMenu.openDiff"), toggleGitPanel),
    );

    popupNativeContextMenu("bytro-chat-context-menu", items, e.clientX, e.clientY).catch((err) => {
      console.error("Unable to open chat context menu:", err);
    });
  }, [copyImageToClipboard, handleCreateSession, handleRemoveTab, resolvedConversationId, t, toggleGitPanel, workspacePath]);

  const streaming = useChatStreaming({
    ...chatStreamingOptions,
    conversationId: resolvedConversationId,
    paneId,
  });

  // Auto-feed Vite compilation errors back to AI after each turn
  useViteErrorFeedback(isFocused ? streaming.handleSend : async () => {});

  const ensureConversationFocused = useCallback(async () => {
    if (!resolvedConversationId || resolvedConversationId === activeConversationId) {
      return;
    }
    await handleSelect(resolvedConversationId);
  }, [activeConversationId, handleSelect, resolvedConversationId]);

  const handleSend = useCallback(
    async (
      message: string,
      images?: Parameters<typeof streaming.handleSend>[1],
      displayContent?: string,
      modes?: ReadonlyArray<string>,
    ) => {
      await ensureConversationFocused();
      // Prepend element context to the user message when an element is selected
      let finalMsg = message;
      let finalDisplay = displayContent;
      if (selectedElement) {
        const elementCtx = formatElementPrompt(selectedElement);
        finalMsg = `${elementCtx}\n\n${message}`;
        if (finalDisplay) {
          finalDisplay = `${elementCtx}\n\n${finalDisplay}`;
        }
        clearSelectedElement();
      }

      // Prepend slide element context when a slide element is selected
      const slideEl = useSlideshowStore.getState().selectedSlideElement;
      if (slideEl) {
        const pageNum = slideEl.slideIndex + 1;
        // Build element description — specific bullet item or whole element
        const elDesc = slideEl.subIndex != null
          ? `${slideEl.elementType}元素中的第${slideEl.subIndex + 1}项: "${slideEl.textPreview}"`
          : `${slideEl.elementType}元素: "${slideEl.textPreview}"`;
        // AI instruction: use patch format — only return the modified slide
        const slideCtx = [
          `[用户选中了演示文稿第${pageNum}页的${elDesc}]`,
          `重要指令：请只输出第${pageNum}页的修改结果，使用以下 patch JSON 格式（不要输出完整的演示文稿）：`,
          "```slideshow",
          `{"slideIndex": ${slideEl.slideIndex}, "slide": {"layout": "...", "elements": [...], "icon": "..."}}`,
          "```",
          `slideIndex 从 0 开始，第${pageNum}页对应 slideIndex=${slideEl.slideIndex}。`,
          `请只修改被选中的${elDesc}，该页的其他元素保持不变。`,
        ].join("\n");
        finalMsg = `${slideCtx}\n\n${finalMsg}`;
        // Display version: use <slide-element/> marker for SlideElementChip rendering
        const displayMarker = `<slide-element page="${pageNum}" type="${slideEl.elementType}" text="${slideEl.textPreview}"/>`;
        finalDisplay = `${displayMarker}\n${finalDisplay ?? message}`;
        useSlideshowStore.getState().clearSlideElement();
      }

      // Prepend context file/dir paths (LLM reads content on demand via tools)
      const appState = useAppStore.getState();
      const ctxFiles = [...appState.contextFiles];
      const ctxDirs = [...appState.contextDirs];
      if (ctxFiles.length > 0 || ctxDirs.length > 0) {
        appState.clearContextFiles();
        const pathLines: string[] = [];
        for (const fp of ctxFiles) {
          pathLines.push(`- ${fp}`);
        }
        for (const dp of ctxDirs) {
          pathLines.push(`- ${dp}/`);
        }
        const pathCtx = `The user has attached the following files/directories as context. Read them as needed to answer the question:\n${pathLines.join("\n")}`;
        finalMsg = `${pathCtx}\n\n${finalMsg}`;
        // Display shows file/dir names only
        const names = [
          ...ctxDirs.map((dp) => `${dp.split(/[\\/]/).pop() ?? dp}/`),
          ...ctxFiles.map((fp) => fp.split(/[\\/]/).pop() ?? fp),
        ];
        const displayPrefix = `[Context: ${names.join(", ")}]`;
        finalDisplay = finalDisplay
          ? `${displayPrefix}\n${finalDisplay}`
          : `${displayPrefix}\n${message}`;
      }

      scrollToBottom();
      // Consume the one-shot display content for the initial auto-send prompt
      const display = initialDisplayContentRef.current;
      if (display) {
        initialDisplayContentRef.current = undefined;
        return streaming.handleSend(finalMsg, images, display, modes);
      }
      return streaming.handleSend(finalMsg, images, finalDisplay, modes);
    },
    [ensureConversationFocused, scrollToBottom, streaming, selectedElement, clearSelectedElement],
  );

  const handleSendMidStream = useCallback(
    async (...args: Parameters<typeof streaming.handleSendMidStream>) => {
      await ensureConversationFocused();
      scrollToBottom();
      return streaming.handleSendMidStream(...args);
    },
    [ensureConversationFocused, scrollToBottom, streaming],
  );

  const handleStop = useCallback(async () => {
    await ensureConversationFocused();
    return streaming.handleStop();
  }, [ensureConversationFocused, streaming]);

  // Retry a user message: resend the same content + images
  const handleRetry = useCallback(
    (content: string, media?: ReadonlyArray<{ readonly mediaType: string; readonly data: string }>, displayContent?: string) => {
      const images = media?.map((item, i) => ({
        id: `retry-${i}-${Date.now()}`,
        base64: item.data,
        mediaType: item.mediaType,
        preview: `data:${item.mediaType};base64,${item.data}`,
      }));
      handleSend(content, images, displayContent);
    },
    [handleSend],
  );

  // Track whether we should restore scroll position after prepending older messages.
  const prevMessageCountRef = useRef(messages.length);
  const prevScrollHeightRef = useRef(0);

  // Consume pending quick action prompt when the conversation changes
  // (from workspace quick actions, health-check fix, etc.).
  // Clear the pending action in useEffect to avoid mutating store during render,
  // which triggers "Cannot update a component while rendering" warnings.
  const initialPromptRef = useRef<string | null>(null);
  const initialDisplayContentRef = useRef<string | undefined>(undefined);
  const consumedConvIdRef = useRef<string | null | undefined>(undefined);
  // Records the conversation a prompt was *delivered to* (i.e. handed to
  // ChatInput as autoSendPrompt). When the user later switches to a different
  // conversation, we use this to clear the stale prompt and prevent it from
  // auto-firing again — see the health-check fix bug fixed alongside this code.
  const deliveredConvIdRef = useRef<string | null | undefined>(undefined);

  // Re-read pendingQuickAction on first render or when conversation changes.
  // This prevents stale prompts from being re-sent in new conversations.
  if (consumedConvIdRef.current === undefined || consumedConvIdRef.current !== resolvedConversationId) {
    const isFirstRead = consumedConvIdRef.current === undefined;
    consumedConvIdRef.current = resolvedConversationId;
    const pending = useAppStore.getState().pendingQuickAction;
    // A structured pending action may target a specific conversation. When set,
    // only the matching ChatPanel may consume it — otherwise the prompt would
    // bleed into whichever conversation happened to render first (this is the
    // root cause of the "fix issue → new session re-fires prompt" bug).
    const targetConvId = pending && typeof pending === "object" ? pending.conversationId : undefined;
    const targetMismatch = targetConvId !== undefined && targetConvId !== resolvedConversationId;

    console.warn("[build-auto-send][chat-panel] consume pending quick action", {
      resolvedConversationId,
      activeConversationId,
      pendingType: pending ? typeof pending : "null",
      hasStructuredPrompt: !!(pending && typeof pending === "object"),
      targetConvId,
      targetMismatch,
      promptLength: pending && typeof pending === "object"
        ? pending.prompt.length
        : typeof pending === "string"
        ? pending.length
        : 0,
    });

    if (pending && typeof pending === "object" && !targetMismatch) {
      initialPromptRef.current = pending.prompt;
      initialDisplayContentRef.current = pending.display;
    } else if (typeof pending === "string" && pending.length > 0) {
      initialPromptRef.current = pending;
      initialDisplayContentRef.current = undefined;
    } else if (isFirstRead) {
      // First mount with no pending — start clean.
      initialPromptRef.current = "";
      initialDisplayContentRef.current = undefined;
    } else if (
      deliveredConvIdRef.current !== undefined &&
      deliveredConvIdRef.current !== resolvedConversationId
    ) {
      // We previously delivered an autoSendPrompt to ChatInput for a different
      // conversation. Now that we've navigated to a new one, drop the stale ref
      // so ChatInput doesn't re-fire the same prompt (the input dedupes by
      // `${conversationId}::${prompt}`, so a new conv id with the same prompt
      // would otherwise trigger a fresh auto-send).
      initialPromptRef.current = "";
      initialDisplayContentRef.current = undefined;
      deliveredConvIdRef.current = null;
    }
    // Otherwise (pending is null, prompt not yet delivered, or targetMismatch):
    // keep the existing ref. This preserves the race-condition guard for the
    // initial-bind path where pane.conversationId may flip between renders
    // before ChatInput has actually scheduled the auto-send.
  }

  useEffect(() => {
    if (initialPromptRef.current) {
      console.warn("[build-auto-send][chat-panel] clearing pending quick action after binding", {
        resolvedConversationId,
        promptLength: initialPromptRef.current.length,
      });
      useAppStore.getState().setPendingQuickAction(null);
      // Record which conversation this prompt was delivered to. Future
      // conversation switches will use this to clear the stale ref.
      deliveredConvIdRef.current = resolvedConversationId;
    }
  }, [resolvedConversationId]);

  // Preserve scroll position when older messages are prepended.
  // Use useLayoutEffect to adjust scrollTop before the browser paints,
  // preventing visible flicker.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newCount = messages.length;
    const prevCount = prevMessageCountRef.current;

    // Only restore position when messages were prepended (count increased while
    // we were near the top — triggered by loadOlderMessages).
    if (newCount > prevCount && prevScrollHeightRef.current > 0) {
      const heightDelta = el.scrollHeight - prevScrollHeightRef.current;
      if (heightDelta > 0) {
        el.scrollTop += heightDelta;
      }
      // Reset snapshot so normal appends (streaming) don't trigger restoration.
      prevScrollHeightRef.current = 0;
    }

    prevMessageCountRef.current = newCount;
  }, [messages, scrollRef]);

  // Scroll-to-top detection: trigger loadOlderMessages when near the top.
  // Throttled to avoid firing on every scroll frame (~60Hz).
  const scrollThrottleRef = useRef(false);

  const handleScroll = useCallback(() => {
    if (scrollThrottleRef.current) return;
    scrollThrottleRef.current = true;

    requestAnimationFrame(() => {
      scrollThrottleRef.current = false;
      const el = scrollRef.current;
      if (!el || !hasMoreMessages || isLoadingOlder || !resolvedConversationId) {
        return;
      }

      if (el.scrollTop < SCROLL_TOP_THRESHOLD) {
        prevScrollHeightRef.current = el.scrollHeight;
        if (resolvedConversationId !== activeConversationId) {
          void handleSelect(resolvedConversationId);
          return;
        }
        loadOlderMessages(resolvedConversationId);
      }
    });
  }, [scrollRef, hasMoreMessages, isLoadingOlder, resolvedConversationId, activeConversationId, loadOlderMessages, handleSelect]);

  useEffect(() => {
    const el = scrollElement;
    if (!el) return;

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [scrollElement, handleScroll]);

  // Pre-compute which mid-stream / review-forward user messages should be
  // attached to which assistant message as inline injected notices.  This lets
  // the bubble of the AI message they arrived during render them as compact
  // strips at its bottom instead of breaking the bubble with an independent
  // full-width card.  A user message without a preceding assistant host falls
  // through and is rendered as the legacy independent card (handled by the
  // dispatcher in chat-message.tsx).
  const noticeAttachments = useMemo(() => {
    const hostByNotice = new Map<string, string>();
    const noticesByHost = new Map<string, InjectedNotice[]>();
    // Assistant messages that arrived right after one or more injectable user
    // messages were absorbed — they are the LLM's response to those mid-stream
    // injections, so visually they should appear as a continuation of the host
    // bubble (no avatar/name/timestamp re-printed) instead of a new bubble
    // breaking the conversation flow.
    const continuationIds = new Set<string>();
    // Host assistant messages that have at least one continuation following
    // them — used to suppress their own MessageActions / Timer / StreamingDots
    // so the strip and the continuation content sit flush against each other.
    const hostsWithContinuation = new Set<string>();
    let currentHost: string | null = null;
    let injectedSinceHost = false;

    for (const msg of messages) {
      // context_compacted and cliMissing are visible separators / cards in
      // their own right; once we cross one, any preceding host is no longer
      // visually adjacent so the next assistant must NOT be treated as a
      // continuation of it.
      if (msg.role === "system" && msg.content === "context_compacted") {
        currentHost = null;
        injectedSinceHost = false;
        continue;
      }
      if (msg.cliMissing) {
        currentHost = null;
        injectedSinceHost = false;
        continue;
      }

      const isInjectableUser =
        msg.role === "user" && (msg.midStream || msg.reviewForward);

      if (isInjectableUser) {
        if (currentHost) {
          hostByNotice.set(msg.id, currentHost);
          injectedSinceHost = true;
          const arr = noticesByHost.get(currentHost) ?? [];
          if (msg.reviewForward) {
            arr.push({
              id: msg.id,
              kind: "reviewForward",
              meta: msg.reviewForward,
              timestamp: msg.timestamp,
            });
          } else {
            arr.push({
              id: msg.id,
              kind: "midStream",
              content: msg.content,
              displayContent: msg.displayContent,
              timestamp: msg.timestamp,
              consumed: msg.midStreamConsumed === true,
            });
          }
          noticesByHost.set(currentHost, arr);
        }
        continue;
      }

      if (msg.role !== "user") {
        if (currentHost && injectedSinceHost) {
          continuationIds.add(msg.id);
          hostsWithContinuation.add(currentHost);
        }
        currentHost = msg.id;
        injectedSinceHost = false;
      } else {
        currentHost = null;
        injectedSinceHost = false;
      }
    }

    // Single source of truth for "what the chat actually shows": every
    // consumer (renderMessages, ChatOutline) must derive from this same
    // filtered list, otherwise outline dots would point at non-existent
    // DOM nodes and TimeDivider/lastTimestamp could be polluted by hidden
    // messages.  hostByNotice.has(id) is the absorption test — it
    // intentionally lets a leading mid-stream user msg with no AI host
    // fall through into both views as an independent card.
    const visibleMessages = messages.filter((m) => !hostByNotice.has(m.id));
    return {
      hostByNotice,
      noticesByHost,
      continuationIds,
      hostsWithContinuation,
      visibleMessages,
    };
  }, [messages]);

  const renderMessages = () => {
    const elements: React.ReactNode[] = [];
    const isConversationRunning = runState.isRunning;
    const streamingMessageId = runState.streamingMessageId;

    // Show a loading indicator at the top when fetching older messages
    if (isLoadingOlder) {
      elements.push(
        <div key="loading-older" className="flex items-center justify-center py-3">
          <div className="w-4 h-4 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-[12px] text-text-placeholder">{t("chat.loading")}</span>
        </div>
      );
    } else if (hasMoreMessages) {
      elements.push(
        <div key="has-more" className="flex items-center justify-center py-2">
          <span className="text-[11px] text-muted">{t("chat.scrollToLoadMore")}</span>
        </div>
      );
    }

    // Find the last assistant message to attach the turn duration after streaming ends
    const lastAssistantId = !isConversationRunning
      ? [...messages].reverse().find((m) => m.role !== "user")?.id
      : undefined;

    let lastTimestamp = 0;

    // Iterate the pre-filtered visible list so absorbed mid-stream /
    // review-forward user messages don't trigger TimeDivider insertions
    // or advance lastTimestamp — they are rendered inline inside their
    // host AI bubble and have no standalone position in the timeline.
    for (const msg of noticeAttachments.visibleMessages) {
      if (lastTimestamp > 0 && msg.timestamp - lastTimestamp > TIME_DIVIDER_GAP_MS) {
        elements.push(
          <TimeDivider key={`div-${msg.timestamp}`} timestamp={msg.timestamp} />
        );
      }

      // System break indicator for context compaction
      if (msg.role === "system" && msg.content === "context_compacted") {
        elements.push(
          <div key={msg.id} className="flex items-center gap-3 py-3 px-4 my-2">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[11px] text-muted whitespace-nowrap">
              {t("chat.contextCompacted")}
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>
        );
        lastTimestamp = msg.timestamp;
        continue;
      }

      const isMsgStreaming = isConversationRunning && msg.id === streamingMessageId;

      // Skip rendering empty streaming message (no text, no tool calls, and
      // no thinking) — AgentLoading will show instead
      const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
      const hasThinking = msg.thinkingBlocks && msg.thinkingBlocks.length > 0;
      if (isMsgStreaming && msg.content === "" && !hasToolCalls && !hasThinking) {
        lastTimestamp = msg.timestamp;
        continue;
      }

      // Render CLI missing prompt card instead of normal message
      if (msg.cliMissing) {
        elements.push(
          <CliMissingCard
            key={msg.id}
            displayName={msg.cliMissing.displayName}
          />
        );
        lastTimestamp = msg.timestamp;
        continue;
      }

      elements.push(
        <ChatMessage
          key={msg.id}
          id={msg.id}
          role={msg.role}
          content={msg.content}
          displayContent={msg.displayContent}
          modelTag={msg.agent}
          timestamp={msg.timestamp}
          isStreaming={isMsgStreaming}
          toolCalls={msg.toolCalls}
          media={msg.media}
          thinkingBlocks={msg.thinkingBlocks}
          midStream={msg.midStream}
          midStreamConsumed={msg.midStreamConsumed}
          commandInvocation={msg.commandInvocation}
          sentAsGoal={msg.sentAsGoal}
          reviewForward={msg.reviewForward}
          turnUsage={msg.turnUsage}
          injectedNotices={noticeAttachments.noticesByHost.get(msg.id)}
          isContinuation={noticeAttachments.continuationIds.has(msg.id)}
          hasContinuation={noticeAttachments.hostsWithContinuation.has(msg.id)}
          elapsedMs={isMsgStreaming ? runState.streamElapsedMs : undefined}
          turnDuration={!msg.turnUsage && msg.id === lastAssistantId && lastTurnDurationForPane != null ? lastTurnDurationForPane : undefined}
          onRetryMessage={msg.role === "user" && !isConversationRunning ? handleRetry : undefined}
        />
      );

      lastTimestamp = msg.timestamp;
    }

    // Show loading state when streaming and message has no content at all.
    // AgentLoading internally shows retry indicator inline when retrying.
    let agentLoadingShown = false;
    if (isConversationRunning && streamingMessageId) {
      const streamingMsg = messages.find((m) => m.id === streamingMessageId);
      const smHasToolCalls = streamingMsg?.toolCalls && streamingMsg.toolCalls.length > 0;
      const smHasThinking = streamingMsg?.thinkingBlocks && streamingMsg.thinkingBlocks.length > 0;
      if (streamingMsg && streamingMsg.content === "" && !smHasToolCalls && !smHasThinking) {
        elements.push(
          <AgentLoading
            key={`loading-${streamingMsg.role}`}
            role={streamingMsg.role}
            modelTag={streamingMsg.agent}
            retryAttempt={retryAttemptForPane}
            retryMaxAttempts={retryMaxAttemptsForPane}
            streamElapsed={runState.streamElapsedMs}
            streamPhase={runState.streamPhase}
          />
        );
        agentLoadingShown = true;
      }
    }

    // Show compact retry indicator after partial content (when AgentLoading is not shown)
    if (isConversationRunning && retryAttemptForPane !== null && retryMaxAttemptsForPane !== null && !agentLoadingShown) {
      elements.push(
        <StreamRetryBanner
          key="stream-retry"
          attempt={retryAttemptForPane}
          maxAttempts={retryMaxAttemptsForPane}
        />,
      );
    }

    return elements;
  };

  const isEmpty = messages.length === 0;
  const messageViewportPadding = isCompactPane ? "16px 16px 18px" : "20px 24px 120px";
  const inputContainerClassName = `floating-input-container ${isEmpty ? "floating-input-centered" : "floating-input-bottom"}${isCompactPane ? " floating-input-compact" : ""}`;
  const emptyStateClassName = `chat-empty-centered${isCompactPane ? " chat-empty-centered-compact" : ""}`;

  return (
    <div className="flex flex-1 flex-col h-full w-full min-w-0 overflow-hidden">
      {/* Node.js runtime status banner — shows during detection/download */}
      {isFocused && <NodeRuntimeBanner />}
      {/* Project memory banner — prompts user to create CLAUDE.md if missing */}
      {isFocused && <ProjectMemoryBanner />}
      {/* NOTE: ToolConfirmDialog / AskUserQuestionDialog are rendered inside
           floating-input-wrapper below to stay aligned with the chat input */}

      {/* Session tab bar — horizontal scrollable session tabs */}
      {!hideSessionTabs && <SessionTabBar />}

      {/* Main content area — chat messages */}
      <div
        ref={layoutRef}
        className="flex-1 relative overflow-hidden min-w-0"
        onContextMenu={!isFocused ? undefined : handleChatContextMenu}
      >
        <>
        {/* Agent status panel — draggable, floats above chat */}
        {isFocused && <AgentStatusPanel />}

        {isEmpty ? (
          /* ── Empty state: input centered on screen ── */
          <div className={emptyStateClassName}>
            <ChatEmptyState onSend={handleSend} />

            {/* Floating input — centered with content */}
            <div className={inputContainerClassName}>
              <div className="floating-input-wrapper">
                {/* Permission / question dialogs — inside wrapper to match input width */}
                {isFocused && <ToolConfirmDialog />}
                {isFocused && <AskUserQuestionDialog />}
                {/* Quote preview bar — inside wrapper to match input width */}
                {quotedText && (
                  <QuotePreviewBar quotedText={quotedText} onDismiss={handleDismissQuote} />
                )}
                {/* Selected element context pill */}
                {isFocused && selectedElement && (
                  <div style={{ padding: "0 0 4px" }}>
                    <ElementContextPill
                      tagName={selectedElement.tagName}
                      textContent={selectedElement.textContent}
                      onDismiss={handleDismissElement}
                    />
                  </div>
                )}
                {/* Selected slide element context pill */}
                {isFocused && selectedSlideElement && (
                  <div style={{ padding: "0 0 4px" }}>
                    <SlideElementPill
                      slideIndex={selectedSlideElement.slideIndex}
                      elementType={selectedSlideElement.elementType}
                      textPreview={selectedSlideElement.textPreview}
                      onDismiss={handleDismissSlideElement}
                    />
                  </div>
                )}
                {isFocused && <ContextFilesBar />}
                {isFocused && activeTurnDiff && turnDiffView !== "closed" && (
                  <TurnDiffBar diff={activeTurnDiff} onExpand={() => setTurnDiffView("modal")} />
                )}
                {isFocused && <FileListPanel />}
                <ChatInput
                  onSend={handleSend}
                  onStop={handleStop}
                  onSendMidStream={handleSendMidStream}
                  isStreaming={runState.isRunning}
                  autoSendPrompt={initialPromptRef.current || undefined}
                  quotedText={quotedText}
                  onClearQuote={handleDismissQuote}
                  conversationId={resolvedConversationId}
                  paneId={paneId}
                />
              </div>
            </div>
          </div>
        ) : (
          /* ── Has messages: normal scroll layout with input at bottom ── */
          <>
            <div
              key={scrollResetKey}
              ref={setScrollRef}
              className="chat-scroll-viewport h-full w-full overflow-y-auto overflow-x-hidden scrollbar-none"
              style={{ padding: messageViewportPadding }}
            >
              <div className="chat-messages-column">
                {renderMessages()}
              </div>
            </div>

            {/* Outline index — vertical rail with node dots for user messages */}
            <ChatOutline messages={noticeAttachments.visibleMessages} scrollContainerRef={scrollRef} />

            {/* Scroll to bottom floating button */}
            {!isAtBottom && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10
                  flex items-center justify-center w-8 h-8 rounded-full
                  bg-bg-secondary border border-border-default
                  text-text-secondary hover:text-text-primary hover:bg-bg-tertiary
                  shadow-md transition-colors duration-200 cursor-pointer"
                title={t("chat.scrollToBottom", "Scroll to bottom")}
              >
                <ArrowDown size={16} />
              </button>
            )}

            {/* Selection floating toolbar */}
            {isFocused && hasSelection && toolbarPosition && (
              <SelectionToolbar
                position={toolbarPosition}
                selectedText={selectedText}
                onQuote={handleQuote}
              />
            )}
          </>
        )}
        </>
      </div>

      {/* Floating centered input area — slides to bottom after first message */}
      {!isEmpty && (
        <div className={inputContainerClassName}>
          <div className="floating-input-wrapper">
            {/* Permission / question dialogs — inside wrapper to match input width */}
            {isFocused && <ToolConfirmDialog />}
            {isFocused && <AskUserQuestionDialog />}
            {/* Quote preview bar — inside wrapper to match input width */}
            {quotedText && (
              <QuotePreviewBar quotedText={quotedText} onDismiss={handleDismissQuote} />
            )}
            {/* Selected element context pill */}
            {isFocused && selectedElement && (
              <div style={{ padding: "0 0 4px" }}>
                <ElementContextPill
                  tagName={selectedElement.tagName}
                  textContent={selectedElement.textContent}
                  onDismiss={handleDismissElement}
                />
              </div>
            )}
            {/* Selected slide element context pill */}
            {isFocused && selectedSlideElement && (
              <div style={{ padding: "0 0 4px" }}>
                <SlideElementPill
                  slideIndex={selectedSlideElement.slideIndex}
                  elementType={selectedSlideElement.elementType}
                  textPreview={selectedSlideElement.textPreview}
                  onDismiss={handleDismissSlideElement}
                />
              </div>
            )}
            {isFocused && <ContextFilesBar />}
            {isFocused && activeTurnDiff && turnDiffView !== "closed" && (
              <TurnDiffBar diff={activeTurnDiff} onExpand={() => setTurnDiffView("modal")} />
            )}
            {isFocused && <FileListPanel />}
            {/* 实时 token 速率波形条(轻量,可折叠) */}
            {isFocused && <ChatTokenWave />}
            <ChatInput
              onSend={handleSend}
              onStop={handleStop}
              onSendMidStream={handleSendMidStream}
              isStreaming={runState.isRunning}
              quotedText={quotedText}
              onClearQuote={handleDismissQuote}
              conversationId={resolvedConversationId}
              paneId={paneId}
            />
          </div>
        </div>
      )}

      {/* Image lightbox — triggered from context menu "Preview Image" */}
      {isFocused && lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* Code review result modal — rendered outside the scroll container */}
      {isFocused && <ReviewModal onApply={handleSend} />}

      {/* Turn Diff viewer modal (Codex mode) */}
      {isFocused && activeTurnDiff && turnDiffView === "modal" && (
        <DiffViewerModal
          diff={activeTurnDiff}
          onMinimize={() => setTurnDiffView("minimized")}
          onRevertFile={
            fileMessageMap.size > 0
              ? async (filePath, kind, fileDiff) => {
                  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
                  const msgId = fileMessageMap.get(normalized);
                  if (!msgId) {
                    return { success: false, error: "Message not found for file" };
                  }
                  const { useChatStore } = await import("@/stores/chat-store");
                  const result = await useChatStore
                    .getState()
                    .revertSingleFile(msgId, filePath, kind, fileDiff);
                  if (result.success) {
                    setRevertedFileAtMsg((prev) => new Map([...prev, [normalized, msgId]]));
                  }
                  return result;
                }
              : undefined
          }
          revertedFiles={displayRevertedFiles}
        />
      )}
    </div>
  );
}
