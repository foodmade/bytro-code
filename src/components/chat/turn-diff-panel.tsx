import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  GitCompare,
  Search,
  Maximize2,
  Minimize2,
  X,
  FileCode,
  Copy,
  Check,
  CheckCircle2,
  ChevronUp,
  ScanSearch,
  Loader2,
  Undo2,
} from "lucide-react";
import hljs from "highlight.js/lib/common";
import { useFileChangesStore, useConversationStore, useWorkspaceStore } from "@/stores";
import { parseGitDiffHeader, parsePatchPathLine } from "@/lib/diff-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UnifiedDiffLine {
  readonly type: "header" | "file" | "hunk" | "added" | "removed" | "context";
  readonly text: string;
  /** Old line number (for context/removed lines) */
  readonly oldNum?: number;
  /** New line number (for context/added lines) */
  readonly newNum?: number;
}

interface FileDiffSection {
  readonly filePath: string;
  readonly lines: readonly UnifiedDiffLine[];
  readonly added: number;
  readonly removed: number;
  /** "M" modified, "A" added, "D" deleted */
  readonly kind: "M" | "A" | "D";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** 将绝对路径转为相对于工作区的路径 */
function toRelativePath(filePath: string, workspacePath: string): string {
  if (!filePath || !workspacePath) return filePath;
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedWs = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedWs + "/")) {
    return normalizedFile.slice(normalizedWs.length + 1);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseFileSections(diff: string): readonly FileDiffSection[] {
  const rawLines = diff.split("\n");
  const sections: FileDiffSection[] = [];
  let current: {
    filePath: string;
    lines: UnifiedDiffLine[];
    added: number;
    removed: number;
    kind: "M" | "A" | "D";
  } | null = null;
  let oldNum = 0;
  let newNum = 0;

  for (const raw of rawLines) {
    if (raw.startsWith("diff ")) {
      if (current) sections.push(current);
      const header = parseGitDiffHeader(raw);
      current = {
        filePath: header?.b !== "/dev/null" ? (header?.b ?? "unknown") : (header?.a ?? "unknown"),
        lines: [],
        added: 0,
        removed: 0,
        kind: header?.a === "/dev/null" ? "A" : header?.b === "/dev/null" ? "D" : "M",
      };
      oldNum = 0;
      newNum = 0;
      continue;
    }

    if (!current) {
      current = { filePath: "changes", lines: [], added: 0, removed: 0, kind: "M" };
    }

    if (raw.startsWith("new file mode ")) {
      current.kind = "A";
      continue;
    }

    if (raw.startsWith("deleted file mode ")) {
      current.kind = "D";
      continue;
    }

    if (
      raw.startsWith("index ") ||
      raw.startsWith("similarity index ") ||
      raw.startsWith("old mode ") ||
      raw.startsWith("new mode ")
    ) {
      continue;
    }

    const patchPath = parsePatchPathLine(raw);
    if (patchPath) {
      if (
        patchPath !== "/dev/null" &&
        (current.filePath === "changes" || current.filePath === "unknown")
      ) {
        current.filePath = patchPath;
      }

      // Detect new file (--- /dev/null) or deleted file (+++ /dev/null)
      if (raw.startsWith("--- ") && patchPath === "/dev/null") current.kind = "A";
      if (raw.startsWith("+++ ") && patchPath === "/dev/null") current.kind = "D";
      continue;
    }

    if (raw.startsWith("@@")) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldNum = parseInt(hunkMatch[1], 10);
        newNum = parseInt(hunkMatch[2], 10);
      }
      current.lines.push({ type: "hunk", text: raw });
      continue;
    }

    if (raw.startsWith("-")) {
      current.lines.push({ type: "removed", text: raw.slice(1), oldNum });
      current.removed++;
      oldNum++;
    } else if (raw.startsWith("+")) {
      current.lines.push({ type: "added", text: raw.slice(1), newNum });
      current.added++;
      newNum++;
    } else {
      // Context line (starts with space or is empty)
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      current.lines.push({ type: "context", text, oldNum, newNum });
      oldNum++;
      newNum++;
    }
  }
  if (current) sections.push(current);
  return sections;
}

