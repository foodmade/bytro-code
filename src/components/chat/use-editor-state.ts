/**
 * Core editor state hook for the contentEditable chat input.
 *
 * Manages the editor DOM ref, text input state, auto-resize,
 * composition (IME) handlers, blur/paste behaviour, and reset.
 *
 * Also handles per-conversation draft persistence: when the active
 * conversation changes, the current editor text is saved and the new
 * conversation's draft (if any) is restored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { resizeImageIfNeeded } from "@/lib/image-resize";
import { updateEditorEmpty } from "./editor-helpers";

export interface PasteImagePayload {
  readonly base64: string;
  readonly mediaType: string;
  readonly preview: string;
}

export interface PasteTextPayload {
  readonly text: string;
}

interface UseEditorStateOptions {
  /** Callback invoked when an image is pasted from clipboard. */
  readonly onPasteImage?: (payload: PasteImagePayload) => void;
  /** Callback invoked when a long text paste should be represented outside the editor. */
  readonly onPasteLongText?: (payload: PasteTextPayload) => void;
  /** Active conversation ID — used to save/restore per-conversation drafts. */
  readonly conversationId?: string | null;
}

// ---------------------------------------------------------------------------
// Per-conversation draft storage (module-level, survives re-renders)
// ---------------------------------------------------------------------------
const _inputDrafts = new Map<string, string>();

/** Evict oldest drafts when the map grows beyond this size. */
const MAX_DRAFTS = 100;
const LONG_TEXT_PASTE_THRESHOLD = 2000;

function saveDraft(conversationId: string, text: string): void {
  if (text.trim()) {
    _inputDrafts.set(conversationId, text);
    // LRU eviction: delete oldest entries when over limit
    if (_inputDrafts.size > MAX_DRAFTS) {
      const oldest = _inputDrafts.keys().next().value;
      if (oldest !== undefined) _inputDrafts.delete(oldest);
    }
  } else {
    _inputDrafts.delete(conversationId);
  }
}

function loadDraft(conversationId: string): string {
  return _inputDrafts.get(conversationId) ?? "";
}

/** Clear the stored draft for a conversation (called after sending). */
function clearDraft(conversationId: string): void {
  _inputDrafts.delete(conversationId);
}

