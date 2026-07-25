import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Paperclip, Mic, ArrowUp, Square, Settings, FileText, X } from "lucide-react";
import {
  useAgentStatusStore,
  useAppStore,
  useConversationStore,
  useSettingsStore,
  useSplitViewStore,
  useTeamsStore,
} from "@/stores";
import { useCompactMode } from "@/hooks";
import { VoiceInstallPopup } from "./voice-install-popup";

import { matchesShortcut, parseShortcuts, formatShortcut } from "@/lib/keyboard-shortcuts";
import { resolveAgentProviderForModel } from "@/lib/model-provider";
import { resolvePaneModel } from "@/lib/pane-model";
import { isPeakReasoningVisualActive } from "@/lib/reasoning-visuals";
import {
  SNIPPET_CHIP_ATTR,
  createSnippetChipElement,
  getEditorTextWithFileRefs,
  updateEditorEmpty,
} from "./editor-helpers";
import {
  LIVE_REVIEW_SEND_TO_CHAT_EVENT,
  type LiveReviewSendToChatDetail,
} from "@/lib/live-review-events";
import type { ChatInputProps } from "./chat-input-types";
import type { SelectionSnippet } from "./editor-helpers";
import { useChipManagement } from "./use-chip-management";
import { FileMentionDropdown } from "./file-mention-dropdown";
import { FileChip } from "./file-chip";
import { ImagePreview } from "./image-preview";
import { ModelSelector } from "./model-selector";
import { PermissionModeSelector } from "./permission-mode-selector";
import { AgentStatusBar } from "./agent-status-bar";
import { ContextUsageBar } from "./context-usage-bar";
import { SlashCommandDropdown } from "./slash-command-dropdown";
import { ChatSettingsMenu } from "./chat-settings-menu";
import { ImagegenSettingsButton } from "./imagegen-settings";
import { SkillsQuickButton } from "./skills-quick-menu";
import { TeamLaunchPanel } from "./team-launch-panel";
import { VoiceRecordingPanel } from "./voice-recording-panel";
import { CreativeModeButton, CreativeModeBadge } from "./creative-mode-button";
import { Tooltip } from "@/components/ui";
import { buildAttachedFilesPromptParts } from "./attachment-prompt";

// Extracted hooks
import { useVoiceSetup } from "./use-voice-setup";
import { useFileAttachments } from "./use-file-attachments";
import { SOLO_PANE_ID, type SplitPaneId } from "@/stores/split-view-store";
import { useEditorState } from "./use-editor-state";
import type { PasteImagePayload, PasteTextPayload } from "./use-editor-state";
import type { AttachedFile } from "./use-file-attachments";

const EDITOR_ADD_TO_CHAT_EVENT = "bytro:editor-add-to-chat";

interface EditorAddToChatDetail {
  readonly snippet: SelectionSnippet;
  readonly conversationId?: string;
}

const SELECTION_REF_RE =
  /<selection-ref\s+id="([^"]*?)"(?:\s+path="[^"]*?")?(?:\s+label="[^"]*?")?\s*\/>/g;

function decodeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function formatSelectionSnippetForPrompt(snippet: SelectionSnippet): string {
  const range = `${snippet.range.startLineNumber}:${snippet.range.startColumn}-${snippet.range.endLineNumber}:${snippet.range.endColumn}`;
  return `Selected text from ${snippet.filePath} (${range}):\n\n\`\`\`${snippet.language}\n${snippet.text}\n\`\`\``;
}

function expandSelectionSnippets(
  message: string,
  snippets: ReadonlyArray<SelectionSnippet>,
): string {
  if (snippets.length === 0) return message;
  const snippetsById = new Map(snippets.map((snippet) => [snippet.id, snippet]));
  return message.replace(SELECTION_REF_RE, (_, encodedId: string) => {
    const snippet = snippetsById.get(decodeAttr(encodedId));
    return snippet ? formatSelectionSnippetForPrompt(snippet) : "";
  });
}
// ---------------------------------------------------------------------------
// InputSettingsButton — gear icon with popup menu
// ---------------------------------------------------------------------------

interface InputSettingsButtonProps {
  readonly conversationId?: string | null;
  readonly paneId?: string;
}

const InputSettingsButton = memo(function InputSettingsButton({
  conversationId,
  paneId,
}: InputSettingsButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Tooltip content={t("chat.chatPreferences")} placement="top">
        <button
          onClick={toggle}
          className="text-muted hover:text-muted-foreground transition-colors cursor-pointer"
          style={open ? { color: "var(--color-accent-purple)" } : undefined}
          aria-label={t("chat.chatPreferences")}
        >
          <Settings size={16} />
        </button>
      </Tooltip>
      {open && <ChatSettingsMenu onClose={close} conversationId={conversationId} paneId={paneId} />}
    </>
  );
});

