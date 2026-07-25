import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CHAT_SCROLL_CONTENT_MOTION_EVENT } from "@/hooks/use-auto-scroll";
import type { ToolCall } from "@/stores/chat-store";
import { useChatStore } from "@/stores/chat-store";
import { findPendingConfirmation } from "./tool-confirmation-utils";
import { openToolDiffTab, openToolFile } from "./tool-renderers/tool-action-bridge";
import {
  getMeta,
  formatInput,
  groupToolCalls,
} from "./tool-renderers";
import {
  DiffStatBadge,
  StatusIcon,
  ConfirmationActions,
  ResultContent,
  InlineDiffContent,
  InlineWriteContent,
  InlineDeleteContent,
  InlineBashContent,
  InlineWebSearchContent,
  InlineWebFetchContent,
  InlineDirectoryListContent,
  InlineFileSearchContent,
  InlinePlanContent,
  GroupStatusDot,
  TodoContent,
  AskUserQuestionContent,
  ImageGenBlock,
} from "./tool-renderers";

// ---------------------------------------------------------------------------
// Design reference: pencil node Jb4tt (AgentOperations)
//
// Normal rows: transparent bg, no border, inline layout
//   [StatusIcon] [ToolIcon] [Label] [Path] --- spacer --- [Duration]
// Running row only: bg #1A1700, border 1px #3D3500, rounded-md
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Can this tool call show a diff view? */
function canShowDiff(toolName: string): boolean {
  return toolName === "Edit" || toolName === "Write"
    || toolName === "replace" || toolName === "write_file";
}

const WEB_SEARCH_TOOLS = new Set(["WebSearch", "google_web_search"]);
const WEB_FETCH_TOOLS = new Set(["WebFetch", "web_fetch"]);
const FILE_SEARCH_TOOLS = new Set([
  "Grep",
  "Glob",
  "grep_search",
  "grep_search_ripgrep",
  "glob",
]);
const PLAN_TOOLS = new Set(["ExitPlanMode", "exit_plan_mode"]);
const DIRECTORY_LIST_TOOLS = new Set(["list_directory"]);
const DELETE_FILE_TOOLS = new Set(["Delete", "delete_file", "remove_file"]);
const TOOL_COLLAPSE_MOTION_MS = 260;
const TOOL_COLLAPSE_SETTLE_MS = 80;

function isWebSearchTool(toolName: string): boolean {
  return WEB_SEARCH_TOOLS.has(toolName);
}

function isWebFetchTool(toolName: string): boolean {
  return WEB_FETCH_TOOLS.has(toolName);
}

function isFileSearchTool(toolName: string): boolean {
  return FILE_SEARCH_TOOLS.has(toolName);
}

function isReadTool(toolName: string): boolean {
  return toolName === "Read" || toolName === "read_file" || toolName === "read_many_files";
}

function isDirectoryListTool(toolName: string): boolean {
  return DIRECTORY_LIST_TOOLS.has(toolName);
}

function isDeleteFileTool(toolName: string): boolean {
  return DELETE_FILE_TOOLS.has(toolName);
}

function isPlanTool(toolName: string): boolean {
  return PLAN_TOOLS.has(toolName);
}

function dispatchToolContentMotion(node: HTMLElement, durationMs = TOOL_COLLAPSE_MOTION_MS): void {
  if (typeof CustomEvent === "undefined") return;
  node.dispatchEvent(new CustomEvent(CHAT_SCROLL_CONTENT_MOTION_EVENT, {
    bubbles: true,
    detail: { durationMs },
  }));
}

/** Write tools render a full-content view instead of a +/- diff. */
function isWriteTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "write_file";
}

function isFileChangeTool(toolName: string): boolean {
  return canShowDiff(toolName) || isDeleteFileTool(toolName);
}

/** Shell command execution tools — render with InlineBashContent. */
function isBashTool(toolName: string): boolean {
  return toolName === "Bash" || toolName === "run_shell_command" || toolName === "execute_command";
}

/** Is this a todo/task list tool that should render as a checklist? */
function isTodoTool(toolName: string): boolean {
  return toolName === "TodoWrite" || toolName === "write_todos"
    || toolName === "TaskCreate" || toolName === "TaskUpdate"
    || toolName === "TaskGet" || toolName === "TaskList";
}

/** AskUserQuestion — render as a structured question/answer replay. */
function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === "AskUserQuestion";
}

function hasExpandableContent(
  toolName: string,
  result?: string,
): boolean {
  return isTodoTool(toolName)
    || isAskUserQuestionTool(toolName)
    || canShowDiff(toolName)
    || isDeleteFileTool(toolName)
    || isBashTool(toolName)
    || (isPlanTool(toolName) && !!result)
    || (isWebSearchTool(toolName) && !!result)
    || (isWebFetchTool(toolName) && !!result)
    || (isDirectoryListTool(toolName) && !!result)
    || (isFileSearchTool(toolName) && !!result)
    || !!result;
}

