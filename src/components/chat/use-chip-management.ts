/**
 * Hook for managing @mention file chips, /slash commands, and skill chips
 * in the contentEditable chat input.
 *
 * Handles:
 * - Dropdown state (useReducer) for @mention and /slash
 * - File mention selection, navigation, and removal
 * - Slash command selection and filtering
 * - Skill chip insertion
 * - Editor input parsing for trigger detection
 * - IME composition end (with trigger detection)
 * - Click-to-remove chip handling
 * - Keyboard navigation within dropdowns (arrow/enter/escape)
 * - Backspace chip deletion
 * - Filesystem effects (cwd, slash command scanning)
 * - Click-outside dismissal
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useClickOutside } from "@/hooks";
import { useFileTreeStore, useWorkspaceStore, useToolStateStore, useAppStore, useSettingsStore, useConversationStore, useSplitViewStore } from "@/stores";
import { resolveAgentProviderForModel } from "@/lib/model-provider";
import { getBuiltinSlashCommands, mergeSlashCommands } from "@/lib/slash-command-builtins";
import { getClientSlashCommands } from "@/lib/client-slash-commands";
import { parseMentionTrigger, parseSlashTrigger } from "./input-parsers";
import {
  CHIP_ATTR,
  SKILL_CHIP_ATTR,
  SNIPPET_CHIP_ATTR,
  getEditorText,
  getEditorCursorPos,
  setEditorSelection,
  createChipElement,
  createSkillChipElement,
  chipBeforeCursor,
  updateEditorEmpty,
} from "./editor-helpers";
import type { MentionedFile, SelectionSnippet } from "./editor-helpers";
import type { DirEntry } from "@/types";
import type { SlashItemType, SlashDropdownItem } from "./slash-command-dropdown";
import { dropdownReducer, DROPDOWN_INITIAL } from "./chat-input-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseChipManagementOptions {
  readonly editorRef: React.RefObject<HTMLDivElement | null>;
  readonly composingRef: React.MutableRefObject<boolean>;
  readonly compositionEndTimeRef: React.MutableRefObject<number>;
  readonly savedRangeRef: React.MutableRefObject<Range | null>;
  readonly autoResize: () => void;
  readonly setInput: (text: string) => void;
  readonly conversationId?: string | null;
  readonly paneId?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChipManagement({
  editorRef,
  composingRef,
  compositionEndTimeRef,
  savedRangeRef,
  autoResize,
  setInput,
  conversationId,
  paneId,
}: UseChipManagementOptions) {
  // Dropdown state
  const mentionWrapperRef = useRef<HTMLDivElement>(null);
  const slashWrapperRef = useRef<HTMLDivElement>(null);
  const [dropdown, dispatchDropdown] = useReducer(dropdownReducer, DROPDOWN_INITIAL);

  // Mention state
  const [mentionedFiles, setMentionedFiles] = useState<ReadonlyArray<MentionedFile>>([]);
  const [selectionSnippets, setSelectionSnippets] = useState<ReadonlyArray<SelectionSnippet>>([]);
  const [mentionNavigateTo, setMentionNavigateTo] = useState<string | null>(null);
  const [filteredEntries, setFilteredEntries] = useState<ReadonlyArray<DirEntry>>([]);

  // Slash state — commands are bucketed by platformId in the store. The
  // dropdown shows only the active platform's commands so switching models
  // (Claude ⇄ Codex ⇄ Gemini) immediately swaps the visible command set.
  const [filteredSlashCommands, setFilteredSlashCommands] = useState<ReadonlyArray<SlashDropdownItem>>([]);
  const slashCommandsByPlatform = useToolStateStore((s) => s.slashCommandsByPlatform);

  // CWD resolution
  const [fallbackCwd, setFallbackCwd] = useState("");
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path);
  const explorerRootPath = useFileTreeStore((s) => s.rootPath);
  const cwdPath = workspacePath ?? explorerRootPath ?? fallbackCwd;
  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const platforms = useSettingsStore((s) => s.platforms);
  const conversationModel = useConversationStore((s) => (
    conversationId ? s.conversations.find((c) => c.id === conversationId)?.model : undefined
  ));
  const draftPaneModel = useSplitViewStore((s) => (
    paneId ? s.draftPaneModels[paneId] : undefined
  ));

  const slashPlatform = useMemo(() => resolveAgentProviderForModel({
    activePlatformId,
    platforms,
    conversationModel,
    draftPaneModel,
  }), [
    activePlatformId,
    platforms,
    conversationModel,
    draftPaneModel,
  ]);

  // Client commands sit at the bottom of the merge so a platform that can
  // execute the same command itself (e.g. Codex's prompt-expanded /status)
  // overrides the local fallback — mirroring the dispatcher's SDK-first order.
  const slashCommands = useMemo(
    () => mergeSlashCommands(
      mergeSlashCommands(getClientSlashCommands(), getBuiltinSlashCommands(slashPlatform)),
      slashPlatform ? slashCommandsByPlatform[slashPlatform] ?? [] : [],
    ),
    [slashCommandsByPlatform, slashPlatform],
  );

  // RAF refs for debounced dropdown detection and composition end
  const dropdownRafRef = useRef(0);
  const compositionRafRef = useRef(0);

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  useEffect(() => {
    invoke<string>("get_cwd")
      .then(setFallbackCwd)
      .catch(() => {});
  }, []);

  // Scan filesystem for slash commands (provider-aware). Writes are bucketed
  // under the active platformId so each model maintains its own list.
  // Existing entries (typically the SDK-provided ones for Claude) are merged:
  // filesystem-scanned descriptions take precedence when the .md file has one,
  // otherwise the existing description is preserved.
  useEffect(() => {
    if (!slashPlatform) return;
    let cancelled = false;
    const platformId = slashPlatform;
    invoke<ReadonlyArray<{ name: string; description: string; argumentHint?: string; aliases?: ReadonlyArray<string> }>>("scan_slash_commands", {
      cwd: cwdPath || undefined,
      provider: platformId,
    })
      .then((fsCommands) => {
        if (cancelled) return;
        const toolStore = useToolStateStore.getState();
        const existing = toolStore.getSlashCommandsForPlatform(platformId);
        const merged = new Map(existing.map((c) => [c.name, c]));
        for (const c of fsCommands) {
          const trimmed = c.description.trim();
          const prev = merged.get(c.name);
          merged.set(c.name, {
            name: c.name,
            description: trimmed || prev?.description || "",
            argumentHint: c.argumentHint ?? prev?.argumentHint,
            aliases: c.aliases ?? prev?.aliases,
            source: "filesystem",
          });
        }
        toolStore.setSlashCommandsForPlatform(
          platformId,
          Array.from(merged.values()),
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwdPath, slashPlatform]);

  useEffect(() => {
    setMentionNavigateTo(null);
  }, [explorerRootPath]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(dropdownRafRef.current);
      cancelAnimationFrame(compositionRafRef.current);
    };
  }, []);

  // Click-outside dismissal — stable callbacks to avoid listener churn
  const closeMention = useCallback(() => dispatchDropdown({ type: "MENTION_CLOSE" }), []);
  const closeSlash = useCallback(() => dispatchDropdown({ type: "SLASH_CLOSE" }), []);
  useClickOutside(mentionWrapperRef, closeMention, dropdown.mentionShow);
  useClickOutside(slashWrapperRef, closeSlash, dropdown.slashShow);

  // -------------------------------------------------------------------------
  // Dropdown trigger detection (shared by handleInput + handleCompositionEnd)
  // -------------------------------------------------------------------------

  const detectTriggers = useCallback((text: string, cursorPos: number) => {
    const mentionTrigger = parseMentionTrigger(text, cursorPos);
    if (mentionTrigger) {
      dispatchDropdown({ type: "MENTION_OPEN", query: mentionTrigger.query });
      return;
    }
    dispatchDropdown({ type: "MENTION_CLOSE" });

    const slashTrigger = parseSlashTrigger(text, cursorPos);
    if (slashTrigger && slashCommands.length > 0) {
      dispatchDropdown({ type: "SLASH_OPEN", query: slashTrigger.query });
    } else {
      dispatchDropdown({ type: "SLASH_CLOSE" });
    }
  }, [slashCommands.length]);

  // -------------------------------------------------------------------------
  // Editor input handler
  // -------------------------------------------------------------------------

  const handleInput = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (composingRef.current) {
      autoResize();
      return;
    }

    const text = getEditorText(editor);
    const cursorPos = getEditorCursorPos(editor);
    setInput(text);
    updateEditorEmpty(editor, text);
    autoResize();

    cancelAnimationFrame(dropdownRafRef.current);
    dropdownRafRef.current = requestAnimationFrame(() => {
      detectTriggers(text, cursorPos);
    });
  }, [editorRef, composingRef, autoResize, setInput, detectTriggers]);

  // IME composition end (with trigger detection)
  const handleCompositionEnd = useCallback(() => {
    // Synchronously record the timestamp before scheduling RAF.
    // On macOS WebKit, the Enter keydown confirming an IME candidate may
    // arrive after the RAF clears composingRef, causing the message to send.
    // The timestamp lets handleKeyDown apply a 100ms cooldown window.
    compositionEndTimeRef.current = Date.now();
    compositionRafRef.current = requestAnimationFrame(() => {
      composingRef.current = false;
      const editor = editorRef.current;
      if (!editor) return;
      const text = getEditorText(editor);
      setInput(text);
      updateEditorEmpty(editor, text);
      const cursorPos = getEditorCursorPos(editor);
      detectTriggers(text, cursorPos);
    });
  }, [editorRef, composingRef, compositionEndTimeRef, setInput, detectTriggers]);

  // -------------------------------------------------------------------------
  // File mention handlers
  // -------------------------------------------------------------------------

  const handleFileSelect = useCallback(
    (file: { path: string; name: string; isDir?: boolean }) => {
      const editor = editorRef.current;
      if (!editor) return;

      // Directories are added to the context bar (ContextFilesBar) instead of
      // being inserted as inline chips. This matches the design where clicking
      // the FolderPlus icon adds a folder to the persistent context area.
      if (file.isDir) {
        // Remove the @trigger text from the editor if present
        const text = getEditorText(editor);
        const cursorPos = getEditorCursorPos(editor);
        const trigger = parseMentionTrigger(text, cursorPos);
        if (trigger) {
          // Use cursorPos as end to include any trailing NBSP that
          // parseMentionTrigger may have trimmed from the query
          setEditorSelection(editor, trigger.atIndex, cursorPos);
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            sel.getRangeAt(0).deleteContents();
          }
        }
        useAppStore.getState().addContextDir(file.path);
        setInput(getEditorText(editor));
        updateEditorEmpty(editor);
        dispatchDropdown({ type: "MENTION_CLOSE" });
        setMentionNavigateTo(null);
        autoResize();
        editor.focus();
        return;
      }

      const existing = editor.querySelector(`[${CHIP_ATTR}="${CSS.escape(file.path)}"]`);
      if (existing) return;

      const text = getEditorText(editor);
      const cursorPos = getEditorCursorPos(editor);
      const trigger = parseMentionTrigger(text, cursorPos);

      if (trigger) {
        // Use cursorPos as end to include any trailing NBSP that
        // parseMentionTrigger may have trimmed from the query
        setEditorSelection(editor, trigger.atIndex, cursorPos);
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          sel.getRangeAt(0).deleteContents();
        }
      }

      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const chip = createChipElement(file);
        range.insertNode(chip);
        range.setStartAfter(chip);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      setMentionedFiles((prev) => {
        if (prev.some((f) => f.path === file.path)) return prev;
        return [...prev, { path: file.path, name: file.name, isDir: file.isDir }];
      });
      setInput(getEditorText(editor));
      updateEditorEmpty(editor);
      dispatchDropdown({ type: "MENTION_CLOSE" });
      setMentionNavigateTo(null);
      autoResize();
      editor.focus();
    },
    [editorRef, autoResize, setInput],
  );

  const handleRemoveFile = useCallback((path: string) => {
    const editor = editorRef.current;
    if (editor) {
      const chip = editor.querySelector(`[${CHIP_ATTR}="${CSS.escape(path)}"]`);
      if (chip) chip.remove();
      setInput(getEditorText(editor));
      updateEditorEmpty(editor);
      autoResize();
    }
    setMentionedFiles((prev) => prev.filter((f) => f.path !== path));
  }, [editorRef, autoResize, setInput]);

  const handleNavigateInto = useCallback((dirPath: string) => {
    const editor = editorRef.current;
    if (editor) {
      const text = getEditorText(editor);
      const cursorPos = getEditorCursorPos(editor);
      const trigger = parseMentionTrigger(text, cursorPos);
      if (trigger && trigger.query.length > 0) {
        // Use cursorPos as end to include any trailing NBSP; keep @ (atIndex + 1)
        setEditorSelection(editor, trigger.atIndex + 1, cursorPos);
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          sel.getRangeAt(0).deleteContents();
        }
        setInput(getEditorText(editor));
      }
    }
    dispatchDropdown({ type: "MENTION_UPDATE_QUERY", query: "" });
    dispatchDropdown({ type: "MENTION_SET_INDEX", index: 0 });
    setMentionNavigateTo(dirPath);
  }, [editorRef, setInput]);

  // -------------------------------------------------------------------------
  // Editor click handler (chip close buttons)
  // -------------------------------------------------------------------------

  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const closeBtn = target.closest(".chip-close-btn");
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const fileChip = closeBtn.closest(`[${CHIP_ATTR}]`);
      if (fileChip) {
        const path = fileChip.getAttribute(CHIP_ATTR)!;
        handleRemoveFile(path);
        return;
      }
      const snippetChip = closeBtn.closest(`[${SNIPPET_CHIP_ATTR}]`);
      if (snippetChip) {
        const id = snippetChip.getAttribute(SNIPPET_CHIP_ATTR);
        snippetChip.remove();
        if (id) setSelectionSnippets((prev) => prev.filter((s) => s.id !== id));
        const editor = editorRef.current;
        if (editor) {
          setInput(getEditorText(editor));
          updateEditorEmpty(editor);
          autoResize();
        }
        return;
      }
      const skillChip = closeBtn.closest(`[${SKILL_CHIP_ATTR}]`);
      if (skillChip) {
        skillChip.remove();
        const editor = editorRef.current;
        if (editor) {
          setInput(getEditorText(editor));
          updateEditorEmpty(editor);
          autoResize();
        }
      }
    }
  }, [editorRef, handleRemoveFile, autoResize, setInput]);

  // -------------------------------------------------------------------------
  // Slash command handlers
  // -------------------------------------------------------------------------

  const handleSlashSelect = useCallback(
    (command: string, _type: SlashItemType = "command") => {
      const editor = editorRef.current;
      if (editor) {
        editor.focus();
        const text = getEditorText(editor);
        const cursorPos = getEditorCursorPos(editor);
        const trigger = parseSlashTrigger(text, cursorPos);
        if (trigger) {
          setEditorSelection(editor, trigger.slashIndex, trigger.slashIndex + 1 + trigger.query.length);
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(`/${command} `);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          setInput(getEditorText(editor));
          updateEditorEmpty(editor);
          autoResize();
        }
      }
      dispatchDropdown({ type: "SLASH_CLOSE" });
    },
    [editorRef, autoResize, setInput],
  );

  const handleFilteredEntriesChange = useCallback(
    (entries: ReadonlyArray<DirEntry>) => setFilteredEntries(entries),
    [],
  );

  const handleFilteredSlashItemsChange = useCallback(
    (items: ReadonlyArray<SlashDropdownItem>) => setFilteredSlashCommands(items),
    [],
  );

  const handleSlashResetIndex = useCallback(() => {
    dispatchDropdown({ type: "SLASH_SET_INDEX", index: 0 });
  }, []);

  // -------------------------------------------------------------------------
  // Skill quick-select (from SkillsQuickButton)
  // -------------------------------------------------------------------------

  const handleSkillQuickSelect = useCallback(
    (skillName: string) => {
      const editor = editorRef.current;
      if (!editor) return;

      const existing = editor.querySelector(`[${SKILL_CHIP_ATTR}="${CSS.escape(skillName)}"]`);
      if (existing) return;

      editor.focus();
      const sel = window.getSelection();
      if (sel) {
        if (savedRangeRef.current && editor.contains(savedRangeRef.current.startContainer)) {
          sel.removeAllRanges();
          sel.addRange(savedRangeRef.current);
        }
        if (sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const chip = createSkillChipElement(skillName);
          range.insertNode(chip);
          range.setStartAfter(chip);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        savedRangeRef.current = null;
      }
      setInput(getEditorText(editor));
      updateEditorEmpty(editor);
      autoResize();
    },
    [editorRef, savedRangeRef, autoResize, setInput],
  );

  // -------------------------------------------------------------------------
  // Keyboard navigation (returns true if event was handled)
  // -------------------------------------------------------------------------

  /** Handle dropdown arrow/enter/escape navigation. Returns true if consumed. */
  const handleDropdownKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      // Mention dropdown navigation
      if (dropdown.mentionShow) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          dispatchDropdown({ type: "MENTION_SET_INDEX", index: Math.max(0, dropdown.mentionIndex - 1) });
          return true;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          dispatchDropdown({ type: "MENTION_SET_INDEX", index: Math.min(filteredEntries.length - 1, dropdown.mentionIndex + 1) });
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const entry = filteredEntries[dropdown.mentionIndex];
          if (entry) {
            if (entry.is_dir) handleNavigateInto(entry.path);
            else handleFileSelect({ path: entry.path, name: entry.name });
          }
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          dispatchDropdown({ type: "MENTION_CLOSE" });
          setMentionNavigateTo(null);
          return true;
        }
      }

      // Slash dropdown navigation
      if (dropdown.slashShow) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          dispatchDropdown({ type: "SLASH_SET_INDEX", index: Math.max(0, dropdown.slashIndex - 1) });
          return true;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          dispatchDropdown({ type: "SLASH_SET_INDEX", index: Math.min(filteredSlashCommands.length - 1, dropdown.slashIndex + 1) });
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const cmd = filteredSlashCommands[dropdown.slashIndex];
          if (cmd) handleSlashSelect(cmd.name, cmd.itemType);
          return true;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          dispatchDropdown({ type: "SLASH_CLOSE" });
          return true;
        }
      }

      return false;
    },
    [
      dropdown.mentionShow, dropdown.slashShow,
      dropdown.mentionIndex, dropdown.slashIndex,
      filteredEntries, filteredSlashCommands,
      handleFileSelect, handleNavigateInto, handleSlashSelect,
    ],
  );

  /** Handle Backspace on an adjacent chip. Returns true if consumed. */
  const handleBackspaceChip = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (e.key !== "Backspace") return false;
      const editor = editorRef.current;
      if (!editor) return false;
      const chip = chipBeforeCursor();
      if (!chip) return false;

      e.preventDefault();
      if (chip.hasAttribute(CHIP_ATTR)) {
        const path = chip.getAttribute(CHIP_ATTR)!;
        chip.remove();
        setMentionedFiles((prev) => prev.filter((f) => f.path !== path));
      } else if (chip.hasAttribute(SNIPPET_CHIP_ATTR)) {
        const id = chip.getAttribute(SNIPPET_CHIP_ATTR)!;
        chip.remove();
        setSelectionSnippets((prev) => prev.filter((s) => s.id !== id));
      } else {
        chip.remove();
      }
      setInput(getEditorText(editor));
      updateEditorEmpty(editor);
      autoResize();
      return true;
    },
    [editorRef, autoResize, setInput],
  );

  return {
    // Dropdown state
    dropdown,
    mentionWrapperRef,
    slashWrapperRef,
    // Mention state
    mentionedFiles,
    setMentionedFiles,
    selectionSnippets,
    setSelectionSnippets,
    mentionNavigateTo,
    filteredEntries,
    cwdPath,
    // Slash state
    slashCommands,
    filteredSlashCommands,
    // Handlers
    handleInput,
    handleCompositionEnd,
    handleEditorClick,
    handleFileSelect,
    handleNavigateInto,
    handleFilteredEntriesChange,
    handleSlashSelect,
    handleFilteredSlashItemsChange,
    handleSlashResetIndex,
    handleSkillQuickSelect,
    // Keyboard
    handleDropdownKeyDown,
    handleBackspaceChip,
  } as const;
}