function computeTotalStats(sections: readonly FileDiffSection[]): {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
  readonly newFiles: number;
  readonly deleted: number;
} {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let newFiles = 0;
  let deleted = 0;
  for (const s of sections) {
    added += s.added;
    removed += s.removed;
    if (s.kind === "A") newFiles++;
    else if (s.kind === "D") deleted++;
    else modified++;
  }
  return { files: sections.length, added, removed, modified, newFiles, deleted };
}

// ---------------------------------------------------------------------------
// Syntax highlighting helpers
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  cs: "csharp",
  r: "r",
  lua: "lua",
  perl: "perl",
  pl: "perl",
};

function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return undefined;
}

function useHighlightedLines(
  lines: readonly UnifiedDiffLine[],
  filePath: string,
): Map<number, string> {
  return useMemo(() => {
    const lang = getLanguageFromPath(filePath);
    const result = new Map<number, string>();
    if (!lang || !hljs.getLanguage(lang)) return result;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.type === "hunk" || !line.text) continue;
      try {
        const highlighted = hljs.highlight(line.text, {
          language: lang,
          ignoreIllegals: true,
        });
        result.set(i, highlighted.value);
      } catch {
        /* fallback to plain text */
      }
    }
    return result;
  }, [lines, filePath]);
}

// ---------------------------------------------------------------------------
// Kind badge color
// ---------------------------------------------------------------------------

function kindColor(kind: "M" | "A" | "D"): string {
  switch (kind) {
    case "A":
      return "var(--color-accent-green)";
    case "D":
      return "#EF4444";
    default:
      return "var(--color-accent-amber)";
  }
}

// ---------------------------------------------------------------------------
// FileListItem — sidebar file entry
// ---------------------------------------------------------------------------