function shouldAutoExpandTool(
  toolName: string,
  status: ToolCall["status"],
  result?: string,
): boolean {
  // Everything stays collapsed by default — including file writes/edits, whose
  // row already carries the +/- diff stat and line count. Only two exceptions
  // auto-open: a completed plan (its content is the deliverable the user must
  // read) and a running command (live streaming output). One click reveals the
  // rest.
  if (isPlanTool(toolName) && status === "success" && !!result) return true;
  return isBashTool(toolName) && status === "running" && !!result;
}

function shouldAutoExpandCall(
  call: { toolName: string; status: ToolCall["status"]; result?: string },
): boolean {
  return shouldAutoExpandTool(call.toolName, call.status, call.result);
}

function findDefaultExpandedCallId(
  calls: ReadonlyArray<ToolCall>,
): string | null {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (shouldAutoExpandCall(call)
      && hasExpandableContent(call.toolName, call.result)) {
      return call.id;
    }
  }
  return null;
}

function findFirstExpandableCallId(calls: ReadonlyArray<ToolCall>): string | null {
  return calls.find((call) => hasExpandableContent(call.toolName, call.result))?.id ?? null;
}

function ToolExpandedContent({
  toolCallId,
  toolName,
  toolInput,
  result,
  status,
  reverted,
}: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly result?: string;
  readonly status: ToolCall["status"];
  readonly reverted?: boolean;
}) {
  if (isTodoTool(toolName)) {
    return <TodoContent toolName={toolName} toolInput={toolInput} result={result} />;
  }

  if (isAskUserQuestionTool(toolName)) {
    return <AskUserQuestionContent toolInput={toolInput} result={result} />;
  }

  if (canShowDiff(toolName)) {
    // Only a successfully-applied edit can be undone — while running, pending,
    // or on error the file isn't in the post-edit state, so withhold the
    // undo control by not passing a toolCallId.
    const revertId = status === "success" ? toolCallId : undefined;
    return isWriteTool(toolName) ? (
      <InlineWriteContent
        toolCallId={revertId}
        toolInput={toolInput}
        result={result}
        reverted={reverted}
      />
    ) : (
      <InlineDiffContent
        toolCallId={revertId}
        toolName={toolName}
        toolInput={toolInput}
        result={result}
        reverted={reverted}
      />
    );
  }

  if (isDeleteFileTool(toolName)) {
    return <InlineDeleteContent toolInput={toolInput} result={result} />;
  }

  if (isWebSearchTool(toolName) && result) {
    return <InlineWebSearchContent result={result} />;
  }

  if (isWebFetchTool(toolName) && result) {
    return <InlineWebFetchContent result={result} />;
  }

  if (isFileSearchTool(toolName) && result) {
    return <InlineFileSearchContent result={result} />;
  }

  if (isDirectoryListTool(toolName) && result) {
    return <InlineDirectoryListContent toolInput={toolInput} result={result} />;
  }

  if (isBashTool(toolName)) {
    return <InlineBashContent toolInput={toolInput} result={result} status={status} />;
  }

  if (isPlanTool(toolName) && result) {
    return <InlinePlanContent result={result} />;
  }

  if (result) {
    return <ResultContent result={result} toolName={toolName} toolInput={toolInput} />;
  }

  return null;
}

function AnimatedToolContent({
  open,
  children,
  inset = false,
}: {
  readonly open: boolean;
  readonly children: ReactNode;
  readonly inset?: boolean;
}) {
  const [hasMountedContent, setHasMountedContent] = useState(open);
  const collapseRef = useRef<HTMLDivElement | null>(null);
  const shouldRenderContent = open || hasMountedContent;

  useEffect(() => {
    if (open) setHasMountedContent(true);
  }, [open]);

  useEffect(() => {
    const node = collapseRef.current;
    if (!node || (!open && !hasMountedContent)) return;

    if (typeof requestAnimationFrame !== "function") {
      dispatchToolContentMotion(node);
      return;
    }

    const frame = requestAnimationFrame(() => {
      dispatchToolContentMotion(node);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, hasMountedContent]);

  // Fallback unmount: the primary path is the grid-template-rows transitionend
  // below, but if it never fires (node hidden mid-motion, or the CSS transition
  // property changes) release the collapsed content instead of leaving it
  // mounted indefinitely. Re-opening or an earlier transitionend clears it.
  useEffect(() => {
    if (open || !hasMountedContent || typeof window === "undefined") return;
    const timer = window.setTimeout(
      () => setHasMountedContent(false),
      TOOL_COLLAPSE_MOTION_MS + 80,
    );
    return () => window.clearTimeout(timer);
  }, [open, hasMountedContent]);

  return (
    <div
      ref={collapseRef}
      className={`tool-collapse ${open ? "tool-collapse-open" : "tool-collapse-closed"}`}
      data-tool-collapse-motion={open ? "open" : "closed"}
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== "grid-template-rows") return;
        if (!open) setHasMountedContent(false);
        dispatchToolContentMotion(event.currentTarget, TOOL_COLLAPSE_SETTLE_MS);
      }}
    >
      <div className={`tool-collapse-inner${inset ? " tool-collapse-inner-inset" : ""}`}>
        {shouldRenderContent ? children : null}
      </div>
    </div>
  );
}