interface PastedTextPreviewProps {
  readonly file: AttachedFile;
  readonly onRemove: () => void;
}

function PastedTextPreview({ file, onRemove }: PastedTextPreviewProps) {
  const { t } = useTranslation();
  const title = file.preview || t("chat.pastedText.title");

  return (
    <div className="pasted-text-preview">
      <div className="pasted-text-preview__icon" aria-hidden>
        <FileText size={18} />
      </div>
      <div className="pasted-text-preview__body">
        <div className="pasted-text-preview__title" title={title}>
          {title}
        </div>
        <div className="pasted-text-preview__meta">{t("chat.pastedText.label")}</div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="pasted-text-preview__remove"
        aria-label={t("chat.pastedText.remove")}
        title={t("chat.pastedText.remove")}
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatInput — main component
// ---------------------------------------------------------------------------

export const ChatInput = memo(function ChatInput({
  onSend,
  onStop,
  onSendMidStream,
  isStreaming = false,
  autoSendPrompt,
  quotedText,
  onClearQuote,
  conversationId,
  paneId,
}: ChatInputProps) {
  const { t } = useTranslation();
  const onSendRef = useRef(onSend);
  const compactSubmitPendingRef = useRef(false);
  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  // Team launch panel
  const isLaunchPanelOpen = useTeamsStore((s) => s.isLaunchPanelOpen);
  const closeLaunchPanel = useTeamsStore((s) => s.closeLaunchPanel);

  // Creative mode — drives the imagegen settings entry visibility
  const creativeMode = useAppStore((s) => s.creativeMode);

  // Keyboard shortcuts
  const shortcutsJson = useSettingsStore((s) => s.keyboardShortcuts);
  const shortcuts = useMemo(() => parseShortcuts(shortcutsJson), [shortcutsJson]);

  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const platforms = useSettingsStore((s) => s.platforms);
  const conversationModel = useConversationStore((s) =>
    conversationId ? s.conversations.find((c) => c.id === conversationId)?.model : undefined,
  );
  const draftPaneModel = useSplitViewStore((s) => (paneId ? s.draftPaneModels[paneId] : undefined));
  const skillsProvider = useMemo(
    () =>
      resolveAgentProviderForModel({
        activePlatformId,
        platforms,
        conversationModel,
        draftPaneModel,
      }),
    [activePlatformId, platforms, conversationModel, draftPaneModel],
  );

  const resolvedModelId = resolvePaneModel({
    paneId: (paneId as SplitPaneId | null | undefined) ?? null,
    conversationId: conversationId ?? null,
  }).modelId;

  // Peak reasoning reuses the UltraCode input-frame visuals without changing
  // either provider's request semantics.
  const claudeUltracodeEnabled = useSettingsStore(
    (s) => s.platformModelOptions.claude.ultracodeEnabled,
  );
  const reasoningLevel = useSettingsStore((s) => s.reasoningLevel);
  const isPeakVisualActive = isPeakReasoningVisualActive({
    sdk: skillsProvider,
    modelId: resolvedModelId,
    reasoningLevel,
    ultracodeEnabled: claudeUltracodeEnabled,
  });

  // ---------------------------------------------------------------------------
  // Extracted hooks
  // ---------------------------------------------------------------------------

  // Use state + callback ref so the ResizeObserver re-attaches when the
  // toolbar DOM is unmounted/remounted (e.g. on voice recording toggle).
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const isCompact = useCompactMode(toolbarEl, 400);

  const attachments = useFileAttachments();

  // Drag-and-drop for files dropped from the OS.
  //
  // macOS WKWebView never delivers HTML5 file drop events to the webview —
  // even with Tauri's drag handler disabled, WKWebView swallows them.
  // The only working channel is Tauri's `onDragDropEvent`, which delivers
  // absolute paths but at the *window* level (not per-element), and whose
  // `position` field is unreliable on macOS / when DevTools is open.
  //
  // We therefore route every drop to the **active pane's** ChatInput
  // instead of doing pixel-precise hit testing. Single-pane mode (no
  // explicit paneId, or SOLO pane) always accepts.
  const activePaneId = useSplitViewStore((s) => s.activePaneId);
  const isDropTarget = !paneId || paneId === SOLO_PANE_ID || paneId === activePaneId;
  const isDropTargetRef = useRef(isDropTarget);
  const paneIdRef = useRef(paneId);
  const activePaneIdRef = useRef(activePaneId);
  const [isDragOver, setIsDragOver] = useState(false);
  useEffect(() => {
    paneIdRef.current = paneId;
    activePaneIdRef.current = activePaneId;
    isDropTargetRef.current = isDropTarget;
    // If we lose target ownership mid-drag (e.g. user switched panes via a
    // keyboard shortcut after enter/over fired), clear our overlay so it
    // doesn't get stuck waiting for a leave/drop we'd otherwise ignore.
    if (!isDropTarget) setIsDragOver(false);
  }, [activePaneId, isDropTarget, paneId]);

  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      try {
        const off = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;

          // Always clear local drag-over state on leave/drop regardless of
          // routing — covers the case where target ownership changed
          // mid-drag and the early-return below would otherwise leak the
          // overlay state. (false→false setState is a no-op in React.)
          if (payload.type === "leave" || payload.type === "drop") {
            setIsDragOver(false);
          }

          // Routing: only the active pane's ChatInput consumes the drop.
          if (!isDropTargetRef.current) {
            return;
          }

          if (payload.type === "enter" || payload.type === "over") {
            setIsDragOver(true);
          } else if (payload.type === "drop" && payload.paths.length > 0) {
            attachmentsRef.current.addFromTauriPaths(payload.paths).catch(() => {
              console.warn("[chat-input] dropped attachments could not be added");
            });
          }
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        console.warn("[chat-input] drag-and-drop listener registration failed");
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const handlePasteImage = useCallback(
    ({ base64, mediaType, preview }: PasteImagePayload) => {
      attachments.addPastedImage(base64, mediaType, preview);
    },
    [attachments],
  );

  const handlePasteLongText = useCallback(
    ({ text }: PasteTextPayload) => {
      attachments.addPastedText(text);
    },
    [attachments],
  );

  const editor = useEditorState({
    onPasteImage: handlePasteImage,
    onPasteLongText: handlePasteLongText,
    conversationId,
  });
  const editorSubmittedActionsRef = useRef({
    markDraftSubmitted: editor.markDraftSubmitted,
    finalizeSubmittedDraft: editor.finalizeSubmittedDraft,
    cancelSubmittedDraft: editor.cancelSubmittedDraft,
  });
  const latestEditorInputRef = useRef(editor.input);
  const latestEditorRef = useRef(editor.editorRef);
  useEffect(() => {
    editorSubmittedActionsRef.current = {
      markDraftSubmitted: editor.markDraftSubmitted,
      finalizeSubmittedDraft: editor.finalizeSubmittedDraft,
      cancelSubmittedDraft: editor.cancelSubmittedDraft,
    };
  }, [editor.markDraftSubmitted, editor.finalizeSubmittedDraft, editor.cancelSubmittedDraft]);
  useEffect(() => {
    latestEditorInputRef.current = editor.input;
    latestEditorRef.current = editor.editorRef;
  }, [editor.input, editor.editorRef]);

  const chips = useChipManagement({
    editorRef: editor.editorRef,
    composingRef: editor.composingRef,
    compositionEndTimeRef: editor.compositionEndTimeRef,
    savedRangeRef: editor.savedRangeRef,
    autoResize: editor.autoResize,
    setInput: editor.setInput,
    conversationId,
    paneId,
  });

  const voice = useVoiceSetup({
    editorRef: editor.editorRef,
    autoResize: editor.autoResize,
    setInput: editor.setInput,
  });

  useEffect(() => {
    const handleEditorAddToChat = (event: Event) => {
      const detail = (event as CustomEvent<EditorAddToChatDetail>).detail;
      const snippet = detail?.snippet;
      const editorEl = editor.editorRef.current;
      const activeConvId = useConversationStore.getState().activeConversationId;
      const ownerConvId = conversationId ?? activeConvId;
      if (!snippet || !editorEl) return;
      if (detail.conversationId && detail.conversationId !== ownerConvId) return;

      const existing = editorEl.querySelector(`[${SNIPPET_CHIP_ATTR}="${CSS.escape(snippet.id)}"]`);
      if (existing) return;

      const chip = createSnippetChipElement(snippet);
      editorEl.focus();
      if (editorEl.childNodes.length > 0) {
        editorEl.appendChild(document.createTextNode("\n"));
      }
      editorEl.appendChild(chip);
      editorEl.appendChild(document.createTextNode(" "));
      chips.setSelectionSnippets((prev) =>
        prev.some((s) => s.id === snippet.id) ? prev : [...prev, snippet],
      );
      editor.setInput(getEditorTextWithFileRefs(editorEl));
      updateEditorEmpty(editorEl);
      editor.autoResize();
      requestAnimationFrame(() => {
        editorEl.scrollTop = editorEl.scrollHeight;
      });
    };

    window.addEventListener(EDITOR_ADD_TO_CHAT_EVENT, handleEditorAddToChat);
    return () => window.removeEventListener(EDITOR_ADD_TO_CHAT_EVENT, handleEditorAddToChat);
  }, [conversationId, editor, chips]);

  // ── Live Reviewer → main chat forward ───────────────────────────────────
  // The reviewer panel dispatches a window-level event when the user clicks
  // "Send to chat" on a review card.  We forward the prompt via the regular
  // send pipeline (mid-stream when the chat is already streaming, otherwise
  // a fresh turn) and attach the structured `reviewForward` metadata so the
  // chat bubble renders as a compact card instead of a wall of markdown.
  // Only the ChatInput owning the active conversation handles the event.
  useEffect(() => {
    const handleInject = (e: Event) => {
      const detail = (e as CustomEvent<LiveReviewSendToChatDetail>).detail;
      if (!detail || !detail.prompt || !detail.meta) return;

      const activeConvId = useConversationStore.getState().activeConversationId;
      const ownerConvId = conversationId ?? activeConvId;
      if (ownerConvId !== detail.conversationId && ownerConvId !== activeConvId) {
        return;
      }

      const metadata = { reviewForward: detail.meta };
      if (isStreaming && onSendMidStream) {
        onSendMidStream(detail.prompt, undefined, undefined, undefined, metadata);
      } else {
        onSendRef.current(detail.prompt, undefined, undefined, undefined, metadata);
      }
    };

    window.addEventListener(LIVE_REVIEW_SEND_TO_CHAT_EVENT, handleInject);
    return () => {
      window.removeEventListener(LIVE_REVIEW_SEND_TO_CHAT_EVENT, handleInject);
    };
  }, [conversationId, isStreaming, onSendMidStream]);

  // ---------------------------------------------------------------------------
  // Session init effects
  // ---------------------------------------------------------------------------

  const autoSendKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSendPrompt) {
      autoSendKeyRef.current = null;
      return;
    }
    const autoSendKey = `${conversationId ?? "draft"}::${autoSendPrompt}`;
    if (autoSendKeyRef.current === autoSendKey) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        autoSendKeyRef.current = autoSendKey;
        void (async () => {
          const currentText =
            latestEditorRef.current.current?.textContent ?? latestEditorInputRef.current;
          const shouldManageDraft = !currentText.trim() || currentText === autoSendPrompt;
          const draftActions = editorSubmittedActionsRef.current;
          if (shouldManageDraft) draftActions.markDraftSubmitted();
          try {
            const result = await onSendRef.current(autoSendPrompt);
            if (!shouldManageDraft) return;
            if (result === false) {
              draftActions.cancelSubmittedDraft();
              return;
            }
            draftActions.finalizeSubmittedDraft();
          } catch {
            if (shouldManageDraft) draftActions.cancelSubmittedDraft();
            console.error("[chat-input] automatic send failed");
          }
        })();
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [autoSendPrompt, conversationId, isStreaming]);

  // ---------------------------------------------------------------------------
  // Submit handlers
  // ---------------------------------------------------------------------------

  const handleMidStreamSubmit = useCallback(async () => {
    const trimmed = editor.input.trim();
    if (
      !trimmed &&
      chips.mentionedFiles.length === 0 &&
      chips.selectionSnippets.length === 0 &&
      attachments.pastedImages.length === 0 &&
      attachments.attachedFiles.length === 0
    )
      return;
    if (!onSendMidStream) return;

    const editorEl = editor.editorRef.current;
    const textWithRefs =
      editorEl && (chips.mentionedFiles.length > 0 || chips.selectionSnippets.length > 0)
        ? getEditorTextWithFileRefs(editorEl).trim()
        : trimmed;

    let finalMessage = textWithRefs;
    let displayContent = textWithRefs;

    if (chips.mentionedFiles.length > 0) {
      try {
        const FILE_REF_RE = /<file-ref\s+path="([^"]*?)"\s+kind="([^"]*?)"\/>/g;
        const fileContents = new Map<string, string>();
        const MAX_FILE_CHARS = 30_000;

        await Promise.all(
          chips.mentionedFiles.map(async (f) => {
            const escapedPath = f.path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            if (f.isDir) {
              const entries = await invoke<ReadonlyArray<{ name: string; is_dir: boolean }>>(
                "read_dir_entries",
                { path: f.path },
              );
              const listing = entries
                .map((e) => `${e.is_dir ? "[dir]  " : "[file] "}${e.name}`)
                .join("\n");
              fileContents.set(
                escapedPath,
                `<directory path="${escapedPath}">\n${listing}\n</directory>`,
              );
            } else {
              let content = await invoke<string>("read_file_content", { path: f.path });
              if (content.length > MAX_FILE_CHARS) {
                content =
                  content.slice(0, MAX_FILE_CHARS) +
                  `\n...(truncated, ${content.length} chars total)`;
              }
              fileContents.set(escapedPath, `<file path="${escapedPath}">\n${content}\n</file>`);
            }
          }),
        );

        finalMessage = textWithRefs.replace(FILE_REF_RE, (_, path: string) => {
          return fileContents.get(path) ?? "";
        });
        displayContent = textWithRefs;
      } catch {
        finalMessage = trimmed;
        displayContent = trimmed;
      }
    }

    finalMessage = expandSelectionSnippets(finalMessage, chips.selectionSnippets);

    if (attachments.attachedFiles.length > 0) {
      const { promptPrefix, displayPrefix } = buildAttachedFilesPromptParts(
        attachments.attachedFiles,
      );
      finalMessage = promptPrefix ? `${promptPrefix}\n\n${finalMessage}` : finalMessage;
      displayContent = displayPrefix ? `${displayPrefix} ${displayContent}` : displayContent;
    }

    if (quotedText) {
      const quoteBlock = quotedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      finalMessage = `${quoteBlock}\n\n${finalMessage}`;
      displayContent = `${quoteBlock}\n\n${displayContent}`;
    }

    const hasInlineRefs =
      chips.mentionedFiles.length > 0 ||
      chips.selectionSnippets.length > 0 ||
      attachments.attachedFiles.length > 0;
    const midStreamImages =
      attachments.pastedImages.length > 0 ? attachments.pastedImages : undefined;
    editor.markDraftSubmitted();
    let result: boolean | void;
    try {
      result = await onSendMidStream(
        finalMessage,
        midStreamImages,
        hasInlineRefs ? displayContent : undefined,
        undefined,
      );
    } catch (error) {
      editor.cancelSubmittedDraft();
      throw error;
    }
    if (result === false) {
      editor.cancelSubmittedDraft();
      return;
    }

    editor.finalizeSubmittedDraft();
    chips.setMentionedFiles([]);
    chips.setSelectionSnippets([]);
    attachments.clearAll();
    onClearQuote?.();
  }, [editor, onSendMidStream, quotedText, onClearQuote, attachments, chips]);

  const handleSubmit = useCallback(async () => {
    const trimmed = editor.input.trim();
    if (
      !trimmed &&
      chips.mentionedFiles.length === 0 &&
      chips.selectionSnippets.length === 0 &&
      attachments.pastedImages.length === 0 &&
      attachments.attachedFiles.length === 0
    )
      return;
    if (isStreaming) return;

    const editorEl = editor.editorRef.current;
    const textWithRefs =
      editorEl && (chips.mentionedFiles.length > 0 || chips.selectionSnippets.length > 0)
        ? getEditorTextWithFileRefs(editorEl).trim()
        : trimmed;

    let finalMessage = textWithRefs;
    let displayContent = textWithRefs;

    if (chips.mentionedFiles.length > 0) {
      try {
        const FILE_REF_RE = /<file-ref\s+path="([^"]*?)"\s+kind="([^"]*?)"\/>/g;
        const fileContents = new Map<string, string>();
        // Per-file content limit: ~30K chars (~8.5K tokens). Prevents a single
        // large file from blowing up the prompt and triggering "Prompt is too long".
        const MAX_FILE_CHARS = 30_000;

        await Promise.all(
          chips.mentionedFiles.map(async (f) => {
            const escapedPath = f.path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            if (f.isDir) {
              const entries = await invoke<ReadonlyArray<{ name: string; is_dir: boolean }>>(
                "read_dir_entries",
                { path: f.path },
              );
              const listing = entries
                .map((e) => `${e.is_dir ? "[dir]  " : "[file] "}${e.name}`)
                .join("\n");
              fileContents.set(
                escapedPath,
                `<directory path="${escapedPath}">\n${listing}\n</directory>`,
              );
            } else {
              let content = await invoke<string>("read_file_content", { path: f.path });
              if (content.length > MAX_FILE_CHARS) {
                content =
                  content.slice(0, MAX_FILE_CHARS) +
                  `\n...(truncated, ${content.length} chars total)`;
              }
              fileContents.set(escapedPath, `<file path="${escapedPath}">\n${content}\n</file>`);
            }
          }),
        );

        finalMessage = textWithRefs.replace(FILE_REF_RE, (_, path: string) => {
          return fileContents.get(path) ?? "";
        });
        displayContent = textWithRefs;
      } catch {
        finalMessage = trimmed;
        displayContent = trimmed;
      }
    }

    finalMessage = expandSelectionSnippets(finalMessage, chips.selectionSnippets);

    if (attachments.attachedFiles.length > 0) {
      const { promptPrefix, displayPrefix } = buildAttachedFilesPromptParts(
        attachments.attachedFiles,
      );
      finalMessage = promptPrefix ? `${promptPrefix}\n\n${finalMessage}` : finalMessage;
      displayContent = displayPrefix ? `${displayPrefix} ${displayContent}` : displayContent;
    }

    if (quotedText) {
      const quoteBlock = quotedText
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      finalMessage = `${quoteBlock}\n\n${finalMessage}`;
      displayContent = `${quoteBlock}\n\n${displayContent}`;
    }

    const hasInlineRefs =
      chips.mentionedFiles.length > 0 ||
      chips.selectionSnippets.length > 0 ||
      attachments.attachedFiles.length > 0;
    editor.markDraftSubmitted();
    let result: boolean | void;
    try {
      result = await onSend(
        finalMessage,
        attachments.pastedImages.length > 0 ? attachments.pastedImages : undefined,
        hasInlineRefs ? displayContent : undefined,
        undefined,
      );
    } catch (error) {
      editor.cancelSubmittedDraft();
      throw error;
    }
    if (result === false) {
      editor.cancelSubmittedDraft();
      return;
    }

    editor.finalizeSubmittedDraft();
    chips.setMentionedFiles([]);
    chips.setSelectionSnippets([]);
    attachments.clearAll();
    onClearQuote?.();
  }, [editor, isStreaming, onSend, chips, attachments, quotedText, onClearQuote]);

  // ---------------------------------------------------------------------------
  // Keyboard handler (delegates dropdown navigation to chips hook)
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || editor.composingRef.current) return;

      // macOS WebKit: the Enter keydown confirming an IME candidate may arrive
      // after composingRef has already been cleared by the RAF in compositionEnd.
      // A 100ms cooldown window prevents this cross-frame race from sending.
      if (e.key === "Enter" && Date.now() - editor.compositionEndTimeRef.current < 100) {
        return;
      }

      if (chips.handleDropdownKeyDown(e)) return;
      if (chips.handleBackspaceChip(e)) return;

      if (isStreaming && matchesShortcut(e.nativeEvent, shortcuts.midStreamSend)) {
        e.preventDefault();
        handleMidStreamSubmit();
        return;
      }
      if (matchesShortcut(e.nativeEvent, shortcuts.newline)) {
        e.preventDefault();
        document.execCommand("insertLineBreak");
        const editorEl = editor.editorRef.current;
        if (editorEl) {
          editor.setInput(getEditorTextWithFileRefs(editorEl));
          editor.autoResize();
        }
        return;
      }
      if (matchesShortcut(e.nativeEvent, shortcuts.voiceInput)) {
        e.preventDefault();
        voice.handleMicClick();
        return;
      }
      if (matchesShortcut(e.nativeEvent, shortcuts.sendMessage)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [editor, chips, isStreaming, shortcuts, handleSubmit, handleMidStreamSubmit, voice],
  );

  const handleButtonClick = useCallback(() => {
    if (isStreaming && onStop) onStop();
    else handleSubmit();
  }, [isStreaming, onStop, handleSubmit]);

  const handleCompactClick = useCallback(async () => {
    const agentStore = useAgentStatusStore.getState();
    const compacting = agentStore.compacting;
    if (
      compactSubmitPendingRef.current ||
      (compacting?.active &&
        (!compacting.conversationId || compacting.conversationId === conversationId))
    )
      return;

    compactSubmitPendingRef.current = true;
    agentStore.setCompacting("manual", 0, conversationId, isStreaming && !!onSendMidStream);
    try {
      const result =
        isStreaming && onSendMidStream
          ? await onSendMidStream("/compact")
          : await onSend("/compact");

      if (result === false) {
        useAgentStatusStore.getState().clearCompacting(conversationId, true);
      }
    } catch (err) {
      useAgentStatusStore.getState().clearCompacting(conversationId, true);
      throw err;
    } finally {
      compactSubmitPendingRef.current = false;
    }
  }, [conversationId, isStreaming, onSend, onSendMidStream]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const pastedTextFiles = useMemo(
    () => attachments.attachedFiles.filter((file) => file.source === "pasted-text"),
    [attachments.attachedFiles],
  );
  const regularAttachedFiles = useMemo(
    () => attachments.attachedFiles.filter((file) => file.source !== "pasted-text"),
    [attachments.attachedFiles],
  );
  const canSend =
    isStreaming ||
    !!editor.input.trim() ||
    chips.mentionedFiles.length > 0 ||
    chips.selectionSnippets.length > 0 ||
    attachments.pastedImages.length > 0 ||
    attachments.attachedFiles.length > 0;

  return (
    <div className="flex flex-col shrink-0 min-w-0" style={{ gap: 12 }}>
      <AgentStatusBar conversationId={conversationId} />

      <div className="flex items-end min-w-0" style={{ position: "relative" }}>
        <div className="flex-1 relative min-w-0" style={{ zIndex: 1 }}>
          {!voice.isVoiceRecording &&
            (isPeakVisualActive ? (
              <div className={`ultracode-border-glow${isStreaming ? " streaming" : ""}`}>
                <div className="streaming-border-mask" />
              </div>
            ) : (
              <div className={`streaming-border-glow${isStreaming ? " active" : ""}`}>
                <div className="streaming-border-mask" />
              </div>
            ))}

          <div
            ref={chips.mentionWrapperRef}
            className={`flex flex-col min-w-0 chat-input-glass${isStreaming ? " chat-input-streaming" : ""}${isDragOver ? " chat-input-drag-over" : ""}${isPeakVisualActive ? " chat-input-ultracode" : ""}`}
            style={{ gap: 8, position: "relative" }}
          >
            {isDragOver && (
              <div aria-hidden className="chat-input-drop-overlay">
                <span className="chat-input-drop-overlay-text">{t("chat.dropFilesHere")}</span>
              </div>
            )}

            {isLaunchPanelOpen && <TeamLaunchPanel onClose={closeLaunchPanel} />}

            {chips.dropdown.mentionShow && chips.cwdPath && (
              <FileMentionDropdown
                query={chips.dropdown.mentionQuery}
                rootPath={chips.cwdPath}
                onSelect={chips.handleFileSelect}
                onNavigateDir={chips.handleNavigateInto}
                activeIndex={chips.dropdown.mentionIndex}
                navigateTo={chips.mentionNavigateTo}
                onFilteredEntriesChange={chips.handleFilteredEntriesChange}
              />
            )}

            {chips.dropdown.slashShow && chips.slashCommands.length > 0 && (
              <div ref={chips.slashWrapperRef}>
                <SlashCommandDropdown
                  query={chips.dropdown.slashQuery}
                  commands={chips.slashCommands}
                  activeIndex={chips.dropdown.slashIndex}
                  onSelect={chips.handleSlashSelect}
                  onFilteredItemsChange={chips.handleFilteredSlashItemsChange}
                  onResetIndex={chips.handleSlashResetIndex}
                />
              </div>
            )}

            <ImagePreview
              images={attachments.pastedImages}
              onRemove={attachments.handleRemoveImage}
            />

            {pastedTextFiles.length > 0 && (
              <div className="pasted-text-preview-list">
                {pastedTextFiles.map((file) => (
                  <PastedTextPreview
                    key={file.id}
                    file={file}
                    onRemove={() => attachments.handleRemoveAttachedFile(file.id)}
                  />
                ))}
              </div>
            )}

            {voice.isVoiceRecording ? (
              <VoiceRecordingPanel
                registerBar={voice.registerBar}
                interimText={voice.voiceInput.interimText}
                durationMs={voice.voiceInput.durationMs}
                onToggleRecording={voice.voiceInput.toggleRecording}
                onAttachClick={attachments.handleAttachClick}
              />
            ) : (
              <>
                {regularAttachedFiles.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {regularAttachedFiles.map((f) => (
                      <FileChip
                        key={f.id}
                        name={f.name}
                        onRemove={() => attachments.handleRemoveAttachedFile(f.id)}
                      />
                    ))}
                  </div>
                )}

                <div
                  ref={editor.editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={chips.handleInput}
                  onKeyDown={handleKeyDown}
                  onCompositionStart={editor.handleCompositionStart}
                  onCompositionEnd={chips.handleCompositionEnd}
                  onPaste={editor.handlePaste}
                  onClick={chips.handleEditorClick}
                  onBlur={editor.handleEditorBlur}
                  data-placeholder={
                    voice.isVoiceProcessing
                      ? t("chat.voiceTranscribing")
                      : isStreaming
                        ? t("chat.midStreamHint")
                        : t("chat.inputPlaceholder")
                  }
                  data-empty="true"
                  className="inline-editor w-full bg-transparent text-[14px] text-foreground font-sans outline-none resize-none overflow-y-auto"
                  style={{
                    minHeight: 20,
                    maxHeight: 160,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: "20px",
                  }}
                />

                <div ref={setToolbarEl} className="flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center shrink-0 relative" style={{ gap: 8 }}>
                    <input
                      ref={attachments.fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={attachments.handleFileInputChange}
                    />
                    <CreativeModeButton conversationId={conversationId} paneId={paneId} />
                    <Tooltip content={t("chat.attachFiles")} placement="top">
                      <button
                        onClick={attachments.handleAttachClick}
                        className="text-muted hover:text-muted-foreground transition-colors cursor-pointer"
                        aria-label={t("chat.attachFiles")}
                      >
                        <Paperclip size={16} />
                      </button>
                    </Tooltip>
                    <div className="relative flex items-center">
                      <Tooltip
                        content={
                          voice.autoLoading
                            ? t("chat.voiceModelLoading")
                            : voice.isVoiceProcessing
                              ? t("chat.voiceTranscribing")
                              : `${t("chat.voiceInput")} (${formatShortcut(shortcuts.voiceInput)})`
                        }
                        placement="top"
                      >
                        <button
                          onClick={voice.handleMicClick}
                          disabled={voice.isVoiceProcessing || voice.autoLoading}
                          className={[
                            "transition-colors cursor-pointer hover:opacity-100",
                            voice.isVoiceProcessing || voice.autoLoading
                              ? "animate-pulse"
                              : "opacity-60",
                          ].join(" ")}
                          style={{ color: "var(--color-accent-purple)" }}
                          aria-label={t("chat.voiceInput")}
                        >
                          <Mic size={16} />
                        </button>
                      </Tooltip>
                      {voice.showInstallPopup && (
                        <VoiceInstallPopup
                          onClose={voice.handleInstallPopupClose}
                          onReady={voice.handleInstallPopupReady}
                        />
                      )}
                    </div>
                    <SkillsQuickButton
                      provider={skillsProvider}
                      onSelect={chips.handleSkillQuickSelect}
                      onBeforeOpen={editor.saveSelection}
                    />
                    <InputSettingsButton conversationId={conversationId} paneId={paneId} />
                    {creativeMode === "imagegen" && (
                      <ImagegenSettingsButton conversationId={conversationId} paneId={paneId} />
                    )}
                    <CreativeModeBadge />
                  </div>

                  <div className="flex items-center gap-1 min-w-0">
                    <PermissionModeSelector compact={isCompact} />
                    <ModelSelector
                      compact={isCompact}
                      conversationId={conversationId}
                      paneId={paneId}
                    />
                    <ContextUsageBar
                      conversationId={conversationId}
                      onCompact={handleCompactClick}
                    />
                    <button
                      onClick={handleButtonClick}
                      aria-label={isStreaming ? t("chat.stopGeneration") : t("chat.sendMessage")}
                      disabled={!canSend}
                      className={`flex items-center justify-center shrink-0 btn-morph${isStreaming ? " btn-stop-pulse" : ""}`}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 15,
                        background: isStreaming
                          ? "linear-gradient(135deg, var(--color-accent-danger), color-mix(in srgb, var(--color-accent-danger) 78%, var(--color-surface-dark)))"
                          : canSend
                            ? "linear-gradient(135deg, var(--color-accent-purple), color-mix(in srgb, var(--color-accent-purple) 72%, var(--color-surface-dark)))"
                            : "color-mix(in srgb, var(--color-foreground) 6%, transparent)",
                        border: "none",
                        cursor: canSend ? "pointer" : "default",
                        transition: isStreaming
                          ? "none"
                          : "background 0.2s ease, transform 0.2s ease, opacity 0.2s ease",
                        transform: isStreaming ? undefined : canSend ? "scale(1)" : "scale(0.9)",
                        opacity: canSend ? 1 : 0.4,
                      }}
                    >
                      {isStreaming ? (
                        <Square size={14} style={{ color: "var(--color-on-accent)" }} />
                      ) : (
                        <ArrowUp
                          size={14}
                          style={{
                            color: canSend ? "var(--color-on-accent)" : "var(--color-muted)",
                            transition: "color 0.2s ease",
                          }}
                        />
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className={`voice-border-glow${voice.isVoiceRecording ? " active" : ""}`}>
            <div className="streaming-border-mask" />
          </div>
        </div>
      </div>
    </div>
  );
});