export function useEditorState(options?: UseEditorStateOptions) {
  const conversationId = options?.conversationId;
  const onPasteImage = options?.onPasteImage;
  const onPasteLongText = options?.onPasteLongText;
  // Initialize from draft if available (handles remount without conversationId change)
  const [input, setInput] = useState(() => {
    return conversationId ? loadDraft(conversationId) : "";
  });
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);
  const savedRangeRef = useRef<Range | null>(null);
  const submittedDraftRef = useRef<string | null>(null);

  // Auto-resize editor height to fit content (capped at 160px)
  const autoResize = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.style.height = "auto";
    editor.style.height = `${Math.min(editor.scrollHeight, 160)}px`;
  }, []);

  // IME composition start — immediately hide placeholder to prevent overlap
  // with the IME candidate popup. The placeholder will be restored (if needed)
  // in handleCompositionEnd via updateEditorEmpty().
  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
    const editor = editorRef.current;
    if (editor) {
      editor.removeAttribute("data-empty");
    }
  }, []);

  // Save selection range on blur for later restoration (e.g. skill chip insert)
  const handleEditorBlur = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  // Proactively save the current selection — call before the editor loses focus
  // (e.g. when a popup/menu steals focus). On macOS WebKit the selection may be
  // cleared before the blur event fires, so the blur handler alone is unreliable.
  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editorRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  // Paste handler — images go to callback, HTML is stripped to plain text
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((item) => item.type.startsWith("image/"));
      if (imageItems.length > 0) {
        e.preventDefault();
        for (const item of imageItems) {
          const file = item.getAsFile();
          if (!file) continue;
          resizeImageIfNeeded(file)
            .then(({ base64, mediaType, preview }) => {
              onPasteImage?.({ base64, mediaType, preview });
            })
            .catch(() => {
              // Fallback: use original file without resize
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = reader.result as string;
                const [header, b64] = dataUrl.split(",");
                const mt = header.match(/data:(.*?);/)?.[1] ?? "image/png";
                onPasteImage?.({ base64: b64, mediaType: mt, preview: dataUrl });
              };
              reader.readAsDataURL(file);
            });
        }
        return;
      }
      e.preventDefault();
      const plainText = e.clipboardData.getData("text/plain");
      if (plainText) {
        if (plainText.trim().length >= LONG_TEXT_PASTE_THRESHOLD && onPasteLongText) {
          onPasteLongText?.({ text: plainText });
          return;
        }
        document.execCommand("insertText", false, plainText);
        const editor = editorRef.current;
        if (editor) {
          autoResize();
          requestAnimationFrame(() => {
            editor.scrollTop = editor.scrollHeight;
          });
        }
      }
    },
    [autoResize, onPasteImage, onPasteLongText],
  );

  const shouldSkipDraftSave = useCallback((text: string) => {
    const submittedDraft = submittedDraftRef.current;
    return submittedDraft !== null && text === submittedDraft;
  }, []);

  const saveDraftUnlessSubmitted = useCallback(
    (id: string, text: string) => {
      if (shouldSkipDraftSave(text)) {
        clearDraft(id);
        return;
      }
      saveDraft(id, text);
    },
    [shouldSkipDraftSave],
  );

  // Clear editor content after sending
  const resetEditor = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      editor.textContent = "";
      updateEditorEmpty(editor);
      autoResize();
    }
  }, [autoResize]);

  // Optimistically clear the editor the moment the draft is submitted — the
  // send path can take seconds (sidecar cold start, git stats) and waiting
  // for it before clearing makes the input appear "stuck". If the send fails,
  // cancelSubmittedDraft restores the text.
  const markDraftSubmitted = useCallback(() => {
    const text = editorRef.current?.textContent ?? input;
    submittedDraftRef.current = text;
    setInput("");
    resetEditor();
    if (conversationId) clearDraft(conversationId);
  }, [conversationId, input, resetEditor]);

  const finalizeSubmittedDraft = useCallback(() => {
    // The editor was already cleared in markDraftSubmitted. Don't touch the
    // DOM here — the user may have started typing the next message while the
    // send was in flight.
    submittedDraftRef.current = null;
    if (conversationId) clearDraft(conversationId);
  }, [conversationId]);

  const cancelSubmittedDraft = useCallback(() => {
    const submitted = submittedDraftRef.current;
    submittedDraftRef.current = null;
    if (submitted === null) return;
    const editor = editorRef.current;
    // Restore the failed message, but only when the user hasn't typed
    // anything new since the optimistic clear.
    if (editor && (editor.textContent ?? "").trim() === "") {
      editor.textContent = submitted;
      updateEditorEmpty(editor);
      autoResize();
      setInput(submitted);
    }
    if (conversationId) saveDraft(conversationId, submitted);
  }, [conversationId, autoResize]);

  // Set initial placeholder state and restore draft content on mount
  useEffect(() => {
    const editor = editorRef.current;
    if (editor) {
      if (input) {
        editor.textContent = input;
        autoResize();
      }
      updateEditorEmpty(editor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save draft on unmount — only when the DOM is still alive.
  // If editorRef is null, React already removed the subtree and the
  // eager-save effect has already persisted the correct value.
  useEffect(() => {
    const editor = editorRef.current;
    return () => {
      const id = prevConversationIdRef.current;
      if (id && editor) {
        saveDraftUnlessSubmitted(id, editor.textContent ?? "");
      }
    };
  }, [saveDraftUnlessSubmitted]);

  // ── Per-conversation draft save/restore ──────────────────────────
  const prevConversationIdRef = useRef(conversationId);

  // Eagerly persist draft on every input change — ensures _inputDrafts
  // is always up-to-date BEFORE any potential unmount/remount occurs.
  // Skip when conversationId just changed — the SWITCH effect handles that.
  useEffect(() => {
    if (conversationId && conversationId === prevConversationIdRef.current) {
      saveDraftUnlessSubmitted(conversationId, input);
    }
  }, [conversationId, input, saveDraftUnlessSubmitted]);

  useEffect(() => {
    const prevId = prevConversationIdRef.current;
    if (prevId === conversationId) return;

    const editor = editorRef.current;

    // Save the outgoing conversation's draft (read from DOM for accuracy).
    if (prevId) {
      const currentText = editor?.textContent ?? input;
      saveDraftUnlessSubmitted(prevId, currentText);
    }

    // Restore the incoming conversation's draft
    const draft = conversationId ? loadDraft(conversationId) : "";
    setInput(draft);
    if (editor) {
      editor.textContent = draft;
      updateEditorEmpty(editor);
      autoResize();
    }

    prevConversationIdRef.current = conversationId;
  }, [conversationId, autoResize, input, saveDraftUnlessSubmitted]);

  return {
    input,
    setInput,
    editorRef,
    composingRef,
    compositionEndTimeRef,
    savedRangeRef,
    autoResize,
    handleCompositionStart,
    handleEditorBlur,
    saveSelection,
    handlePaste,
    resetEditor,
    markDraftSubmitted,
    finalizeSubmittedDraft,
    cancelSubmittedDraft,
  } as const;
}