/** Image generation tools — preview images are surfaced inline (always visible),
 *  not hidden behind the collapsible tool-block. Covers both text-to-image
 *  (generate_image) and image-to-image (edit_image). */
const IMAGE_GEN_TOOLS = new Set([
  "mcp__openai_images__generate_image",
  "mcp__openai_images__edit_image",
]);
function isImageGenTool(toolName: string): boolean {
  return IMAGE_GEN_TOOLS.has(toolName);
}

/** Parse toolInput JSON safely */
function parseToolInput(toolInput: string): Record<string, unknown> {
  try {
    return JSON.parse(toolInput) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface ToolRowFact {
  readonly key: string;
  readonly label: string;
  readonly title?: string;
  readonly tone?: "added" | "removed" | "muted";
}

function basename(filePath: string): string {
  const sep = filePath.lastIndexOf("/");
  const backslash = filePath.lastIndexOf("\\");
  const idx = Math.max(sep, backslash);
  return idx >= 0 ? filePath.slice(idx + 1) : filePath;
}

function getExtension(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "";
}

function pickString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function getToolInputFilePath(input: Record<string, unknown>): string {
  const direct = pickString(input, ["file_path", "path"]);
  if (direct) return direct;
  const changes = input.changes as ReadonlyArray<{ path?: string }> | undefined;
  const firstPath = changes?.[0]?.path;
  return typeof firstPath === "string" ? firstPath : "";
}

function countRows(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
}

function countVisibleResultRows(result?: string): number {
  if (!result) return 0;
  return result
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .length;
}

function parseLinkCount(result?: string): number {
  if (!result) return 0;
  const linksLine = result.split("\n").find((line) => line.trim().startsWith("Links:"));
  return linksLine ? (linksLine.match(/"url"\s*:/g) ?? []).length : 0;
}

function parseFileSearchCount(result?: string): number {
  if (!result) return 0;
  const first = result.split("\n").find((line) => line.trim())?.trim() ?? "";
  const foundMatch = first.match(/^Found\s+(\d+)/i);
  if (foundMatch?.[1]) return Number(foundMatch[1]);
  return countVisibleResultRows(result);
}

function makeLanguageFact(filePath: string): ToolRowFact | null {
  const ext = getExtension(filePath);
  return ext ? { key: "language", label: ext, title: filePath } : null;
}

function buildToolRowFacts(
  toolName: string,
  toolInput: string,
  result: string | undefined,
  t: TFunction,
): readonly ToolRowFact[] {
  const input = parseToolInput(toolInput);
  const facts: ToolRowFact[] = [];
  const filePath = getToolInputFilePath(input);
  const languageFact = makeLanguageFact(filePath);
  if (languageFact) facts.push(languageFact);

  if (isWriteTool(toolName)) {
    const content = pickString(input, ["content"]);
    const lines = countRows(content);
    if (lines > 0) {
      facts.push({ key: "lines", label: t("chat.tools.result.lines", { count: lines }) });
    }
    return facts;
  }

  if (toolName === "Edit" || toolName === "replace") {
    const oldText = pickString(input, ["old_string", "old_str", "oldText", "old_text"]);
    const newText = pickString(input, ["new_string", "new_str", "newText", "new_text", "replacement"]);
    const oldLines = countRows(oldText);
    const newLines = countRows(newText);
    if (oldLines > 0 || newLines > 0) {
      facts.push({
        key: "line-delta",
        label: `${oldLines}->${newLines}`,
        title: t("chat.tools.result.lineDelta"),
      });
      const delta = newLines - oldLines;
      facts.push({
        key: "net-change",
        label: delta > 0 ? `+${delta}` : `${delta}`,
        tone: delta > 0 ? "added" : delta < 0 ? "removed" : "muted",
        title: t("chat.tools.result.netChange"),
      });
    }
    return facts;
  }

  if (isReadTool(toolName) || isBashTool(toolName) || isWebFetchTool(toolName)) {
    const lines = countVisibleResultRows(result);
    if (lines > 0) {
      facts.push({ key: "output-lines", label: t("chat.tools.result.lines", { count: lines }) });
    }
    return facts;
  }

  if (isFileSearchTool(toolName)) {
    const count = parseFileSearchCount(result);
    if (count > 0) {
      const mode = typeof input.output_mode === "string" ? input.output_mode : "";
      facts.push({
        key: mode === "content" ? "matches" : "files",
        label: mode === "content"
          ? t("chat.tools.result.matches", { count })
          : t("chat.tools.result.fileCount", { count }),
      });
    }
    return facts;
  }

  if (isDirectoryListTool(toolName)) {
    const count = countVisibleResultRows(result);
    if (count > 0) {
      facts.push({ key: "entries", label: t("chat.tools.result.directoryEntries", { count }) });
    }
    return facts;
  }

  if (isWebSearchTool(toolName)) {
    const count = parseLinkCount(result);
    if (count > 0) {
      facts.push({ key: "sources", label: t("chat.tools.result.sources", { count }) });
    }
  }

  return facts;
}

function ToolRowFacts({
  facts,
  compact = false,
}: {
  readonly facts: readonly ToolRowFact[];
  readonly compact?: boolean;
}) {
  if (facts.length === 0) return null;
  return (
    <span
      className={cn("tool-row-facts", compact && "tool-row-facts-compact")}
      data-tool-row-facts="true"
    >
      {facts.slice(0, 4).map((fact) => (
        <span
          key={fact.key}
          className={cn("tool-row-fact", fact.tone && `tool-row-fact-${fact.tone}`)}
          data-tool-row-fact={fact.key}
          title={fact.title}
        >
          {fact.label}
        </span>
      ))}
    </span>
  );
}

/** Open diff view for Edit / Write tool calls. Shared by SingleBlock and GroupItem. */
async function openToolDiff(toolName: string, toolInput: string): Promise<void> {
  const input = parseToolInput(toolInput);
  const changes = input.changes as ReadonlyArray<{ path?: string }> | undefined;
  const filePath = (input.file_path as string | undefined) ?? (typeof changes?.[0]?.path === "string" ? changes[0].path : undefined);
  if (!filePath) return;

  if (toolName === "Edit" || toolName === "replace") {
    const oldStr = (input.old_string as string) ?? "";
    const newStr = (input.new_string as string) ?? "";
    if (!oldStr && !newStr) {
      await openToolFile(filePath);
      return;
    }
    await openToolDiffTab({ filePath, original: oldStr, modified: newStr });
  } else {
    // Write: toolInput.content is the written payload; original is always empty
    // because the backend does not provide the pre-write content.
    // TODO: pass pre-write content from backend to show true diff for overwrites.
    try {
      const content = (input.content as string) ?? "";
      if (!content) {
        await openToolFile(filePath);
        return;
      }
      await openToolDiffTab({ filePath, original: "", modified: content });
    } catch (err) {
      console.warn("[openToolDiff] failed to open diff, falling back to file view:", err);
      await openToolFile(filePath);
    }
  }
}

// ---------------------------------------------------------------------------
// Single tool call block
// ---------------------------------------------------------------------------

function SingleBlock({ call }: { readonly call: ToolCall }) {
  // Image generation: replace the entire MCP-tool-call wrapper with an
  // image-centric inline preview (skeleton placeholders → real images).
  // Routed before any hook calls so the standard wrapper's hooks never run
  // for image-gen calls (toolName is stable per ToolCall id).
  if (isImageGenTool(call.toolName)) {
    return (
      <ImageGenBlock
        toolName={call.toolName}
        toolInput={call.toolInput}
        result={call.result}
        status={call.status}
      />
    );
  }
  return <StandardSingleBlock {...call} />;
}

function StandardSingleBlock({ id, toolName, toolInput, status, result, confirmId, reverted }: ToolCall) {
  const { t, i18n: i18nInstance } = useTranslation();
  const [open, setOpen] = useState(() => shouldAutoExpandCall({ toolName, status, result }));
  const [userToggled, setUserToggled] = useState(false);
  const meta = getMeta(toolName);
  const Icon = meta.icon;
  const formatted = useMemo(
    () => formatInput(toolName, toolInput),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolName, toolInput, i18nInstance.language],
  );
  const rowFacts = useMemo(
    () => buildToolRowFacts(toolName, toolInput, result, t),
    [toolName, toolInput, result, t],
  );
  const isPending = status === "pending_confirmation";
  const isRunning = status === "running";
  const isDone = status === "success";
  const showDiffBtn = isDone && canShowDiff(toolName);
  const expandable = hasExpandableContent(toolName, result);

  // Auto-expand only high-signal details: a running command streams its output
  // (folding back up once it finishes), a completed plan surfaces its content.
  // Everything else — including file writes/edits — stays collapsed. User
  // intent wins after a manual toggle.
  useEffect(() => {
    if (userToggled) return;
    if (shouldAutoExpandCall({ toolName, status, result })) {
      setOpen(true);
    } else if (isBashTool(toolName)) {
      setOpen(false);
    }
  }, [toolName, status, result, userToggled]);

  const handleToggle = useCallback(() => {
    setUserToggled(true);
    setOpen((v) => !v);
  }, []);

  const pendingToolCallId = useChatStore(
    (s) => findPendingConfirmation(s.messages)?.id ?? null,
  );
  const isHandledByDialog = isPending && pendingToolCallId === id;

  const handleOpenDiff = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openToolDiff(toolName, toolInput);
  }, [toolName, toolInput]);

  return (
    <div
      className="tool-call-block"
      data-preview-read-group={isReadTool(toolName) ? (open ? "open" : "collapsed") : undefined}
    >
      <button
        type="button"
        onClick={expandable ? handleToggle : undefined}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "tool-call-row",
          expandable && "tool-call-row-expandable",
          isRunning && "tool-call-row-running",
          open && "tool-call-row-open",
        )}
        style={{ "--tool-accent-color": meta.accentColor } as React.CSSProperties}
      >
        {/* Single icon slot: tool icon when successful, status icon otherwise.
            Merging the two slots keeps completed rows to one glyph. */}
        {isDone ? (
          <Icon size={14} className="tool-call-row-icon" />
        ) : (
          <span className="tool-call-row-status-icon">
            <StatusIcon status={status} />
          </span>
        )}

        {/* Label */}
        <span className="tool-call-row-label">
          {t(meta.label)}
        </span>

        {/* Path / formatted input */}
        <span
          className="tool-call-row-path"
          title={formatted.tooltip}
        >
          {formatted.display}
        </span>

        {formatted.diffStat && <DiffStatBadge stat={formatted.diffStat} onClick={showDiffBtn ? handleOpenDiff : undefined} />}
        <ToolRowFacts facts={rowFacts} />

        {/* Spacer */}
        <span className="flex-1" />

        {/* Right: running status text */}
        {isRunning && (
          <span className="tool-call-row-running-text">
            {t("chat.tools.status.running")}
          </span>
        )}

        {expandable && (
          open
            ? <ChevronDown size={12} className="tool-call-row-chevron" />
            : <ChevronRight size={12} className="tool-call-row-chevron" />
        )}
      </button>

      {isPending && confirmId && !isHandledByDialog && (
        <div className="tool-call-pending-row">
          <span className="tool-call-pending-text">{t("chat.tools.status.awaitingApproval")}</span>
          <ConfirmationActions toolCallId={id} confirmId={confirmId} />
        </div>
      )}

      {isPending && isHandledByDialog && (
        <div className="tool-call-pending-row">
          <span className="tool-call-pending-text">{t("chat.tools.status.awaitingApprovalSeeDialog")}</span>
        </div>
      )}

      {expandable && (
        <AnimatedToolContent open={open}>
          <ToolExpandedContent
            toolCallId={id}
            toolName={toolName}
            toolInput={toolInput}
            result={result}
            status={status}
            reverted={reverted}
          />
        </AnimatedToolContent>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupItem — single item within a grouped block (supports diff button)
// ---------------------------------------------------------------------------

function GroupItem({ tc, isExpanded, onToggle }: { readonly tc: ToolCall; readonly isExpanded: boolean; readonly onToggle: () => void }) {
  const { t, i18n: i18nInstance } = useTranslation();
  const formatted = useMemo(
    () => formatInput(tc.toolName, tc.toolInput),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tc.toolName, tc.toolInput, i18nInstance.language],
  );
  const rowFacts = useMemo(
    () => buildToolRowFacts(tc.toolName, tc.toolInput, tc.result, t),
    [tc.toolName, tc.toolInput, tc.result, t],
  );
  const showDiff = tc.status === "success" && canShowDiff(tc.toolName);
  const expandable = hasExpandableContent(tc.toolName, tc.result);

  // Short result preview for collapsed completed items — helps differentiate
  // items with identical display text (e.g. two list_directory calls on ".").
  const resultPreview = useMemo(() => {
    if (isExpanded || !tc.result) return null;
    const firstLine = tc.result.split("\n").find((l) => l.trim())?.trim() ?? "";
    if (!firstLine) return null;
    return firstLine.length > 50 ? `${firstLine.slice(0, 47)}...` : firstLine;
  }, [isExpanded, tc.result]);

  const handleDiff = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openToolDiff(tc.toolName, tc.toolInput);
  }, [tc.toolName, tc.toolInput]);

  return (
    <div>
      <button
        type="button"
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? isExpanded : undefined}
        className={cn(
          "tool-group-item-row",
          expandable && "tool-group-item-row-expandable",
          isExpanded && "tool-group-item-row-open",
        )}
      >
        {expandable
          ? (isExpanded
              ? <ChevronDown size={10} className="tool-group-item-chevron" />
              : <ChevronRight size={10} className="tool-group-item-chevron" />)
          : <span className="tool-group-item-chevron-placeholder" />}
        <span className="tool-group-item-path" title={formatted.tooltip}>
          {formatted.display}
          {resultPreview && (
            <span className="tool-group-item-preview">{resultPreview}</span>
          )}
        </span>
        {formatted.diffStat && <DiffStatBadge stat={formatted.diffStat} onClick={showDiff ? handleDiff : undefined} />}
        <ToolRowFacts facts={rowFacts} compact />
        <span className="tool-group-item-status">
          {tc.status === "success"
            ? <span className="tool-group-item-dot" aria-hidden="true" />
            : <StatusIcon status={tc.status} />}
        </span>
      </button>

      {expandable && (
        <AnimatedToolContent open={isExpanded} inset>
          <ToolExpandedContent
            toolCallId={tc.id}
            toolName={tc.toolName}
            toolInput={tc.toolInput}
            result={tc.result}
            status={tc.status}
            reverted={tc.reverted}
          />
        </AnimatedToolContent>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouped tool call block  (e.g. "Read File  5 files")
// ---------------------------------------------------------------------------

function GroupBlock({ toolName, calls }: { readonly toolName: string; readonly calls: ReadonlyArray<ToolCall> }) {
  const { t, i18n: i18nInstance } = useTranslation();
  const defaultExpandedId = useMemo(() => findDefaultExpandedCallId(calls), [calls]);
  const [open, setOpen] = useState(() => defaultExpandedId !== null);
  const [expandedId, setExpandedId] = useState<string | null>(() => defaultExpandedId);
  const [userToggledOpen, setUserToggledOpen] = useState(false);
  const [userToggledItem, setUserToggledItem] = useState(false);
  const meta = getMeta(toolName);
  const Icon = meta.icon;

  const pendingCount = calls.filter((c) => c.status === "running" || c.status === "pending_confirmation").length;
  const errorCount = calls.filter((c) => c.status === "error" || c.status === "denied").length;
  const warningCount = calls.filter((c) => c.status === "warning").length;
  const successCount = calls.filter((c) => c.status === "success").length;
  const allDone = pendingCount === 0;
  const isReadGroup = calls.length > 0 && calls.every((call) => isReadTool(call.toolName));
  const groupPreview = useMemo(() => {
    const formattedCalls = calls
      .map((call) => formatInput(call.toolName, call.toolInput))
      .filter((value) => value.display.trim().length > 0);
    const displays = formattedCalls.map((value) => value.display);
    if (displays.length === 0) return null;
    const visible = displays.slice(0, 3);
    const hiddenCount = displays.length - visible.length;
    return {
      text: hiddenCount > 0
        ? `${visible.join(", ")} +${hiddenCount}`
        : visible.join(", "),
      title: formattedCalls.map((value) => value.tooltip || value.display).join("\n"),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls, i18nInstance.language]);

  useEffect(() => {
    if (userToggledOpen) return;
    if (defaultExpandedId) setOpen(true);
  }, [defaultExpandedId, userToggledOpen]);

  useEffect(() => {
    if (userToggledItem) return;
    setExpandedId(defaultExpandedId);
  }, [defaultExpandedId, userToggledItem]);

  const handleToggleOpen = useCallback(() => {
    setUserToggledOpen(true);
    if (!open && isReadGroup && !expandedId && !userToggledItem) {
      setExpandedId(findFirstExpandableCallId(calls));
    }
    setOpen((value) => !value);
  }, [calls, expandedId, isReadGroup, open, userToggledItem]);

  const handleToggleItem = useCallback((id: string) => {
    setUserToggledItem(true);
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  return (
    <div
      className="tool-call-block"
      data-tool-group-name={toolName}
      data-preview-read-group={isReadGroup ? (open ? "open" : "collapsed") : undefined}
    >
      {/* Group header */}
      <button
        type="button"
        onClick={handleToggleOpen}
        aria-expanded={open}
        className={cn("tool-call-row tool-call-row-expandable tool-group-header-row", open && "tool-call-row-open")}
        style={{ "--tool-accent-color": meta.accentColor } as React.CSSProperties}
      >
        {open
          ? <ChevronDown size={12} className="tool-call-row-chevron" />
          : <ChevronRight size={12} className="tool-call-row-chevron" />}
        <Icon size={14} className="tool-call-row-icon" />
        <span className="tool-call-row-label">
          {t(meta.label)}
        </span>
        <span className="tool-group-count">
          {calls.length}
        </span>
        {groupPreview && (
          <span className="tool-group-preview" title={groupPreview.title}>
            {groupPreview.text}
          </span>
        )}
        <span className="flex-1" />
        <span className="tool-group-status">
          {!allDone
            ? <Loader2 size={12} className="animate-spin" />
            : <GroupStatusDot errorCount={errorCount} successCount={successCount} warningCount={warningCount} size={6} />}
        </span>
      </button>

      {/* Expanded item list */}
      <AnimatedToolContent open={open}>
        <div>
          {calls.map((tc) => (
            <GroupItem key={tc.id} tc={tc} isExpanded={expandedId === tc.id} onToggle={() => handleToggleItem(tc.id)} />
          ))}
        </div>
      </AnimatedToolContent>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepsContainer — a run of consecutive "process" tool calls rendered as one
// collapsible unit (Cursor-style timeline). Expanded while the run is active;
// collapses to a single summary row once the turn completes.
// ---------------------------------------------------------------------------

/** Runs shorter than this render as flat rows — a container would cost more
 *  clicks than it saves. */
const STEPS_CONTAINER_MIN_CALLS = 3;

/** Tools that always render standalone (user-facing artifacts / interactions),
 *  never folded into the steps container. */
function isStandaloneTool(toolName: string): boolean {
  return isPlanTool(toolName)
    || isTodoTool(toolName)
    || isAskUserQuestionTool(toolName)
    || isImageGenTool(toolName);
}

/** Task-board tools stay out of the steps container, but a consecutive run of
 *  the same tool (e.g. six TaskCreate calls seeding a plan) collapses into one
 *  group row instead of stacking one row per call. */
function isTaskBoardTool(toolName: string): boolean {
  return toolName === "TaskCreate" || toolName === "TaskUpdate"
    || toolName === "TaskGet" || toolName === "TaskList";
}

interface StepsSummary {
  readonly reads: number;
  readonly edits: number;
  readonly searches: number;
  readonly commands: number;
  readonly others: number;
  readonly errors: number;
  readonly added: number;
  readonly removed: number;
}

function buildStepsSummary(calls: ReadonlyArray<ToolCall>): StepsSummary {
  let reads = 0, edits = 0, searches = 0, commands = 0, others = 0, errors = 0, added = 0, removed = 0;
  for (const call of calls) {
    const name = call.toolName;
    if (isReadTool(name) || isDirectoryListTool(name)) reads += 1;
    else if (isFileChangeTool(name)) edits += 1;
    else if (isFileSearchTool(name) || isWebSearchTool(name) || isWebFetchTool(name)) searches += 1;
    else if (isBashTool(name)) commands += 1;
    else others += 1;
    if (call.status === "error" || call.status === "denied") errors += 1;
    if (canShowDiff(name)) {
      const stat = formatInput(name, call.toolInput).diffStat;
      if (stat) {
        added += stat.added;
        removed += stat.removed;
      }
    }
  }
  return { reads, edits, searches, commands, others, errors, added, removed };
}

function StepsSummaryChips({ summary, t }: { readonly summary: StepsSummary; readonly t: TFunction }) {
  const chips: Array<{ key: string; label: string; tone?: "error" }> = [];
  if (summary.reads > 0) chips.push({ key: "reads", label: t("chat.tools.steps.reads", { count: summary.reads }) });
  if (summary.edits > 0) chips.push({ key: "edits", label: t("chat.tools.steps.edits", { count: summary.edits }) });
  if (summary.searches > 0) chips.push({ key: "searches", label: t("chat.tools.steps.searches", { count: summary.searches }) });
  if (summary.commands > 0) chips.push({ key: "commands", label: t("chat.tools.steps.commands", { count: summary.commands }) });
  if (summary.others > 0) chips.push({ key: "others", label: t("chat.tools.steps.others", { count: summary.others }) });
  if (summary.errors > 0) chips.push({ key: "failed", label: t("chat.tools.steps.failed", { count: summary.errors }), tone: "error" });
  return (
    <span className="tool-steps-chips" data-tool-steps-chips="true">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={cn("tool-steps-chip", chip.tone === "error" && "tool-steps-chip-error")}
          data-tool-steps-chip={chip.key}
        >
          {chip.label}
        </span>
      ))}
      {(summary.added > 0 || summary.removed > 0) && (
        <span className="tool-steps-diff" data-tool-steps-chip="diff">
          {summary.added > 0 && <span className="tool-steps-diff-added">+{summary.added}</span>}
          {summary.removed > 0 && <span className="tool-steps-diff-removed">-{summary.removed}</span>}
        </span>
      )}
    </span>
  );
}

/** Shared renderer for a list of calls with same-name grouping — used both by
 *  the flat (short-run) path and inside the steps container timeline. */
function GroupedToolItems({ calls }: {
  readonly calls: ReadonlyArray<ToolCall>;
}) {
  const items = useMemo(() => groupToolCalls(calls), [calls]);
  return (
    <>
      {items.map((item) =>
        item.kind === "single" ? (
          <SingleBlock key={item.call.id} call={item.call} />
        ) : (
          <GroupBlock
            key={`g-${item.calls[0].id}`}
            toolName={item.toolName}
            calls={item.calls}
          />
        ),
      )}
    </>
  );
}

function StepsContainer({ calls }: {
  readonly calls: ReadonlyArray<ToolCall>;
}) {
  const { t, i18n: i18nInstance } = useTranslation();
  // Collapsed by default — the summary row (live tool label while running,
  // aggregate chips once done) is enough at a glance; the full timeline only
  // mounts when the user opens it. This keeps long tool runs to a single line.
  const [open, setOpen] = useState(false);

  const hasPending = calls.some(
    (c) => c.status === "running" || c.status === "pending_confirmation",
  );
  const summary = useMemo(() => buildStepsSummary(calls), [calls]);

  const runningCall = useMemo(() => {
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      if (calls[i].status === "running") return calls[i];
    }
    return null;
  }, [calls]);
  const runningLabel = useMemo(() => {
    if (!runningCall) return null;
    const meta = getMeta(runningCall.toolName);
    const display = formatInput(runningCall.toolName, runningCall.toolInput).display;
    return display ? `${t(meta.label)} · ${display}` : t(meta.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningCall, t, i18nInstance.language]);

  const handleToggle = useCallback(() => {
    setOpen((value) => !value);
  }, []);

  return (
    <div
      className={cn("tool-steps-container", open && "tool-steps-container-open")}
      data-tool-steps-container={open ? "open" : "collapsed"}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className={cn("tool-steps-header", hasPending && "tool-steps-header-active")}
      >
        {open
          ? <ChevronDown size={12} className="tool-call-row-chevron" />
          : <ChevronRight size={12} className="tool-call-row-chevron" />}
        <span className="tool-steps-title">
          {hasPending && runningLabel
            ? runningLabel
            : t("chat.tools.steps.summary", { count: calls.length })}
        </span>
        {!hasPending && <StepsSummaryChips summary={summary} t={t} />}
        <span className="flex-1" />
        <span className="tool-steps-status">
          {hasPending
            ? <Loader2 size={12} className="animate-spin" />
            : (
              <GroupStatusDot
                errorCount={summary.errors}
                successCount={calls.length - summary.errors}
                size={6}
              />
            )}
        </span>
      </button>

      <AnimatedToolContent open={open}>
        <div className="tool-steps-timeline">
          <GroupedToolItems calls={calls} />
        </div>
      </AnimatedToolContent>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public: renders a list of tool calls with automatic grouping
// ---------------------------------------------------------------------------

type RenderRun =
  | { kind: "standalone"; call: ToolCall }
  | { kind: "task-group"; toolName: string; calls: ToolCall[] }
  | { kind: "steps"; calls: ToolCall[] };

export function ToolCallList({ toolCalls }: {
  readonly toolCalls: ReadonlyArray<ToolCall>;
}) {
  // Partition into runs: standalone (interactive) tools render in place;
  // consecutive same-name task-board calls merge into one collapsible group;
  // consecutive process tools form a run that may fold into a StepsContainer.
  const runs = useMemo(() => {
    const out: RenderRun[] = [];
    for (const call of toolCalls) {
      const last = out[out.length - 1];
      if (isTaskBoardTool(call.toolName)) {
        if (last?.kind === "task-group" && last.toolName === call.toolName) {
          last.calls.push(call);
        } else {
          out.push({ kind: "task-group", toolName: call.toolName, calls: [call] });
        }
        continue;
      }
      if (isStandaloneTool(call.toolName)) {
        out.push({ kind: "standalone", call });
        continue;
      }
      if (last?.kind === "steps") {
        last.calls.push(call);
      } else {
        out.push({ kind: "steps", calls: [call] });
      }
    }
    return out;
  }, [toolCalls]);

  return (
    <div className="flex flex-col" style={{ marginTop: 2, gap: 4 }}>
      {runs.map((run) => {
        if (run.kind === "standalone") {
          return <SingleBlock key={run.call.id} call={run.call} />;
        }
        if (run.kind === "task-group") {
          return run.calls.length >= 2 ? (
            <GroupBlock
              key={`tg-${run.calls[0].id}`}
              toolName={run.toolName}
              calls={run.calls}
            />
          ) : (
            <SingleBlock key={run.calls[0].id} call={run.calls[0]} />
          );
        }
        if (run.calls.length < STEPS_CONTAINER_MIN_CALLS) {
          return (
            <GroupedToolItems
              key={`r-${run.calls[0].id}`}
              calls={run.calls}
            />
          );
        }
        return (
          <StepsContainer
            key={`s-${run.calls[0].id}`}
            calls={run.calls}
          />
        );
      })}
    </div>
  );
}