function FileListItem({
  section,
  active,
  onClick,
  onRevert,
  isReverting,
  isConfirming,
  reverted,
}: {
  readonly section: FileDiffSection;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly onRevert?: () => void;
  readonly isReverting?: boolean;
  readonly isConfirming?: boolean;
  readonly reverted?: boolean;
}) {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const relativePath = toRelativePath(section.filePath, workspacePath);
  const fileName = relativePath.split(/[/\\]/).pop() ?? relativePath;

  return (
    <div
      className="group flex items-center w-full transition-colors"
      style={{
        padding: "0 4px 0 0",
        backgroundColor: active ? "var(--color-border-subtle)" : "transparent",
        opacity: reverted ? 0.5 : 1,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        style={{
          padding: "8px 12px",
          border: "none",
          outline: "none",
          cursor: "pointer",
          background: "none",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 700,
            color: reverted ? "var(--color-filelist-revert)" : kindColor(section.kind),
            flexShrink: 0,
          }}
        >
          {section.kind}
        </span>
        <span
          className="truncate"
          style={{
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
            fontWeight: active ? 500 : 400,
            color: reverted
              ? "var(--color-filelist-revert)"
              : active
                ? "var(--color-foreground)"
                : "var(--color-muted-foreground)",
            textDecoration: reverted ? "line-through" : undefined,
          }}
          title={relativePath}
        >
          {fileName}
        </span>
      </button>
      {reverted ? (
        <span
          className="flex items-center gap-1 shrink-0"
          style={{
            marginRight: 4,
            fontFamily: "Inter, sans-serif",
            fontSize: 10,
            color: "var(--color-accent-green)",
          }}
        >
          <CheckCircle2 size={11} />
          {t("diff.reverted")}
        </span>
      ) : onRevert ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRevert();
          }}
          disabled={isReverting}
          className="flex items-center justify-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{
            width: 22,
            height: 22,
            borderRadius: 4,
            backgroundColor: isConfirming ? "#EF444420" : "var(--color-border-subtle)",
            border: isConfirming ? "1px solid #EF444460" : "1px solid var(--color-border-strong)",
            color: isConfirming ? "#EF4444" : "var(--color-muted)",
            cursor: isReverting ? "wait" : "pointer",
            opacity: isConfirming || isReverting ? 1 : undefined,
          }}
          title={isConfirming ? t("diff.revertFileConfirm") : t("diff.revertFile")}
        >
          {isReverting ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffLineView — single diff line in the right pane
// ---------------------------------------------------------------------------

function DiffLineView({
  line,
  highlightedHtml,
}: {
  readonly line: UnifiedDiffLine;
  readonly highlightedHtml?: string;
}) {
  if (line.type === "hunk") {
    return (
      <div
        className="flex items-center"
        style={{
          height: 28,
          padding: "4px 16px",
          backgroundColor: "rgba(var(--theme-accent-rgb),0.031)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-accent-purple)",
          }}
        >
          {line.text}
        </span>
      </div>
    );
  }

  const bgColor =
    line.type === "removed"
      ? "var(--color-inline-diff-removed-bg)"
      : line.type === "added"
        ? "var(--color-inline-diff-added-bg)"
        : "transparent";

  const textColor =
    line.type === "removed"
      ? "var(--color-inline-diff-removed-sign)"
      : line.type === "added"
        ? "var(--color-inline-diff-added-sign)"
        : "var(--color-foreground)";

  const numColor =
    line.type === "removed"
      ? "#EF444480"
      : line.type === "added"
        ? "#10B98180"
        : "var(--color-filelist-revert)";

  const prefix = line.type === "removed" ? "-" : line.type === "added" ? "+" : " ";

  return (
    <div
      className="flex items-center"
      style={{
        height: 24,
        padding: "0 16px",
        backgroundColor: bgColor,
      }}
    >
      {/* Old line number */}
      <span
        style={{
          width: 36,
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: line.type === "added" ? "transparent" : numColor,
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        {line.type !== "added" && line.oldNum != null ? line.oldNum : " "}
      </span>
      {/* New line number */}
      <span
        style={{
          width: 36,
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: line.type === "removed" ? "transparent" : numColor,
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        {line.type !== "removed" && line.newNum != null ? line.newNum : " "}
      </span>
      {/* Spacer */}
      <div style={{ width: 16, flexShrink: 0 }} />
      {/* Code content */}
      <pre
        className="m-0 flex-1 min-w-0"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: textColor,
          whiteSpace: "pre",
        }}
      >
        {highlightedHtml ? (
          <>
            <span>{prefix}</span>
            <code
              className="hljs"
              style={{ color: textColor }}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          </>
        ) : (
          `${prefix}${line.text}`
        )}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drag resize hook
// ---------------------------------------------------------------------------

function useDrag(onDrag: (dx: number, dy: number) => void) {
  const startRef = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startRef.current = { x: e.clientX, y: e.clientY };

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startRef.current.x;
        const dy = ev.clientY - startRef.current.y;
        startRef.current = { x: ev.clientX, y: ev.clientY };
        onDrag(dx, dy);
      };
      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [onDrag],
  );

  return onMouseDown;
}

// ---------------------------------------------------------------------------
// TurnDiffBar — inline bar above input (same style as ChangedFilesBar)
// ---------------------------------------------------------------------------

export function TurnDiffBar({
  diff,
  onExpand,
}: {
  readonly diff: string;
  readonly onExpand: () => void;
}) {
  const { t } = useTranslation();
  const sections = useMemo(() => parseFileSections(diff), [diff]);
  const stats = useMemo(() => computeTotalStats(sections), [sections]);

  const fileNames = useMemo(
    () => sections.map((s) => s.filePath.split(/[\\/]/).pop() ?? s.filePath),
    [sections],
  );

  // Review integration
  const conversationId = useConversationStore((s) => s.activeConversationId);
  const convState = useFileChangesStore((s) => s.getConversationState(conversationId));
  const reviewFiles = useFileChangesStore((s) => s.reviewFiles);
  const { isReviewing, reviewError } = convState;

  const handleReview = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      reviewFiles(conversationId);
    },
    [reviewFiles, conversationId],
  );

  if (sections.length === 0) return null;

  return (
    <div
      className="flex items-center justify-between w-full cursor-pointer"
      style={{ padding: "6px 4px", borderRadius: 10 }}
      onClick={onExpand}
    >
      {/* Left: icon + label + file pills */}
      <div className="flex items-center" style={{ gap: 8 }}>
        <GitCompare size={13} style={{ color: "var(--color-accent-purple)", flexShrink: 0 }} />
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--color-muted)",
            whiteSpace: "nowrap",
          }}
        >
          {t("chat.fileChanges.changedFiles")}
        </span>
        {/* File name pills — show up to 3, then "+N" */}
        <div className="flex items-center" style={{ gap: 4, overflow: "hidden" }}>
          {fileNames.slice(0, 3).map((name) => (
            <span
              key={name}
              className="truncate"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 400,
                color: "var(--color-muted-foreground)",
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                padding: "2px 8px",
                maxWidth: 120,
              }}
            >
              {name}
            </span>
          ))}
          {fileNames.length > 3 && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 400,
                color: "var(--color-muted-foreground)",
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                padding: "2px 8px",
                whiteSpace: "nowrap",
              }}
            >
              +{fileNames.length - 3}
            </span>
          )}
        </div>
      </div>

      {/* Right: review error + review button + diff stats + View Changes */}
      <div className="flex items-center" style={{ gap: 8 }}>
        {reviewError && (
          <span
            className="truncate"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--color-accent-amber)",
              maxWidth: 180,
            }}
            title={reviewError}
          >
            {reviewError}
          </span>
        )}
        {/* Review button */}
        <button
          onClick={handleReview}
          disabled={isReviewing}
          className="flex items-center cursor-pointer disabled:opacity-50"
          style={{ gap: 4, background: "none", border: "none", padding: 0 }}
        >
          {isReviewing ? (
            <Loader2 size={12} style={{ color: "#818CF8" }} className="animate-spin" />
          ) : (
            <ScanSearch size={12} style={{ color: "#818CF8" }} />
          )}
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              fontWeight: 500,
              color: "#818CF8",
              whiteSpace: "nowrap",
            }}
          >
            {isReviewing ? t("chat.codeReview.reviewing") : t("chat.codeReview.reviewAll")}
          </span>
        </button>
        {stats.added > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--color-inline-diff-added-sign)",
            }}
          >
            +{stats.added}
          </span>
        )}
        {stats.removed > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--color-inline-diff-removed-sign)",
            }}
          >
            -{stats.removed}
          </span>
        )}
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 500,
            color: "var(--color-accent-purple)",
            whiteSpace: "nowrap",
          }}
        >
          {t("chat.fileChanges.viewChanges")}
        </span>
        <ChevronUp size={12} style={{ color: "var(--color-text-tertiary)" }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffViewerModal — the full modal (G3avH design)
// ---------------------------------------------------------------------------

const MODAL_MIN_W = 600;
const MODAL_MIN_H = 360;

export function DiffViewerModal({
  diff,
  onMinimize,
  onRevertFile,
  revertedFiles,
}: {
  readonly diff: string;
  readonly onMinimize: () => void;
  readonly onRevertFile?: (
    filePath: string,
    kind: "M" | "A" | "D",
    fileDiff: string,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
  /** Set of file paths that have been fully reverted (managed by parent). */ readonly revertedFiles: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspace?.path ?? "");
  const freshSections = useMemo(() => parseFileSections(diff), [diff]);

  // Cache sections so reverted files don't vanish when the store removes them.
  // Grows with new files and updates existing files when their content changes
  // (e.g. new edits arrive after a revert). Never removes entries.
  const [cachedSections, setCachedSections] = useState<readonly FileDiffSection[]>(freshSections);
  useEffect(() => {
    setCachedSections((prev) => {
      if (prev.length === 0) return freshSections;
      const prevMap = new Map(prev.map((s) => [s.filePath, s]));
      let changed = false;

      for (const s of freshSections) {
        const existing = prevMap.get(s.filePath);
        if (!existing) {
          // New file — add
          prevMap.set(s.filePath, s);
          changed = true;
        } else if (
          s.added !== existing.added ||
          s.removed !== existing.removed ||
          s.lines.length !== existing.lines.length
        ) {
          // Content changed (e.g. re-edited after revert) — update
          prevMap.set(s.filePath, s);
          changed = true;
        }
      }

      return changed ? [...prevMap.values()] : prev;
    });
  }, [freshSections]);

  const stats = useMemo(() => computeTotalStats(cachedSections), [cachedSections]);
  const [activeFile, setActiveFile] = useState(0);
  const [filterText, setFilterText] = useState("");
  const [copied, setCopied] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [size, setSize] = useState({ w: 960, h: 640 });
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(
    null,
  );

  // Revert state
  const [revertingFile, setRevertingFile] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Undo All state
  const [isRevertingAll, setIsRevertingAll] = useState(false);
  const [confirmUndoAll, setConfirmUndoAll] = useState(false);
  const confirmUndoAllTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear confirm timers on unmount
  useEffect(
    () => () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (confirmUndoAllTimerRef.current) clearTimeout(confirmUndoAllTimerRef.current);
    },
    [],
  );

  // Handle revert click (double-click-to-confirm pattern)
  const handleRevertClick = useCallback(
    async (filePath: string, kind: "M" | "A" | "D") => {
      if (!onRevertFile || revertedFiles.has(filePath)) return;

      if (confirmRevert === filePath) {
        // Second click — execute revert
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        setConfirmRevert(null);
        setRevertingFile(filePath);

        const { extractSingleFileDiff } = await import("@/lib/diff-utils");
        const fileDiff = extractSingleFileDiff(diff, filePath);
        if (!fileDiff) {
          setRevertingFile(null);
          return;
        }

        await onRevertFile(filePath, kind, fileDiff);
        setRevertingFile(null);
      } else {
        // First click — enter confirm mode
        setConfirmRevert(filePath);
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = setTimeout(() => setConfirmRevert(null), 3000);
      }
    },
    [onRevertFile, confirmRevert, diff, revertedFiles],
  );

  // Handle undo all (double-click-to-confirm pattern)
  const handleUndoAll = useCallback(async () => {
    if (!onRevertFile || isRevertingAll) return;

    if (!confirmUndoAll) {
      // First click — enter confirm mode
      setConfirmUndoAll(true);
      if (confirmUndoAllTimerRef.current) clearTimeout(confirmUndoAllTimerRef.current);
      confirmUndoAllTimerRef.current = setTimeout(() => setConfirmUndoAll(false), 3000);
      return;
    }

    // Second click — execute revert all
    if (confirmUndoAllTimerRef.current) clearTimeout(confirmUndoAllTimerRef.current);
    setConfirmUndoAll(false);
    setIsRevertingAll(true);

    const { extractSingleFileDiff } = await import("@/lib/diff-utils");

    for (const section of cachedSections) {
      if (revertedFiles.has(section.filePath)) continue;
      const fileDiff = extractSingleFileDiff(diff, section.filePath);
      if (!fileDiff) continue;
      await onRevertFile(section.filePath, section.kind, fileDiff);
    }

    setIsRevertingAll(false);
  }, [onRevertFile, isRevertingAll, confirmUndoAll, cachedSections, revertedFiles, diff]);

  // Whether all files have been reverted (hide undo-all button)
  const allReverted = useMemo(
    () => cachedSections.length > 0 && cachedSections.every((s) => revertedFiles.has(s.filePath)),
    [cachedSections, revertedFiles],
  );

  // Center on first render
  const pos = useMemo(
    () =>
      position ?? {
        x: Math.max(0, (window.innerWidth - size.w) / 2),
        y: Math.max(40, (window.innerHeight - size.h) / 2),
      },
    [position, size.h, size.w],
  );

  // Filtered file list
  const filteredSections = useMemo(() => {
    if (!filterText) return cachedSections;
    const lower = filterText.toLowerCase();
    return cachedSections.filter((s) => s.filePath.toLowerCase().includes(lower));
  }, [cachedSections, filterText]);

  // Current active section
  const activeSection = filteredSections[activeFile] ?? filteredSections[0];

  // Syntax highlighting for active section
  const highlightedLines = useHighlightedLines(
    activeSection?.lines ?? [],
    activeSection?.filePath ?? "",
  );

  // Copy full diff
  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(diff)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [diff]);

  // Title bar drag
  const handleTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (maximized) return;
      const currentPos = position ?? pos;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        posX: currentPos.x,
        posY: currentPos.y,
      };

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        setPosition({
          x: dragRef.current.posX + (ev.clientX - dragRef.current.startX),
          y: dragRef.current.posY + (ev.clientY - dragRef.current.startY),
        });
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [maximized, position, pos],
  );

  // Corner resize
  const handleResizeMouseDown = useDrag(
    useCallback((dx: number, dy: number) => {
      setSize((prev) => ({
        w: Math.max(MODAL_MIN_W, prev.w + dx),
        h: Math.max(MODAL_MIN_H, prev.h + dy),
      }));
    }, []),
  );

  // Toggle maximize
  const toggleMaximize = useCallback(() => {
    setMaximized((v) => !v);
  }, []);

  if (stats.added === 0 && stats.removed === 0 && cachedSections.length === 0) return null;

  const modalStyle: React.CSSProperties = maximized
    ? { position: "fixed", inset: 0, width: "100%", height: "100%", borderRadius: 0, zIndex: 9999 }
    : {
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        borderRadius: 12,
        zIndex: 9999,
      };

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "#00000050",
          zIndex: 9998,
        }}
        onClick={onMinimize}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        className="flex flex-col"
        style={{
          ...modalStyle,
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-float)",
          overflow: "hidden",
        }}
      >
        {/* ── Header (48px) ── */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{
            height: 48,
            padding: "0 16px",
            backgroundColor: "var(--color-card)",
            borderBottom: "1px solid var(--color-border)",
            cursor: maximized ? "default" : "move",
          }}
          onMouseDown={handleTitleMouseDown}
        >
          {/* Left */}
          <div className="flex items-center gap-2.5" style={{ pointerEvents: "none" }}>
            <GitCompare size={18} style={{ color: "var(--color-accent-purple)" }} />
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--color-foreground)",
              }}
            >
              {t("diff.title")}
            </span>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                fontWeight: 500,
                color: "var(--color-accent-purple)",
                backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
                borderRadius: 10,
                padding: "2px 8px",
              }}
            >
              {t("diff.fileCount", { count: stats.files })}
            </span>
          </div>

          {/* Right buttons */}
          <div className="flex items-center gap-1.5" style={{ pointerEvents: "auto" }}>
            {/* Undo All — design 9aJkY */}
            {onRevertFile && !allReverted && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUndoAll();
                }}
                disabled={isRevertingAll}
                className="flex items-center native-css-hover"
                style={
                  {
                    gap: 6,
                    padding: "5px 10px",
                    borderRadius: 6,
                    backgroundColor: confirmUndoAll ? "#EF444420" : "var(--color-border-subtle)",
                    border: confirmUndoAll
                      ? "1px solid #EF444460"
                      : "1px solid var(--color-border-strong)",
                    color: confirmUndoAll ? "#EF4444" : "var(--color-muted-foreground)",
                    cursor: isRevertingAll ? "wait" : "pointer",
                    "--native-hover-bg-color": !confirmUndoAll
                      ? "var(--color-border-strong)"
                      : undefined,
                  } as React.CSSProperties
                }
                title={confirmUndoAll ? t("diff.undoAllConfirm") : t("diff.undoAll")}
              >
                {isRevertingAll ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Undo2 size={14} />
                )}
                <span style={{ fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: 500 }}>
                  {isRevertingAll
                    ? t("diff.undoAllReverting")
                    : confirmUndoAll
                      ? t("diff.undoAllConfirm")
                      : t("diff.undoAll")}
                </span>
              </button>
            )}
            {/* Copy */}
            <ToolbarButton onClick={handleCopy} title={t("diff.copyDiff")}>
              {copied ? (
                <Check size={14} style={{ color: "var(--color-accent-green)" }} />
              ) : (
                <Copy size={14} />
              )}
            </ToolbarButton>
            <div style={{ width: 1, height: 20, backgroundColor: "var(--color-border-strong)" }} />
            {/* Maximize / Restore */}
            <ToolbarButton
              onClick={toggleMaximize}
              title={maximized ? t("diff.restore") : t("diff.maximize")}
            >
              {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </ToolbarButton>
            {/* Close (minimizes to bar) */}
            <ToolbarButton onClick={onMinimize} title={t("diff.close")}>
              <X size={14} />
            </ToolbarButton>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar (250px) */}
          <div
            className="flex flex-col shrink-0"
            style={{
              width: 250,
              backgroundColor: "var(--color-surface-alt)",
              borderRight: "1px solid var(--color-border)",
            }}
          >
            {/* Search bar */}
            <div
              className="flex items-center gap-2 shrink-0"
              style={{
                height: 36,
                padding: "0 12px",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <Search size={14} style={{ color: "var(--color-filelist-revert)", flexShrink: 0 }} />
              <input
                type="text"
                value={filterText}
                onChange={(e) => {
                  setFilterText(e.target.value);
                  setActiveFile(0);
                }}
                placeholder={t("diff.filterPlaceholder")}
                style={{
                  flex: 1,
                  background: "none",
                  border: "none",
                  outline: "none",
                  fontFamily: "Inter, sans-serif",
                  fontSize: 12,
                  color: "var(--color-foreground)",
                }}
              />
            </div>

            {/* File list */}
            <div className="flex-1 overflow-y-auto" style={{ padding: "4px 0" }}>
              {filteredSections.map((section, i) => {
                const isReverted = revertedFiles.has(section.filePath);
                return (
                  <FileListItem
                    key={section.filePath}
                    section={section}
                    active={i === activeFile}
                    onClick={() => setActiveFile(i)}
                    onRevert={
                      onRevertFile && !isReverted
                        ? () => handleRevertClick(section.filePath, section.kind)
                        : undefined
                    }
                    isReverting={revertingFile === section.filePath}
                    isConfirming={confirmRevert === section.filePath}
                    reverted={isReverted}
                  />
                );
              })}
              {filteredSections.length === 0 && (
                <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--color-muted)" }}>
                  {t("diff.noMatchingFiles")}
                </div>
              )}
            </div>
          </div>

          {/* Diff area */}
          <div
            className="flex flex-col flex-1 min-w-0"
            style={{ backgroundColor: "var(--color-surface)" }}
          >
            {activeSection && (
              <>
                {/* Diff header */}
                <div
                  className="flex items-center justify-between shrink-0"
                  style={{
                    height: 36,
                    padding: "0 16px",
                    backgroundColor: "var(--color-card)",
                    borderBottom: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <FileCode size={14} style={{ color: "var(--color-muted)" }} />
                    <span
                      className="truncate"
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--color-foreground)",
                      }}
                      title={activeSection.filePath}
                    >
                      {toRelativePath(activeSection.filePath, workspacePath)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        fontWeight: 600,
                        color: "var(--color-inline-diff-added-sign)",
                      }}
                    >
                      +{activeSection.added}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        fontWeight: 600,
                        color: "var(--color-inline-diff-removed-sign)",
                      }}
                    >
                      -{activeSection.removed}
                    </span>
                    {onRevertFile && revertedFiles.has(activeSection.filePath) ? (
                      <span
                        className="flex items-center gap-1"
                        style={{
                          marginLeft: 4,
                          padding: "2px 8px",
                          fontFamily: "Inter, sans-serif",
                          fontSize: 11,
                          color: "var(--color-accent-green)",
                        }}
                      >
                        <CheckCircle2 size={12} />
                        {t("diff.reverted")}
                      </span>
                    ) : onRevertFile ? (
                      <button
                        type="button"
                        onClick={() =>
                          handleRevertClick(activeSection.filePath, activeSection.kind)
                        }
                        disabled={revertingFile === activeSection.filePath}
                        className="flex items-center gap-1 transition-colors"
                        style={{
                          marginLeft: 4,
                          padding: "2px 8px",
                          borderRadius: 4,
                          backgroundColor:
                            confirmRevert === activeSection.filePath
                              ? "#EF444420"
                              : "var(--color-border-subtle)",
                          border:
                            confirmRevert === activeSection.filePath
                              ? "1px solid #EF444460"
                              : "1px solid var(--color-border-strong)",
                          color:
                            confirmRevert === activeSection.filePath
                              ? "#EF4444"
                              : "var(--color-muted-foreground)",
                          fontFamily: "Inter, sans-serif",
                          fontSize: 11,
                          cursor: revertingFile === activeSection.filePath ? "wait" : "pointer",
                        }}
                        title={
                          confirmRevert === activeSection.filePath
                            ? t("diff.revertFileConfirm")
                            : t("diff.revertFile")
                        }
                      >
                        {revertingFile === activeSection.filePath ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Undo2 size={12} />
                        )}
                        <span>
                          {confirmRevert === activeSection.filePath
                            ? t("diff.revertFileConfirm")
                            : t("diff.revertFile")}
                        </span>
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Diff lines */}
                <div
                  className="flex-1 overflow-y-auto overflow-x-auto"
                  style={{ padding: "8px 0" }}
                >
                  {activeSection.lines.map((line, i) => {
                    // Skip empty trailing context
                    if (
                      line.type === "context" &&
                      !line.text &&
                      i === activeSection.lines.length - 1
                    )
                      return null;
                    return (
                      <DiffLineView key={i} line={line} highlightedHtml={highlightedLines.get(i)} />
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Footer (40px) ── */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{
            height: 40,
            padding: "0 16px",
            backgroundColor: "var(--color-card)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          {/* Left: file type stats */}
          <div className="flex items-center gap-3">
            {stats.modified > 0 && (
              <div className="flex items-center gap-1.5">
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: "var(--color-accent-amber)",
                  }}
                />

                <span
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: 11,
                    color: "var(--color-muted-foreground)",
                  }}
                >
                  {t("diff.statsModified", { count: stats.modified })}
                </span>
              </div>
            )}
            {stats.newFiles > 0 && (
              <div className="flex items-center gap-1.5">
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: "var(--color-accent-green)",
                  }}
                />

                <span
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: 11,
                    color: "var(--color-muted-foreground)",
                  }}
                >
                  {t("diff.statsAdded", { count: stats.newFiles })}
                </span>
              </div>
            )}
            {stats.deleted > 0 && (
              <div className="flex items-center gap-1.5">
                <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#EF4444" }} />
                <span
                  style={{
                    fontFamily: "Inter, sans-serif",
                    fontSize: 11,
                    color: "var(--color-muted-foreground)",
                  }}
                >
                  {t("diff.statsDeleted", { count: stats.deleted })}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Corner resize handle */}
        {!maximized && (
          <div
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 16,
              height: 16,
              cursor: "nwse-resize",
            }}
            onMouseDown={handleResizeMouseDown}
          />
        )}
      </div>
    </>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// ToolbarButton — header button matching design
// ---------------------------------------------------------------------------

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  readonly onClick: () => void;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex items-center justify-center transition-colors native-css-hover"
      style={
        {
          width: 26,
          height: 26,
          borderRadius: 6,
          backgroundColor: "var(--color-border-subtle)",
          border: "1px solid var(--color-border-strong)",
          color: "var(--color-muted)",
          cursor: "pointer",
          "--native-hover-bg-color": "var(--color-border-strong)",
        } as React.CSSProperties
      }
      title={title}
    >
      {children}
    </button>
  );
}
