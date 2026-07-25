import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Check,
  X,
  ShieldAlert,
  Ban,
  Copy,
  AlertTriangle,
  Globe,
  FolderOpen,
  FileText,
  ClipboardCopy,
  Image as ImageIcon,
  ExternalLink,
  Files,
  FilePlus2,
  FileX2,
  PencilLine,
  Undo2,
  Loader2,
  Clock,
} from "lucide-react";
import hljs from "highlight.js/lib/common";
import { AnsiUp } from "ansi_up";
import type { ToolCall } from "@/stores/chat-store";
import { useChatStore } from "@/stores/chat-store";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { getFileIcon } from "@/components/file-tree/file-icons";
import { MAX_RESULT_LINES } from "./tool-renderer-registry";
import type { DiffStat } from "./tool-renderer-registry";
import { openResolvedToolFile, openToolDiffTab, openToolFile } from "./tool-action-bridge";

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function openUrlInSystemBrowser(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

async function openPathInSystem(path: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

async function revealPathInSystem(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

async function copyImagePathToClipboard(path: string): Promise<void> {
  const [{ Image }, { writeImage }] = await Promise.all([
    import("@tauri-apps/api/image"),
    import("@tauri-apps/plugin-clipboard-manager"),
  ]);
  const img = await Image.fromPath(path);
  await writeImage(img);
}

// ---------------------------------------------------------------------------
// DiffStatBadge
// ---------------------------------------------------------------------------

export function DiffStatBadge({
  stat,
  onClick,
}: {
  readonly stat: DiffStat;
  readonly onClick?: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const interactive = !!onClick;

  const handleKeyDown = interactive
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onClick?.(e as unknown as React.MouseEvent);
        }
      }
    : undefined;

  return (
    <span
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={handleKeyDown}
      className={`inline-flex items-center shrink-0${interactive ? " cursor-pointer transition-opacity hover:opacity-80" : ""}`}
      style={{
        backgroundColor: "var(--color-diff-badge-bg)",
        borderRadius: 10,
        padding: "3px 8px",
        gap: 6,
        fontFamily: "var(--font-mono)",
      }}
      title={interactive ? t("chat.tools.result.diffCompareTitle") : undefined}
    >
      {stat.added > 0 && (
        <span style={{ color: "var(--color-diff-badge-added)", fontSize: 10, fontWeight: 600 }}>
          +{stat.added}
        </span>
      )}
      {stat.removed > 0 && (
        <span style={{ color: "var(--color-diff-badge-removed)", fontSize: 10, fontWeight: 600 }}>
          -{stat.removed}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// StatusIcon
// ---------------------------------------------------------------------------

export function StatusIcon({ status }: { readonly status: ToolCall["status"] }) {
  switch (status) {
    case "running":
      return (
        <span
          className="thinking-spinner-active shrink-0"
          style={{
            display: "inline-block",
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid transparent",
            borderTopColor: "#F59E0B",
            opacity: 0.8,
          }}
        />
      );

    case "success":
      return <Check size={14} className="text-[#10B981] shrink-0" />;
    case "warning":
      return <AlertTriangle size={14} className="text-[#F59E0B] shrink-0" />;
    case "error":
      return <X size={14} className="text-[#EF4444] shrink-0" />;
    case "pending_confirmation":
      return <ShieldAlert size={14} className="text-[#F59E0B] shrink-0" />;
    case "denied":
      return <Ban size={14} className="text-[#EF4444] shrink-0" />;
  }
}

// ---------------------------------------------------------------------------
// ConfirmationActions - inline quick-action buttons for tool call confirmation
// ---------------------------------------------------------------------------

/**
 * Inline quick-action buttons for tool call confirmation.
 * The modal dialog (ToolConfirmDialog) is the primary UI; these provide
 * a compact inline alternative within the tool call block.
 */
export function ConfirmationActions({
  toolCallId,
  confirmId,
}: {
  readonly toolCallId: string;
  readonly confirmId: string;
}) {
  const { t } = useTranslation();

  const handleApprove = useCallback(() => {
    useChatStore.getState().resolveToolCallConfirmation(toolCallId, true);
    invokeTauri("respond_tool_confirmation", { confirmId, approved: true }).catch(() => {});
  }, [toolCallId, confirmId]);

  const handleDeny = useCallback(() => {
    useChatStore.getState().resolveToolCallConfirmation(toolCallId, false);
    invokeTauri("respond_tool_confirmation", { confirmId, approved: false }).catch(() => {});
  }, [toolCallId, confirmId]);

  return (
    <div className="flex items-center gap-2 ml-auto shrink-0">
      <button
        type="button"
        onClick={handleDeny}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold font-sans transition-colors hover:bg-[#EF4444]/20 text-[#EF4444]"
        style={{ border: "1px solid #EF444440" }}
      >
        <X size={10} />
        {t("chat.tools.actions.deny")}
      </button>
      <button
        type="button"
        onClick={handleApprove}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold font-sans transition-colors hover:bg-[#10B981]/20 text-[#10B981]"
        style={{ border: "1px solid #10B98140" }}
      >
        <Check size={10} />
        {t("chat.tools.actions.allow")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultContent - collapsible output display for tool results
// ---------------------------------------------------------------------------

interface FormatResult {
  readonly text: string;
  readonly isJson: boolean;
  readonly parsed?: unknown;
}

/** Heuristic: does the string look like it starts with JSON structure? */
function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return (t.startsWith("{") || t.startsWith("[")) && t.length > 2;
}

/** Naïve JSON-like formatter for strings that look like JSON but fail
 *  strict parsing (e.g. truncated responses). Adds newlines + indentation
 *  around braces, brackets, and commas. */
function naiveJsonFormat(text: string): string {
  let indent = 0;
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      result += ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      indent++;
      result += ch + "\n" + "  ".repeat(indent);
    } else if (ch === "}" || ch === "]") {
      indent = Math.max(0, indent - 1);
      result += "\n" + "  ".repeat(indent) + ch;
    } else if (ch === ",") {
      result += ",\n" + "  ".repeat(indent);
    } else if (ch === ":") {
      result += ": ";
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      // skip existing whitespace outside strings
    } else {
      result += ch;
    }
  }

  return result;
}

/** Try to pretty-print a string if it is valid JSON.
 *  Handles double-serialised values (e.g. `"\"[{...}]\""`) by unwrapping
 *  until we reach a non-string value or parsing fails.
 *  Falls back to naïve formatting for truncated/invalid JSON-like text. */
function tryFormatJson(text: string): FormatResult {
  let current: string = text.trim();

  // Keep unwrapping while the value is a JSON-encoded string
  for (;;) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      // Strict parse failed — try naïve formatting if it looks like JSON
      if (looksLikeJson(current)) {
        return { text: naiveJsonFormat(current), isJson: true };
      }
      return { text: current, isJson: false };
    }

    if (typeof parsed === "string") {
      current = parsed;
      continue;
    }

    return { text: JSON.stringify(parsed, null, 2), isJson: true, parsed };
  }
}

interface JsonOutputSummary {
  readonly kind: "array" | "object" | "value" | "json-like";
  readonly countLabel: string;
  readonly keys: readonly string[];
}

function getJsonOutputSummary(value: unknown, t: TFunction): JsonOutputSummary {
  if (Array.isArray(value)) {
    const firstObject = value.find(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    ) as Record<string, unknown> | undefined;
    return {
      kind: "array",
      countLabel: t("chat.tools.result.jsonItems", { count: value.length }),
      keys: firstObject ? Object.keys(firstObject).slice(0, 5) : [],
    };
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return {
      kind: "object",
      countLabel: t("chat.tools.result.jsonKeys", { count: keys.length }),
      keys: keys.slice(0, 5),
    };
  }

  if (value !== undefined) {
    return {
      kind: "value",
      countLabel: typeof value,
      keys: [],
    };
  }

  return {
    kind: "json-like",
    countLabel: t("chat.tools.result.jsonFormatted"),
    keys: [],
  };
}

function getJsonKindLabel(kind: JsonOutputSummary["kind"], t: TFunction): string {
  switch (kind) {
    case "array":
      return t("chat.tools.result.jsonArray");
    case "object":
      return t("chat.tools.result.jsonObject");
    case "value":
      return t("chat.tools.result.jsonValue");
    case "json-like":
      return t("chat.tools.result.jsonLike");
  }
}

function JsonOutputPanel({
  formatted,
  parsed,
}: {
  readonly formatted: string;
  readonly parsed?: unknown;
}) {
  const { t } = useTranslation();
  const summary = useMemo(() => getJsonOutputSummary(parsed, t), [parsed, t]);

  return (
    <ToolOutputPanel copyText={formatted} label={t("chat.tools.result.jsonLabel")}>
      <div
        className="tool-json-panel"
        data-tool-json-panel="true"
        data-tool-json-kind={summary.kind}
      >
        <div className="tool-json-summary" data-tool-json-summary="true">
          <span className="tool-json-chip" data-tool-json-chip="kind">
            {getJsonKindLabel(summary.kind, t)}
          </span>
          <span className="tool-json-chip" data-tool-json-chip="count">
            {summary.countLabel}
          </span>
          {summary.keys.length > 0 && (
            <span className="tool-json-chip tool-json-chip-wide" data-tool-json-chip="keys">
              {summary.keys.join(", ")}
            </span>
          )}
        </div>
        <div className="tool-json-code" data-tool-json-code="true">
          <HighlightedInlineCode code={formatted} language="json" />
        </div>
      </div>
    </ToolOutputPanel>
  );
}

// ---------------------------------------------------------------------------
// Agent content-block extraction
// ---------------------------------------------------------------------------

/** Tools whose results may be an array of content blocks [{type:"text",text:"..."}] */
const AGENT_TOOL_NAMES = new Set(["Agent", "Task", "TaskOutput"]);

/** Extract readable text from an Agent tool result.
 *  Handles three formats:
 *  1. JSON content-block array: [{type:"text", text:"..."}]
 *  2. Double-serialised JSON string wrapping case 1 or plain text
 *  3. Escaped JSON with missing outer string quotes: [{\"type\":\"text\",...}]
 *  4. Plain text / markdown (already unwrapped by sidecar) */
function tryDecodeEscapedJsonString(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.includes('\\"')) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  try {
    return JSON.parse(
      `"${trimmed.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`,
    ) as string;
  } catch {
    return null;
  }
}

/** Last-resort extraction for a content-block array whose JSON is malformed —
 *  e.g. persisted history produced by an older sidecar that stringified the
 *  array and then truncated it mid-string, breaking JSON.parse. Pulls out the
 *  `text` field values via regex and decodes JSON string escapes. */
function tryExtractTruncatedBlocks(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\[\s*\{/.test(trimmed)) return null;

  const matches = [...trimmed.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)/g)];
  if (matches.length === 0) return null;

  const texts = matches.map((m) => {
    const body = m[1];
    try {
      return JSON.parse(`"${body}"`) as string;
    } catch {
      // Body may end mid-escape (truncation): decode known escapes manually.
      return body
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  });

  const joined = texts.join("\n\n").trim();
  return joined.length > 0 ? joined : null;
}

function tryExtractAgentText(result: string): string | null {
  let current = result.trim();
  if (!current) return null;

  // Unwrap JSON layers (handles double-serialisation and content-block arrays)
  for (;;) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      const decoded = tryDecodeEscapedJsonString(current);
      if (decoded && decoded !== current) {
        current = decoded.trim();
        continue;
      }

      // JSON.parse failed on something that still looks like a content-block
      // array (e.g. truncated mid-string) — salvage the text fields by regex.
      const salvaged = tryExtractTruncatedBlocks(current);
      if (salvaged) return salvaged;

      // Not valid JSON — current is already the raw text content
      return current;
    }

    // Content-block array: extract text fields
    if (Array.isArray(parsed)) {
      const texts = (parsed as unknown[])
        .filter(
          (b): b is Record<string, unknown> =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>).type === "text" &&
            typeof (b as Record<string, unknown>).text === "string",
        )
        .map((b) => b.text as string);
      return texts.length > 0 ? texts.join("\n\n") : null;
    }

    // Serialised string — unwrap one layer and continue
    if (typeof parsed === "string") {
      current = parsed;
      continue;
    }

    // Other JSON (object, number, etc.) — not agent text
    return null;
  }
}

interface AgentMarkdownOutline {
  readonly title: string;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly findingCount: number;
  readonly sectionCount: number;
}

function cleanMarkdownInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function parseAgentMarkdownOutline(markdown: string): AgentMarkdownOutline {
  const lines = markdown.split("\n");
  const headings: string[] = [];
  const findings: string[] = [];
  let summary = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading?.[1]) {
      headings.push(cleanMarkdownInline(heading[1]));
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) {
      findings.push(cleanMarkdownInline(bullet[1]));
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered?.[1]) {
      findings.push(cleanMarkdownInline(numbered[1]));
      continue;
    }

    if (!summary && !line.startsWith(">")) {
      summary = cleanMarkdownInline(line);
    }
  }

  return {
    title: headings[0] ?? "",
    summary,
    findings,
    findingCount: findings.length,
    sectionCount: headings.length,
  };
}

function AgentOutputPanel({ markdown }: { readonly markdown: string }) {
  const { t } = useTranslation();
  const outline = useMemo(() => parseAgentMarkdownOutline(markdown), [markdown]);
  const visibleFindings = outline.findings.slice(0, 5);
  const title = outline.title || t("chat.tools.result.agentOutputLabel");

  return (
    <ToolOutputPanel
      copyText={markdown}
      label={t("chat.tools.result.agentOutputLabel")}
      bodyVariant="longform"
    >
      <div className="tool-agent-output" data-tool-agent-output="true">
        <div className="tool-agent-scan" data-tool-agent-scan="true">
          <div className="tool-agent-scan-main">
            <span className="tool-agent-kicker">{t("chat.tools.result.agentQuickScan")}</span>
            <strong className="tool-agent-title">{title}</strong>
            {outline.summary && <p className="tool-agent-summary">{outline.summary}</p>}
          </div>
          <div className="tool-agent-metrics">
            {outline.findingCount > 0 && (
              <span className="tool-agent-metric" data-tool-agent-metric="findings">
                {t("chat.tools.result.agentFindings", { count: outline.findingCount })}
              </span>
            )}
            {outline.sectionCount > 0 && (
              <span className="tool-agent-metric" data-tool-agent-metric="sections">
                {t("chat.tools.result.agentSections", { count: outline.sectionCount })}
              </span>
            )}
          </div>
        </div>

        {visibleFindings.length > 0 && (
          <ol className="tool-agent-findings" data-tool-agent-findings="true">
            {visibleFindings.map((finding, index) => (
              <li
                key={`${finding}-${index}`}
                className="tool-agent-finding"
                data-tool-agent-finding="true"
              >
                <span className="tool-agent-finding-index">{index + 1}</span>
                <span>{finding}</span>
              </li>
            ))}
          </ol>
        )}

        <div className="tool-output-markdown tool-agent-markdown" data-tool-agent-markdown="true">
          <MarkdownRenderer content={markdown} variant="compact" />
        </div>
      </div>
    </ToolOutputPanel>
  );
}

// ---------------------------------------------------------------------------
// Read tool: syntax-highlighted code display
// ---------------------------------------------------------------------------

/** Tools whose results are file content that benefits from syntax highlighting */
const CODE_RESULT_TOOLS = new Set(["Read", "read_file", "read_many_files"]);

function parseToolInputObject(toolInput: string): Record<string, unknown> | null {
  try {
    const input = JSON.parse(toolInput) as unknown;
    return input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseReadFilePath(toolInput: string): string | null {
  const input = parseToolInputObject(toolInput);
  const filePath = parseToolFilePath(input);
  return filePath || null;
}

function parseToolFilePath(input: Record<string, unknown> | null): string {
  const direct =
    (input?.file_path as string | undefined) ?? (input?.path as string | undefined) ?? "";
  if (direct) return direct;
  const changes = input?.changes as ReadonlyArray<{ path?: string }> | undefined;
  const firstPath = changes?.[0]?.path;
  return typeof firstPath === "string" ? firstPath : "";
}

function parseReadManyFilePaths(toolInput: string): string[] {
  const input = parseToolInputObject(toolInput);
  const rawPaths = input?.paths ?? input?.file_paths ?? input?.files;
  if (!Array.isArray(rawPaths)) return [];

  const paths: string[] = [];
  for (const item of rawPaths) {
    if (typeof item === "string" && item.trim()) {
      paths.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const path = (obj.file_path as string | undefined) ?? (obj.path as string | undefined);
      if (path?.trim()) paths.push(path.trim());
    }
  }
  return paths;
}

/** Strip line-number prefixes (e.g. "380\t  code") from Read tool output. */
function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  // Verify the first non-empty line actually has a line-number prefix
  const firstContent = lines.find((l) => l.trim());
  if (!firstContent || !/^\d+\t/.test(firstContent)) return text;

  return lines
    .map((line) => {
      const m = line.match(/^\d+\t(.*)/);
      return m ? m[1] : line;
    })
    .join("\n");
}

/** Try to extract a highlight language from a Read/read_file tool's input JSON. */
function detectReadLanguage(toolInput: string): string | null {
  const filePath = parseReadFilePath(toolInput);
  if (!filePath) return null;
  const ext = getFileExtension(filePath);
  return getHljsLanguage(ext) ?? null;
}

// ---------------------------------------------------------------------------
// Shared "show more / collapse" toggle button
// ---------------------------------------------------------------------------

function ExpandCollapseButton({
  expanded,
  hiddenCount,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onToggle}
      className="text-[11px] font-mono mt-1 native-css-hover"
      style={
        {
          color: "var(--color-tool-result-link)",
          "--native-hover-color": "var(--color-tool-result-link-hover)",
        } as React.CSSProperties
      }
    >
      {expanded
        ? t("chat.tools.result.collapse")
        : t("chat.tools.result.moreLines", { count: hiddenCount })}
    </button>
  );
}

function ToolOutputPanel({
  copyText,
  label,
  children,
  bodyVariant = "default",
}: {
  readonly copyText: string;
  readonly label?: string;
  readonly children: ReactNode;
  readonly bodyVariant?: "default" | "longform";
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(copyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [copyText]);

  return (
    <div className="tool-output-panel" data-tool-output-panel="true">
      <div className="tool-output-panel-header">
        <span className="tool-output-panel-label">
          {label ?? t("chat.tools.result.outputLabel")}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="tool-output-panel-copy"
          data-tool-action="copy-output"
          title={t("chat.tools.result.copyOutput")}
        >
          {copied ? (
            <>
              <Check size={12} />
              <span>{t("chat.tools.result.copied")}</span>
            </>
          ) : (
            <Copy size={12} />
          )}
        </button>
      </div>
      <div
        className={`tool-output-panel-body${bodyVariant === "longform" ? " tool-output-panel-body-longform" : ""}`}
        data-tool-output-panel-body={bodyVariant}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ResultContent
// ---------------------------------------------------------------------------

export function ResultContent({
  result,
  toolName,
  toolInput,
}: {
  readonly result: string;
  readonly toolName?: string;
  readonly toolInput?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // ── Agent tools: render as Markdown ──
  const agentMarkdown = useMemo(() => {
    if (!toolName || !AGENT_TOOL_NAMES.has(toolName)) return null;
    return tryExtractAgentText(result);
  }, [result, toolName]);

  const codeHighlight = useMemo(() => {
    if (!toolName || !CODE_RESULT_TOOLS.has(toolName) || !toolInput) return null;
    const filePath = parseReadFilePath(toolInput);
    if (!filePath) return null;
    const lang = detectReadLanguage(toolInput);
    if (!lang) return null;
    const code = stripLineNumbers(result);
    return { code, lang, filePath };
  }, [result, toolName, toolInput]);

  const readMany = useMemo(() => {
    if (toolName !== "read_many_files" || !toolInput) return null;
    const paths = parseReadManyFilePaths(toolInput);
    return paths.length > 0 ? { paths } : null;
  }, [toolInput, toolName]);

  const formattedResult = useMemo(() => tryFormatJson(result), [result]);

  if (agentMarkdown !== null) {
    return <AgentOutputPanel markdown={agentMarkdown} />;
  }

  // ── Read tool: syntax-highlighted code block ──
  if (codeHighlight) {
    return (
      <ReadFilePreviewCard
        filePath={codeHighlight.filePath}
        code={codeHighlight.code}
        language={codeHighlight.lang}
      />
    );
  }

  if (readMany) {
    return <ReadManyFilesCard paths={readMany.paths} result={result} />;
  }

  // ── Default: JSON or plain text ──
  const { text: formatted, isJson } = formattedResult;

  if (isJson) {
    return <JsonOutputPanel formatted={formatted} parsed={formattedResult.parsed} />;
  }

  const lines = formatted.split("\n");
  const isLong = lines.length > MAX_RESULT_LINES;
  const visibleText = expanded ? formatted : lines.slice(0, MAX_RESULT_LINES).join("\n");

  return (
    <ToolOutputPanel copyText={formatted}>
      <pre className="tool-output-pre">{visibleText}</pre>
      {isLong && (
        <ExpandCollapseButton
          expanded={expanded}
          hiddenCount={lines.length - MAX_RESULT_LINES}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </ToolOutputPanel>
  );
}

// ---------------------------------------------------------------------------
// ImageGenContent — render saved PNGs returned by openai_images.generate_image
// ---------------------------------------------------------------------------

interface GeneratedImageItem {
  readonly path: string;
  readonly size?: string;
}

/** Recursively walk a parsed MCP result and pull out the first `images` array
 *  whose entries look like `{ path: string }`. Defends against codex wrapping
 *  the payload as `{ content: [{ type: "text", text: "<json>" }] }` or sending
 *  a doubly-stringified JSON. */
function extractGeneratedImages(raw: string): GeneratedImageItem[] {
  const seen = new Set<unknown>();
  function walk(value: unknown): GeneratedImageItem[] | null {
    if (!value || seen.has(value)) return null;
    if (typeof value === "object") seen.add(value);

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return walk(JSON.parse(trimmed));
        } catch {
          return null;
        }
      }
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const imgs = obj.images;
      if (Array.isArray(imgs)) {
        const items: GeneratedImageItem[] = [];
        for (const it of imgs) {
          if (it && typeof it === "object") {
            const p = (it as Record<string, unknown>).path;
            if (typeof p === "string" && p.length > 0) {
              const s = (it as Record<string, unknown>).size;
              items.push({ path: p, size: typeof s === "string" ? s : undefined });
            }
          }
        }
        if (items.length > 0) return items;
      }
      // Common nested shapes: { content: [{ type: "text", text }] }
      for (const key of Object.keys(obj)) {
        const found = walk(obj[key]);
        if (found) return found;
      }
    }
    return null;
  }
  try {
    return walk(raw) ?? [];
  } catch {
    return [];
  }
}

interface ImageContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly path: string;
}

export function ImageGenContent({ result }: { readonly result: string }) {
  const { t } = useTranslation();
  const images = useMemo(() => extractGeneratedImages(result), [result]);
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ImageContextMenuState | null>(null);
  // MCP `size` may be "auto", in which case we don't know the aspect ratio
  // until the bytes arrive; record naturalWidth/Height from the <img> on
  // load so the box can resize from a 1:1 fallback to the real ratio.
  const [naturalSizes, setNaturalSizes] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    for (const img of images) {
      if (dataUrls[img.path] || errors[img.path]) continue;
      invokeTauri<string>("read_file_base64", { path: img.path })
        .then((b64) => {
          if (cancelled) return;
          setDataUrls((prev) => ({ ...prev, [img.path]: `data:image/png;base64,${b64}` }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setErrors((prev) => ({ ...prev, [img.path]: msg }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [images, dataUrls, errors]);

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopiedPath(path);
        setTimeout(() => setCopiedPath(null), 2000);
      })
      .catch(() => {});
  }, []);

  const handleReveal = useCallback((path: string) => {
    revealPathInSystem(path).catch(() => {});
  }, []);

  const closeLightbox = useCallback(() => setLightbox(null), []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLightbox();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox, closeLightbox]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-image-ctx-menu]")) return;
      closeCtxMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCtxMenu();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeCtxMenu);
    window.addEventListener("scroll", closeCtxMenu, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeCtxMenu);
      window.removeEventListener("scroll", closeCtxMenu, true);
    };
  }, [ctxMenu, closeCtxMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (!dataUrls[path]) return;
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, path });
    },
    [dataUrls],
  );

  const handleCopyImage = useCallback(
    async (path: string) => {
      closeCtxMenu();
      // Use Tauri's native bridge: Image.fromPath decodes the PNG on the Rust
      // side (via tauri "image-png" cargo feature), and writeImage writes the
      // decoded RGBA bitmap into the OS clipboard. The browser-only
      // `navigator.clipboard.write([ClipboardItem])` path is unreliable in
      // WKWebView/WebView2; passing raw PNG bytes to writeImage misinterprets
      // them as raw RGBA pixels.
      try {
        await copyImagePathToClipboard(path);
      } catch (err) {
        console.warn("[image-gen] copy image failed:", err);
      }
    },
    [closeCtxMenu],
  );

  const handleOpenImage = useCallback(
    (path: string) => {
      closeCtxMenu();
      openPathInSystem(path).catch(() => {});
    },
    [closeCtxMenu],
  );

  if (images.length === 0) {
    return (
      <pre
        className="text-[11px] font-mono whitespace-pre-wrap break-all"
        style={{ lineHeight: 1.5, color: "var(--color-tool-result-text)" }}
      >
        {result}
      </pre>
    );
  }

  const { maxWidth: boundsW, maxHeight: boundsH } = pickDisplayBounds(images.length);

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {images.map((img, idx) => {
          const url = dataUrls[img.path];
          const err = errors[img.path];
          const isCopied = copiedPath === img.path;
          // Prefer natural dimensions reported by <img> on load over the
          // MCP `size` hint — the latter is "auto" for many calls.
          const sizeHint = naturalSizes[img.path] ?? img.size;
          const dims = computeImageDisplaySize(sizeHint, boundsW, boundsH);
          return (
            <div key={img.path} className="flex flex-col gap-1.5">
              <button
                onClick={() => url && setLightbox(idx)}
                onContextMenu={(e) => handleContextMenu(e, img.path)}
                className="relative rounded-lg overflow-hidden group native-css-hover"
                style={
                  {
                    width: dims.width,
                    height: dims.height,
                    border: "1px solid var(--color-border)",
                    backgroundColor: "var(--color-surface-alt)",
                    cursor: url ? "zoom-in" : "default",
                    boxShadow: url ? "var(--shadow-card)" : "none",
                    transition: "width 240ms ease, height 240ms ease, transform 200ms ease",
                    "--native-hover-shadow": url ? "var(--shadow-float)" : undefined,
                  } as React.CSSProperties
                }
                title={img.path}
              >
                {url ? (
                  <img
                    src={url}
                    alt=""
                    className="w-full h-full object-contain"
                    onLoad={(e) => {
                      const { naturalWidth: nw, naturalHeight: nh } = e.currentTarget;
                      if (nw > 0 && nh > 0) {
                        setNaturalSizes((prev) =>
                          prev[img.path] ? prev : { ...prev, [img.path]: `${nw}x${nh}` },
                        );
                      }
                    }}
                  />
                ) : err ? (
                  <div className="flex items-center justify-center w-full h-full p-2 text-[10px] font-mono text-red-400 break-all">
                    {err}
                  </div>
                ) : (
                  <div className="flex items-center justify-center w-full h-full text-[11px] font-mono text-muted">
                    loading…
                  </div>
                )}
                {img.size && (
                  <span
                    className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-mono"
                    style={{ backgroundColor: "rgba(0,0,0,0.55)", color: "#fff" }}
                  >
                    {img.size}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-1" style={{ width: dims.width }}>
                <button
                  type="button"
                  onClick={() => handleCopyPath(img.path)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono native-css-hover"
                  style={
                    {
                      color: isCopied ? "var(--color-accent-success)" : "var(--color-muted)",
                      border: "1px solid var(--color-border)",
                      "--native-hover-bg-color": !isCopied
                        ? "var(--color-inline-diff-header)"
                        : undefined,
                    } as React.CSSProperties
                  }
                  title={img.path}
                >
                  {isCopied ? <Check size={10} /> : <ClipboardCopy size={10} />}
                  {isCopied ? t("chat.tools.result.copied") : t("chat.tools.imageGen.copyPath")}
                </button>
                <button
                  type="button"
                  onClick={() => handleReveal(img.path)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors native-css-hover"
                  style={
                    {
                      color: "var(--color-muted)",
                      border: "1px solid var(--color-border)",
                      "--native-hover-bg-color": "var(--color-inline-diff-header)",
                    } as React.CSSProperties
                  }
                >
                  <FolderOpen size={10} />
                  {t("chat.tools.imageGen.reveal")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {lightbox !== null &&
        dataUrls[images[lightbox].path] &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ backgroundColor: "rgba(0,0,0,0.85)", cursor: "zoom-out" }}
            onClick={closeLightbox}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeLightbox();
              }}
              aria-label="Close"
              className="absolute top-4 right-4 flex items-center justify-center rounded-full transition-colors native-css-hover"
              style={
                {
                  width: 36,
                  height: 36,
                  backgroundColor: "rgba(255,255,255,0.12)",
                  color: "#fff",
                  cursor: "pointer",
                  "--native-hover-bg-color": "rgba(255,255,255,0.22)",
                } as React.CSSProperties
              }
            >
              <X size={18} />
            </button>
            <img
              src={dataUrls[images[lightbox].path]}
              alt=""
              className="max-w-[92vw] max-h-[92vh] object-contain"
              style={{ cursor: "default" }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => handleContextMenu(e, images[lightbox].path)}
            />
          </div>,
          document.body,
        )}

      {ctxMenu &&
        createPortal(
          <div
            data-image-ctx-menu
            role="menu"
            className="fixed z-[10000] rounded-md overflow-hidden"
            style={{
              top: ctxMenu.y,
              left: ctxMenu.x,
              minWidth: 180,
              backgroundColor: "var(--color-card)",
              border: "1px solid var(--color-border)",
              boxShadow: "var(--shadow-popup)",
              padding: 4,
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => handleCopyImage(ctxMenu.path)}
              className="flex items-center w-full gap-2 px-2 py-1.5 rounded text-[12px] font-sans transition-colors native-css-hover"
              style={
                {
                  color: "var(--color-foreground)",
                  backgroundColor: "transparent",
                  "--native-hover-bg-color": "var(--color-inline-diff-header)",
                } as React.CSSProperties
              }
            >
              <ImageIcon size={13} style={{ color: "var(--color-muted)" }} />
              <span className="flex-1 text-left">{t("chat.tools.imageGen.copyImage")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleOpenImage(ctxMenu.path)}
              className="flex items-center w-full gap-2 px-2 py-1.5 rounded text-[12px] font-sans transition-colors native-css-hover"
              style={
                {
                  color: "var(--color-foreground)",
                  backgroundColor: "transparent",
                  "--native-hover-bg-color": "var(--color-inline-diff-header)",
                } as React.CSSProperties
              }
            >
              <ExternalLink size={13} style={{ color: "var(--color-muted)" }} />
              <span className="flex-1 text-left">{t("chat.tools.imageGen.openImage")}</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ImageGenBlock — full inline replacement for the standard tool-call wrapper
// when the call is the openai_images generate_image MCP tool. Shows skeleton
// placeholders during generation, then swaps in the real images.
// ---------------------------------------------------------------------------

interface ImageGenInput {
  readonly prompt: string;
  readonly n: number;
  readonly width: number;
  readonly height: number;
  /** Source image paths for edit_image (empty for generate_image). */
  readonly sourcePaths: readonly string[];
}

// Both axes are constrained independently, then the image is scaled to
// "contain" — yields 720×405 for 16:9 horizontal, 540×540 for square,
// 360×540 for 2:3 vertical, etc. Splitting the bound this way (vs a single
// "longest edge = N" base) prevents horizontal images from looking cramped
// and vertical ones from looking tower-like.
//
// Single-image layouts use the full bound; when multiple images share a row
// the bound shrinks so a 2-up or 3-up grid still fits within the chat
// column (~760px max).
const MAX_DISPLAY_WIDTH = 720;
const MAX_DISPLAY_HEIGHT = 540;
const MAX_DISPLAY_WIDTH_DUO = 480;
const MAX_DISPLAY_HEIGHT_DUO = 360;
const MAX_DISPLAY_WIDTH_GRID = 340;
const MAX_DISPLAY_HEIGHT_GRID = 260;

function pickDisplayBounds(count: number): { maxWidth: number; maxHeight: number } {
  if (count <= 1) return { maxWidth: MAX_DISPLAY_WIDTH, maxHeight: MAX_DISPLAY_HEIGHT };
  if (count === 2) return { maxWidth: MAX_DISPLAY_WIDTH_DUO, maxHeight: MAX_DISPLAY_HEIGHT_DUO };
  return { maxWidth: MAX_DISPLAY_WIDTH_GRID, maxHeight: MAX_DISPLAY_HEIGHT_GRID };
}

/** Compute the display box for an image given its native size.
 *
 *  `size` is a "WxH" string from the MCP payload (e.g. "1536x1024") or the
 *  natural dimensions of the loaded `<img>`. When the hint is missing or a
 *  non-numeric token like `"auto"`, fall back to a square box at the
 *  smaller of the two bounds — `<ImageGenContent>` will resize once the
 *  real image lands and reports `naturalWidth/Height`. */
function computeImageDisplaySize(
  size: string | undefined,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (size) {
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > 0 && h > 0) {
        const scale = Math.min(maxWidth / w, maxHeight / h);
        return {
          width: Math.max(1, Math.round(w * scale)),
          height: Math.max(1, Math.round(h * scale)),
        };
      }
    }
  }
  const side = Math.min(maxWidth, maxHeight);
  return { width: side, height: side };
}

function parseImageGenInput(toolInput: string): ImageGenInput {
  let prompt = "";
  let n = 1;
  let sizeHint: string | undefined;
  const sourcePaths: string[] = [];
  try {
    const obj = JSON.parse(toolInput) as Record<string, unknown>;
    if (typeof obj.prompt === "string") prompt = obj.prompt;
    if (typeof obj.n === "number" && obj.n >= 1 && obj.n <= 4) n = Math.floor(obj.n);
    if (typeof obj.size === "string") sizeHint = obj.size;
    // edit_image: image_path may be a single string or an array of strings.
    const ip = obj.image_path;
    if (typeof ip === "string" && ip.length > 0) {
      sourcePaths.push(ip);
    } else if (Array.isArray(ip)) {
      for (const p of ip) if (typeof p === "string" && p.length > 0) sourcePaths.push(p);
    }
  } catch {
    // ignore — defaults already set
  }
  const { maxWidth, maxHeight } = pickDisplayBounds(n);
  const { width, height } = computeImageDisplaySize(sizeHint, maxWidth, maxHeight);
  return { prompt, n, width, height, sourcePaths };
}

/** Render absolute image paths as small thumbnails (loaded via Tauri). */
function ImageSourceThumbs({ paths }: { readonly paths: readonly string[] }) {
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    for (const p of paths) {
      if (dataUrls[p]) continue;
      invokeTauri<string>("read_file_base64", { path: p })
        .then((b64) => {
          if (cancelled) return;
          // Detect mime from extension; default to png.
          const ext = p.split(".").pop()?.toLowerCase() ?? "png";
          const mime =
            ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "webp"
                ? "image/webp"
                : ext === "gif"
                  ? "image/gif"
                  : "image/png";
          setDataUrls((prev) => ({ ...prev, [p]: `data:${mime};base64,${b64}` }));
        })
        .catch(() => {
          /* swallow — thumbnail is best-effort */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [paths, dataUrls]);

  if (paths.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {paths.map((p) => {
        const url = dataUrls[p];
        return (
          <div
            key={p}
            className="rounded overflow-hidden shrink-0"
            style={{
              width: 36,
              height: 36,
              border: "1px solid var(--color-border)",
              backgroundColor: "var(--color-surface-alt)",
            }}
            title={p}
          >
            {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : null}
          </div>
        );
      })}
    </div>
  );
}

function ImageGenSkeleton({ width, height }: { readonly width: number; readonly height: number }) {
  // Frosted card placeholder: layered stack with a diagonal shimmer sweep
  // (left→right-bottom, 1.8s ease-in-out), breathing violet/cyan glow border
  // (2.4s, 0.25↔0.7 opacity), drifting particles forming the "image", soft
  // blur reveal blobs, and a subtle bottom progress flow. The bar never
  // shows a percentage — uncertainty is the point. Errors don't render this
  // skeleton — see ImageGenBlock.
  const { t } = useTranslation();
  const minSide = Math.min(width, height);
  const radius = Math.max(10, Math.min(20, Math.round(minSide * 0.06)));
  const showLabel = minSide >= 200;
  const stackStyle = { borderRadius: radius } as const;
  return (
    <div className="image-gen-skeleton relative" style={{ width, height }}>
      <div className="image-gen-stack-back" style={stackStyle} />
      <div className="image-gen-stack-mid" style={stackStyle} />
      <div className="image-gen-card overflow-hidden" style={stackStyle}>
        <div className="image-gen-blob image-gen-blob-violet" />
        <div className="image-gen-blob image-gen-blob-cyan" />
        <div className="image-gen-dots" />
        <div className="image-gen-particle p1" />
        <div className="image-gen-particle p2" />
        <div className="image-gen-particle p3" />
        <div className="image-gen-particle p4" />
        <div className="image-gen-shimmer" />
        <div className="image-gen-glow" style={stackStyle} />
        <div className="image-gen-center">
          <div
            className="image-gen-icon-wrap rounded-md flex items-center justify-center"
            style={{
              width: minSide * 0.22,
              height: minSide * 0.22,
              background:
                "radial-gradient(circle, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.03) 100%)",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
          >
            <ImageIcon size={minSide * 0.12} strokeWidth={1.4} color="rgba(244,244,245,0.92)" />
          </div>
          {showLabel && (
            <div className="image-gen-label">{t("chat.tools.imageGen.generating")}</div>
          )}
          <div className="image-gen-progress-track">
            <div className="image-gen-progress-flow" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Try to extract a human-readable error message from the MCP result JSON. */
function extractGenerationError(result: string | undefined): string | null {
  if (!result) return null;
  const seen = new Set<unknown>();
  function walk(value: unknown): string | null {
    if (!value || seen.has(value)) return null;
    if (typeof value === "object") seen.add(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return walk(JSON.parse(trimmed));
        } catch {
          return null;
        }
      }
      return null;
    }
    if (Array.isArray(value)) {
      for (const it of value) {
        const found = walk(it);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
      for (const k of Object.keys(obj)) {
        const found = walk(obj[k]);
        if (found) return found;
      }
    }
    return null;
  }
  try {
    return walk(result);
  } catch {
    return null;
  }
}

export function ImageGenBlock({
  toolName,
  toolInput,
  result,
  status,
}: {
  readonly toolName: string;
  readonly toolInput: string;
  readonly result?: string;
  readonly status: ToolCall["status"];
}) {
  const { t } = useTranslation();
  const input = useMemo(() => parseImageGenInput(toolInput), [toolInput]);
  const isEdit = toolName === "mcp__openai_images__edit_image";

  const hasImages = useMemo(() => {
    if (!result) return false;
    return extractGeneratedImages(result).length > 0;
  }, [result]);

  // Success with real images — let ImageGenContent handle the output grid.
  // For edit_image we still prepend a "from → to" header showing source thumbs.
  if (status === "success" && hasImages && result) {
    if (isEdit && input.sourcePaths.length > 0) {
      return (
        <div className="flex flex-col gap-2">
          <div
            className="flex items-center gap-2 text-[11px] font-mono"
            style={{ color: "var(--color-muted)" }}
          >
            <ImageSourceThumbs paths={input.sourcePaths} />
            <span>→</span>
            <span>{t("chat.tools.imageGen.editedFrom", { count: input.sourcePaths.length })}</span>
          </div>
          <ImageGenContent result={result} />
        </div>
      );
    }
    return <ImageGenContent result={result} />;
  }

  // Error (or success-but-no-images, which the MCP server returns as
  // { error, model } when the OpenAI API call fails).
  const errorMsg = extractGenerationError(result);
  const isError = status === "error" || (status === "success" && !hasImages && !!errorMsg);

  if (isError) {
    return (
      <div className="text-[11px] font-mono" style={{ color: "rgb(239,68,68)" }}>
        {isEdit ? t("chat.tools.imageGen.editFailed") : t("chat.tools.imageGen.generationFailed")}
        {errorMsg ? `: ${errorMsg}` : ""}
      </div>
    );
  }

  // Default: running (or pending fallback). Render N skeletons + caption.
  const promptPreview = input.prompt.length > 80 ? `${input.prompt.slice(0, 77)}…` : input.prompt;

  return (
    <div className="flex flex-col gap-2">
      {isEdit && input.sourcePaths.length > 0 && (
        <div className="flex items-center gap-2">
          <ImageSourceThumbs paths={input.sourcePaths} />
          <span className="text-[11px] font-mono" style={{ color: "var(--color-muted)" }}>
            →
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {Array.from({ length: input.n }, (_, i) => (
          <ImageGenSkeleton key={i} width={input.width} height={input.height} />
        ))}
      </div>
      <div
        className="text-[11px] font-mono flex items-center gap-2 min-w-0"
        style={{ color: "var(--color-muted)" }}
      >
        <span className="shrink-0">
          {isEdit ? t("chat.tools.imageGen.editing") : t("chat.tools.imageGen.generating")}
        </span>
        {promptPreview && (
          <span
            className="truncate min-w-0"
            style={{ color: "var(--color-text-tertiary)" }}
            title={input.prompt}
          >
            {promptPreview}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineDiffContent - inline diff view for Edit / Write tool calls
// ---------------------------------------------------------------------------

interface DiffLine {
  readonly type: "removed" | "added";
  readonly text: string;
}

function splitTextLines(text: string): string[] {
  return text ? text.split("\n") : [];
}

function highlightCodeLines(
  lines: readonly string[],
  language?: string,
): Array<string | null> | null {
  if (!language || !hljs.getLanguage(language)) return null;
  return lines.map((line) => {
    if (!line) return null;
    try {
      return hljs.highlight(line, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  });
}

/** Extract file extension from path for syntax hint */
function getFileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : "";
}

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

function getHljsLanguage(ext: string): string | undefined {
  return EXT_TO_LANG[ext];
}

function getDisplayFileName(filePath: string): string {
  if (!filePath) return "";
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function countTextLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function joinSummaryParts(parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function formatSummaryList(items: readonly string[], limit = 3): string {
  const visible = items.slice(0, limit).join(", ");
  const remaining = items.length - limit;
  return remaining > 0 ? `${visible} +${remaining}` : visible;
}

function HighlightedInlineCode({
  code,
  language,
}: {
  readonly code: string;
  readonly language?: string;
}) {
  const lines = useMemo(() => splitTextLines(code), [code]);
  const highlightedHtmls = useMemo(() => highlightCodeLines(lines, language), [language, lines]);

  return (
    <div className="tool-file-change-pre tool-file-code-preview" data-tool-code-preview="true">
      {lines.map((line, index) => (
        <div key={index} className="tool-file-code-row" data-tool-code-line={index + 1}>
          <span className="tool-file-code-gutter">{index + 1}</span>
          <pre className="tool-file-code-line">
            {highlightedHtmls?.[index] ? (
              <code
                className={`hljs language-${language}`}
                dangerouslySetInnerHTML={{ __html: highlightedHtmls[index]! }}
              />
            ) : (
              <code>{line || " "}</code>
            )}
          </pre>
        </div>
      ))}
    </div>
  );
}

function ReadFilePreviewCard({
  filePath,
  code,
  language,
}: {
  readonly filePath: string;
  readonly code: string;
  readonly language: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const ext = getFileExtension(filePath);
  const fileName = getDisplayFileName(filePath);
  const lineCount = countTextLines(code);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [code]);

  const handleOpen = useCallback(() => {
    openResolvedToolFile(filePath).catch(() => {});
  }, [filePath]);

  return (
    <div
      className="tool-file-change tool-read-file"
      data-tool-file-card="true"
      data-tool-read-card="true"
      data-tool-file-kind="read"
      data-tool-file-path={filePath}
    >
      <div className="tool-file-change-header">
        <div className="tool-file-change-icon-wrap">
          {getFileIcon(ext || null, fileName)}
          <FileText size={10} className="tool-file-change-accent-icon" />
        </div>
        <div className="tool-file-change-title-wrap">
          <div className="tool-file-change-title-row">
            <span className="tool-file-change-label">{t("chat.tools.labels.readFile")}</span>
            {fileName && <strong className="tool-file-change-name">{fileName}</strong>}
            {ext && <span className="tool-file-change-lang">{ext}</span>}
          </div>
          <span className="tool-file-change-summary">
            {t("chat.tools.result.lines", { count: lineCount })}
          </span>
          <span className="tool-file-change-path" title={filePath}>
            {filePath || fileName}
          </span>
        </div>
        <button
          type="button"
          onClick={handleOpen}
          className="tool-file-change-action tool-file-change-open"
          data-tool-action="open"
          title={t("chat.tools.result.openFile")}
        >
          <ExternalLink size={12} />
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="tool-file-change-action tool-file-change-copy"
          data-tool-action="copy"
          title={t("chat.tools.result.copyOutput")}
        >
          {copied ? (
            <>
              <Check size={12} />
              <span>{t("chat.tools.result.copied")}</span>
            </>
          ) : (
            <Copy size={12} />
          )}
        </button>
      </div>
      <div className="tool-file-change-preview-head">
        <span>{t("chat.tools.result.contentPreview")}</span>
      </div>
      <div className="tool-file-change-body" data-tool-file-preview="true">
        <HighlightedInlineCode code={code} language={language} />
      </div>
    </div>
  );
}

function ReadManyFileRow({
  path,
  selected,
  lineCount,
  onSelect,
}: {
  readonly path: string;
  readonly selected: boolean;
  readonly lineCount?: number;
  readonly onSelect: () => void;
}) {
  const fileName = getDisplayFileName(path) || path;
  const ext = getFileExtension(path);

  return (
    <button
      type="button"
      className="tool-file-batch-row"
      data-tool-read-many-row="true"
      data-tool-file-path={path}
      data-selected={selected ? "true" : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      title={path}
    >
      <span className="tool-file-batch-row-icon">{getFileIcon(ext || null, fileName)}</span>
      <span className="tool-file-batch-row-text">
        <span className="tool-file-batch-row-name">{fileName}</span>
        <span className="tool-file-batch-row-path">{path}</span>
      </span>
      {typeof lineCount === "number" && (
        <span className="tool-file-batch-row-lines">{lineCount}</span>
      )}
    </button>
  );
}

interface ReadManyFileSection {
  readonly path: string;
  readonly code: string;
}

function trimBoundaryBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function parseReadManyOutput(
  paths: readonly string[],
  output: string,
): ReadonlyArray<ReadManyFileSection> {
  const pathSet = new Set(paths);
  const sections: ReadManyFileSection[] = [];
  let current: { path: string; lines: string[] } | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const lines = trimBoundaryBlankLines(current.lines);
    sections.push({ path: current.path, code: lines.join("\n") });
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (pathSet.has(trimmed)) {
      pushCurrent();
      current = { path: trimmed, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }

  pushCurrent();
  return sections.filter((section) => section.code.trim().length > 0);
}

function ReadManyFilePreview({ section }: { readonly section: ReadManyFileSection }) {
  const { t } = useTranslation();
  const ext = getFileExtension(section.path);
  const fileName = getDisplayFileName(section.path) || section.path;
  const language = getHljsLanguage(ext);
  const lineCount = countTextLines(section.code);
  const handleOpen = useCallback(() => {
    openResolvedToolFile(section.path).catch(() => {});
  }, [section.path]);

  return (
    <section
      className="tool-file-batch-preview"
      data-tool-read-many-preview="true"
      data-tool-read-many-selected-preview="true"
      data-tool-file-path={section.path}
    >
      <div className="tool-file-batch-preview-head">
        <span className="tool-file-batch-preview-icon">{getFileIcon(ext || null, fileName)}</span>
        <span className="tool-file-batch-preview-title">
          <strong>{fileName}</strong>
          <span title={section.path}>{section.path}</span>
        </span>
        <span className="tool-file-batch-preview-lines">
          {t("chat.tools.result.lines", { count: lineCount })}
        </span>
        <button
          type="button"
          onClick={handleOpen}
          className="tool-file-change-action tool-file-batch-preview-open"
          data-tool-action="open-selected-file"
          title={t("chat.tools.result.openFile")}
        >
          <ExternalLink size={12} />
        </button>
      </div>
      <HighlightedInlineCode code={section.code} language={language} />
    </section>
  );
}

function getPathExtensionSummary(paths: readonly string[]): string {
  const extensions = Array.from(
    new Set(paths.map((path) => getFileExtension(path).toUpperCase()).filter(Boolean)),
  );
  return formatSummaryList(extensions, 4);
}

function ReadManyFilesCard({
  paths,
  result,
}: {
  readonly paths: readonly string[];
  readonly result: string;
}) {
  const { t } = useTranslation();
  const output = result.trim();
  const outputLines = output ? output.split("\n") : [];
  const fileSections = useMemo(() => parseReadManyOutput(paths, output), [output, paths]);
  const [selectedPath, setSelectedPath] = useState(() => fileSections[0]?.path ?? paths[0] ?? "");
  const sectionByPath = useMemo(
    () => new Map(fileSections.map((section) => [section.path, section] as const)),
    [fileSections],
  );
  const selectedSection = sectionByPath.get(selectedPath) ?? fileSections[0] ?? null;
  const totalPreviewLines = fileSections.reduce(
    (sum, section) => sum + countTextLines(section.code),
    0,
  );
  const extensionSummary = getPathExtensionSummary(paths);

  useEffect(() => {
    if (selectedPath && paths.includes(selectedPath)) return;
    setSelectedPath(fileSections[0]?.path ?? paths[0] ?? "");
  }, [fileSections, paths, selectedPath]);

  return (
    <div
      className="tool-file-batch tool-read-many-files"
      data-tool-file-card="true"
      data-tool-read-many-card="true"
      data-tool-file-kind="read-many"
      data-tool-read-many-selected-path={selectedSection?.path ?? selectedPath}
    >
      <div className="tool-file-batch-header">
        <div className="tool-file-change-icon-wrap">
          <Files size={15} />
          <FileText size={10} className="tool-file-change-accent-icon" />
        </div>
        <div className="tool-file-change-title-wrap">
          <div className="tool-file-change-title-row">
            <span className="tool-file-change-label">{t("chat.tools.labels.readFiles")}</span>
            <strong className="tool-file-change-name">
              {t("chat.tools.result.files", { count: paths.length })}
            </strong>
          </div>
          <span className="tool-file-change-summary">
            {joinSummaryParts([
              t("chat.tools.result.fileCount", { count: paths.length }),
              output && t("chat.tools.result.lines", { count: outputLines.length }),
            ])}
          </span>
        </div>
      </div>

      <div
        className="tool-file-artifact-summary tool-file-batch-summary"
        data-tool-file-artifact-summary="true"
        data-tool-read-many-summary="true"
      >
        <span className="tool-file-artifact-summary-label">
          {t("chat.tools.result.summaryLabel")}
        </span>
        <span className="tool-file-artifact-chip" data-tool-file-summary-chip="files">
          <span>{t("chat.tools.result.files", { count: paths.length })}</span>
          <strong>{t("chat.tools.result.fileCount", { count: paths.length })}</strong>
        </span>
        {fileSections.length > 0 && (
          <span className="tool-file-artifact-chip" data-tool-file-summary-chip="preview">
            <span>{t("chat.tools.result.contentLabel")}</span>
            <strong>{t("chat.tools.result.lines", { count: totalPreviewLines })}</strong>
          </span>
        )}
        {extensionSummary && (
          <span className="tool-file-artifact-chip" data-tool-file-summary-chip="language">
            <span>{t("chat.tools.result.language")}</span>
            <strong>{extensionSummary}</strong>
          </span>
        )}
      </div>

      <div className="tool-file-batch-list" data-tool-read-many-list="true">
        {paths.map((path, index) => (
          <ReadManyFileRow
            key={`${path}-${index}`}
            path={path}
            selected={(selectedSection?.path ?? selectedPath) === path}
            lineCount={
              sectionByPath.get(path) ? countTextLines(sectionByPath.get(path)!.code) : undefined
            }
            onSelect={() => setSelectedPath(path)}
          />
        ))}
      </div>

      {output && (
        <div className="tool-file-batch-output">
          <ToolOutputPanel copyText={output} label={t("chat.tools.result.contentLabel")}>
            {selectedSection ? (
              <div className="tool-file-batch-preview-list" data-tool-read-many-preview-list="true">
                <ReadManyFilePreview key={selectedSection.path} section={selectedSection} />
              </div>
            ) : (
              <pre className="tool-output-pre">{output}</pre>
            )}
          </ToolOutputPanel>
        </div>
      )}
    </div>
  );
}

function DeletedFileCard({
  filePath,
  result,
}: {
  readonly filePath: string;
  readonly result?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const ext = getFileExtension(filePath);
  const fileName = getDisplayFileName(filePath);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard
      .writeText(filePath)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [filePath]);

  return (
    <div
      className="tool-file-change tool-file-change-deleted"
      data-tool-file-card="true"
      data-file-change-card="true"
      data-file-change-kind="deleted"
      data-tool-file-kind="deleted"
      data-tool-file-path={filePath}
    >
      <div className="tool-file-change-header">
        <div className="tool-file-change-icon-wrap">
          {getFileIcon(ext || null, fileName)}
          <FileX2 size={10} className="tool-file-change-accent-icon" />
        </div>
        <div className="tool-file-change-title-wrap">
          <div className="tool-file-change-title-row">
            <span className="tool-file-change-label">{t("chat.tools.labels.deleteFile")}</span>
            {fileName && <strong className="tool-file-change-name">{fileName}</strong>}
            {ext && <span className="tool-file-change-lang">{ext}</span>}
          </div>
          <span className="tool-file-change-summary">{t("chat.tools.result.deletedFile")}</span>
          <span className="tool-file-change-path" title={filePath}>
            {filePath || fileName}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopyPath}
          className="tool-file-change-action tool-file-change-copy"
          data-tool-action="copy-path"
          title={t("chat.tools.result.copyPath")}
        >
          {copied ? (
            <>
              <Check size={12} />
              <span>{t("chat.tools.result.copied")}</span>
            </>
          ) : (
            <Copy size={12} />
          )}
        </button>
      </div>
      {result && (
        <div className="tool-file-change-result">
          <span className="tool-file-change-result-label">
            {t("chat.tools.result.outputLabel")}
          </span>
          <span className="tool-file-change-result-text">{result}</span>
        </div>
      )}
    </div>
  );
}

/** Map a backend revert error code to a localized, user-facing message. */
function mapRevertError(code: string | undefined, t: TFunction): string {
  switch (code) {
    case "content_not_found":
      return t("chat.tools.revert.errorNotFound");
    case "ambiguous_match":
      return t("chat.tools.revert.errorAmbiguous");
    case "empty_replacement":
      return t("chat.tools.revert.errorEmpty");
    default:
      return t("chat.tools.revert.errorGeneric");
  }
}

/** Inline undo control for an Edit/Write tool card. Edit undo runs on the first
 *  click (non-destructive: new_string→old_string); Write undo deletes the file
 *  so it requires an explicit confirm click first. On success the parent
 *  re-renders with `reverted` and this button unmounts. */
function RevertButton({
  toolCallId,
  isWrite,
}: {
  readonly toolCallId: string;
  readonly isWrite: boolean;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"idle" | "confirm" | "reverting">("idle");
  const [error, setError] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const runRevert = useCallback(async () => {
    if (confirmTimer.current) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setPhase("reverting");
    setError(null);
    const res = await useChatStore.getState().revertToolCallEdit(toolCallId);
    if (!res.success) {
      setError(mapRevertError(res.error, t));
      setPhase("idle");
    }
    // success → parent re-renders with reverted=true and unmounts this button
  }, [toolCallId, t]);

  const handleClick = useCallback(() => {
    setError(null);
    if (isWrite && phase === "idle") {
      setPhase("confirm");
      confirmTimer.current = window.setTimeout(() => setPhase("idle"), 3500);
      return;
    }
    void runRevert();
  }, [isWrite, phase, runRevert]);

  if (phase === "reverting") {
    return (
      <button
        type="button"
        disabled
        className="tool-file-change-action tool-file-change-revert"
        data-tool-action="revert"
        title={t("chat.tools.revert.reverting")}
      >
        <Loader2 size={12} className="animate-spin" />
      </button>
    );
  }

  return (
    <>
      {error && (
        <span className="tool-file-change-revert-error" title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={handleClick}
        className={`tool-file-change-action tool-file-change-revert${phase === "confirm" ? " tool-file-change-revert-confirm" : ""}`}
        data-tool-action="revert"
        title={isWrite ? t("chat.tools.revert.titleWrite") : t("chat.tools.revert.titleEdit")}
      >
        <Undo2 size={12} />
        <span>
          {phase === "confirm" ? t("chat.tools.revert.confirm") : t("chat.tools.revert.label")}
        </span>
      </button>
    </>
  );
}

function FileChangeShell({
  kind,
  filePath,
  added,
  removed,
  copied,
  onCopy,
  onOpen,
  openAction = "open",
  openTitle,
  result,
  children,
  toolCallId,
  reverted,
  isWrite,
}: {
  readonly kind: "created" | "edited";
  readonly filePath: string;
  readonly added: number;
  readonly removed?: number;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onOpen?: () => void;
  readonly openAction?: "open" | "diff";
  readonly openTitle?: string;
  readonly result?: string;
  readonly children: ReactNode;
  /** When set, an undo control is shown that reverts this exact tool call. */
  readonly toolCallId?: string;
  /** True once this edit has been undone — greys out the card. */
  readonly reverted?: boolean;
  /** Write tools delete the file on undo and need a confirm step. */
  readonly isWrite?: boolean;
}) {
  const { t } = useTranslation();
  const ext = getFileExtension(filePath);
  const fileName = getDisplayFileName(filePath);
  const icon = getFileIcon(ext || null, fileName);
  const AccentIcon = kind === "created" ? FilePlus2 : PencilLine;
  const label =
    kind === "created" ? t("chat.tools.labels.writeFile") : t("chat.tools.labels.editFile");
  const showAdded = kind === "created" || added > 0 || !removed;
  const showRemoved = typeof removed === "number" && removed > 0;

  return (
    <div
      className={`tool-file-change tool-file-change-${kind}${reverted ? " tool-file-change-reverted" : ""}`}
      data-tool-file-card="true"
      data-file-change-card="true"
      data-file-change-kind={kind}
      data-tool-file-kind={kind}
      data-tool-file-path={filePath}
      data-reverted={reverted ? "true" : undefined}
    >
      <div className="tool-file-change-header">
        <div className="tool-file-change-icon-wrap">
          {icon}
          <AccentIcon size={10} className="tool-file-change-accent-icon" />
        </div>
        <div className="tool-file-change-title-wrap">
          <div className="tool-file-change-title-row">
            <span className="tool-file-change-label">{label}</span>
            {fileName && <strong className="tool-file-change-name">{fileName}</strong>}
            {ext && <span className="tool-file-change-lang">{ext}</span>}
            {showAdded ? (
              <span className="tool-file-change-stat tool-file-change-stat-added">+{added}</span>
            ) : null}
            {showRemoved ? (
              <span className="tool-file-change-stat tool-file-change-stat-removed">
                -{removed}
              </span>
            ) : null}
          </div>
          <span className="tool-file-change-path" title={filePath}>
            {filePath || fileName}
          </span>
        </div>
        {reverted ? (
          <span className="tool-file-change-reverted-badge" data-tool-revert-state="done">
            <Undo2 size={11} />
            {t("chat.tools.revert.reverted")}
          </span>
        ) : (
          toolCallId && <RevertButton toolCallId={toolCallId} isWrite={!!isWrite} />
        )}
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="tool-file-change-action tool-file-change-open"
            data-tool-action={openAction}
            title={openTitle ?? t("chat.tools.result.openFile")}
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
          className="tool-file-change-action tool-file-change-copy"
          data-tool-action="copy"
          title={t("chat.tools.result.copyOutput")}
        >
          {copied ? (
            <>
              <Check size={12} />
              <span>{t("chat.tools.result.copied")}</span>
            </>
          ) : (
            <Copy size={12} />
          )}
        </button>
      </div>
      <div className="tool-file-change-body" data-tool-file-preview="true">
        {children}
      </div>
      {result && (
        <div className="tool-file-change-result">
          <span className="tool-file-change-result-label">
            {t("chat.tools.result.outputLabel")}
          </span>
          <span className="tool-file-change-result-text">{result}</span>
        </div>
      )}
    </div>
  );
}

function DiffRow({
  type,
  lineNumber,
  text,
  html,
}: {
  readonly type: DiffLine["type"];
  readonly lineNumber: number;
  readonly text: string;
  readonly html?: string | null;
}) {
  return (
    <div
      className={`tool-file-change-diff-row tool-file-change-diff-row-${type}`}
      data-tool-diff-line={lineNumber}
    >
      <span className="tool-file-change-diff-gutter">
        <span className="tool-file-change-diff-sign">{type === "removed" ? "−" : "+"}</span>
        <span className="tool-file-change-diff-line-number">{lineNumber}</span>
      </span>
      <pre className="tool-file-change-diff-code">
        {html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : text || " "}
      </pre>
    </div>
  );
}

/** Unified diff: removed lines then added lines in one continuous, color-coded
 *  block — no separate before/after panels. */
function DiffRows({
  oldLines,
  newLines,
  highlightedOldHtmls,
  highlightedNewHtmls,
}: {
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly highlightedOldHtmls?: ReadonlyArray<string | null> | null;
  readonly highlightedNewHtmls?: ReadonlyArray<string | null> | null;
}) {
  return (
    <div className="tool-file-change-diff-rows">
      {oldLines.map((text, i) => (
        <DiffRow
          key={`removed-${i}`}
          type="removed"
          lineNumber={i + 1}
          text={text}
          html={highlightedOldHtmls?.[i] ?? null}
        />
      ))}
      {newLines.map((text, i) => (
        <DiffRow
          key={`added-${i}`}
          type="added"
          lineNumber={i + 1}
          text={text}
          html={highlightedNewHtmls?.[i] ?? null}
        />
      ))}
    </div>
  );
}

export function InlineDiffContent({
  toolCallId,
  toolName,
  toolInput,
  result,
  reverted,
}: {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly result?: string;
  readonly reverted?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const diff = useMemo(() => {
    try {
      const input = JSON.parse(toolInput) as Record<string, unknown>;
      if (toolName === "Edit" || toolName === "replace") {
        return {
          filePath: (input.file_path as string) ?? (input.path as string) ?? "",
          oldStr: (input.old_string as string) ?? "",
          newStr: (input.new_string as string) ?? "",
        };
      }
      if (toolName === "Write" || toolName === "write_file") {
        return {
          filePath: (input.file_path as string) ?? (input.path as string) ?? "",
          oldStr: "",
          newStr: (input.content as string) ?? "",
        };
      }
    } catch {
      /* fallback below */
    }
    return null;
  }, [toolName, toolInput]);

  const oldLines = useMemo(() => splitTextLines(diff?.oldStr ?? ""), [diff?.oldStr]);
  const newLines = useMemo(() => splitTextLines(diff?.newStr ?? ""), [diff?.newStr]);
  const language = useMemo(() => {
    if (!diff) return undefined;
    const ext = getFileExtension(diff.filePath);
    return getHljsLanguage(ext);
  }, [diff]);
  const highlightedOldHtmls = useMemo(
    () => highlightCodeLines(oldLines, language),
    [oldLines, language],
  );
  const highlightedNewHtmls = useMemo(
    () => highlightCodeLines(newLines, language),
    [newLines, language],
  );

  const handleCopy = useCallback(() => {
    if (!diff) return;
    const text = diff.newStr || diff.oldStr;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [diff]);

  const handleOpenDiff = useCallback(() => {
    if (!diff?.filePath) return;
    if (!diff.oldStr && !diff.newStr) {
      openToolFile(diff.filePath).catch(() => {});
      return;
    }
    openToolDiffTab({
      filePath: diff.filePath,
      original: diff.oldStr,
      modified: diff.newStr,
    }).catch(() => {});
  }, [diff]);

  // Fallback: no diff data available, show plain result
  if (!diff || (oldLines.length === 0 && newLines.length === 0)) {
    return result ? <ResultContent result={result} /> : null;
  }

  const added = diff ? countTextLines(diff.newStr) : 0;
  const removed = diff ? countTextLines(diff.oldStr) : 0;

  return (
    <FileChangeShell
      kind="edited"
      filePath={diff?.filePath ?? ""}
      added={added}
      removed={removed}
      copied={copied}
      onCopy={handleCopy}
      onOpen={diff?.filePath ? handleOpenDiff : undefined}
      openAction="diff"
      openTitle={t("chat.tools.result.diffCompareTitle")}
      result={result}
      toolCallId={toolCallId}
      reverted={reverted}
    >
      <DiffRows
        oldLines={oldLines}
        newLines={newLines}
        highlightedOldHtmls={highlightedOldHtmls}
        highlightedNewHtmls={highlightedNewHtmls}
      />
    </FileChangeShell>
  );
}

// ---------------------------------------------------------------------------
// InlineWriteContent - expanded view for Write / write_file tool calls.
// Renders the written content formatted by file type:
//   - .md        → rendered markdown
//   - code file  → CodeBlock with syntax highlight (built-in header + copy)
//   - other      → plain <pre> inside a framed container with copy button
// ---------------------------------------------------------------------------

export function InlineWriteContent({
  toolCallId,
  toolInput,
  result,
  reverted,
}: {
  readonly toolCallId?: string;
  readonly toolInput: string;
  readonly result?: string;
  readonly reverted?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => {
    try {
      const input = JSON.parse(toolInput) as Record<string, unknown>;
      const filePath = (input.file_path as string) ?? (input.path as string) ?? "";
      const content = (input.content as string) ?? "";
      return { filePath, content };
    } catch {
      return null;
    }
  }, [toolInput]);

  const handleCopy = useCallback(() => {
    if (!parsed) return;
    navigator.clipboard
      .writeText(parsed.content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [parsed]);

  const handleOpenFile = useCallback(() => {
    if (!parsed?.filePath) return;
    openToolFile(parsed.filePath).catch(() => {});
  }, [parsed]);

  if (!parsed || !parsed.content) {
    return result ? <ResultContent result={result} /> : null;
  }

  const ext = getFileExtension(parsed.filePath);
  const isMd = ext === "md" || ext === "markdown";
  const lang = isMd ? undefined : getHljsLanguage(ext);
  const hasHighlight = lang ? !!hljs.getLanguage(lang) : false;

  return (
    <FileChangeShell
      kind="created"
      filePath={parsed.filePath}
      added={countTextLines(parsed.content)}
      copied={copied}
      onCopy={handleCopy}
      onOpen={parsed.filePath ? handleOpenFile : undefined}
      openTitle={t("chat.tools.result.openFile")}
      result={result}
      toolCallId={toolCallId}
      reverted={reverted}
      isWrite
    >
      {isMd ? (
        <div className="tool-file-change-markdown">
          <MarkdownRenderer content={parsed.content} variant="compact" />
        </div>
      ) : hasHighlight && lang ? (
        <HighlightedInlineCode code={parsed.content} language={lang} />
      ) : (
        <pre className="tool-file-change-pre">
          <code>{parsed.content}</code>
        </pre>
      )}
    </FileChangeShell>
  );
}

export function InlineDeleteContent({
  toolInput,
  result,
}: {
  readonly toolInput: string;
  readonly result?: string;
}) {
  const parsed = useMemo(() => {
    const input = parseToolInputObject(toolInput);
    const filePath = parseToolFilePath(input);
    return filePath ? { filePath } : null;
  }, [toolInput]);

  if (!parsed) {
    return result ? <ResultContent result={result} /> : null;
  }

  return <DeletedFileCard filePath={parsed.filePath} result={result} />;
}

// ---------------------------------------------------------------------------
// InlineBashContent - expanded view for Bash tool calls.
// Renders the command with shell syntax highlight + output block with ANSI
// color preserved. Auto-scrolls to bottom while the command is streaming.
// ---------------------------------------------------------------------------

export function InlineBashContent({
  toolInput,
  result,
  status,
}: {
  readonly toolInput: string;
  readonly result?: string;
  readonly status: ToolCall["status"];
}) {
  const { t } = useTranslation();
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const command = useMemo(() => {
    try {
      const input = JSON.parse(toolInput) as Record<string, unknown>;
      return (input.command as string) ?? "";
    } catch {
      return "";
    }
  }, [toolInput]);

  const commandHtml = useMemo(() => {
    if (!command || !hljs.getLanguage("bash")) return null;
    try {
      return hljs.highlight(command, { language: "bash", ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [command]);

  const outputHtmlLines = useMemo(() => {
    if (!result) return [];
    const ansi = new AnsiUp();
    return result.split("\n").map((line) => ansi.ansi_to_html(line || " "));
  }, [result]);

  const isRunning = status === "running";
  const hasOutput = !!result && result.length > 0;

  const handleCopyCommand = useCallback(() => {
    if (!command) return;
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopiedCommand(true);
        setTimeout(() => setCopiedCommand(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [command]);

  const handleCopyOutput = useCallback(() => {
    if (!result) return;
    navigator.clipboard
      .writeText(result)
      .then(() => {
        setCopiedOutput(true);
        setTimeout(() => setCopiedOutput(false), 2000);
      })
      .catch(() => {
        /* clipboard access denied */
      });
  }, [result]);

  useEffect(() => {
    if (!isRunning || !hasOutput) return;
    const el = outputRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isRunning, hasOutput, outputHtmlLines]);

  if (!command) {
    return result ? <ResultContent result={result} /> : null;
  }

  return (
    <div className="tool-bash-content" data-tool-command-status={isRunning ? "running" : "done"}>
      <div className="tool-command-panel" data-tool-command-panel="true">
        <div className="tool-command-panel-header">
          <span className="tool-command-panel-label">{t("chat.tools.result.commandLabel")}</span>
          <button
            type="button"
            onClick={handleCopyCommand}
            className={`tool-command-panel-copy${copiedCommand ? " is-copied" : ""}`}
            data-tool-action="copy-command"
            title={t("chat.tools.result.copyCommand")}
          >
            {copiedCommand ? (
              <>
                <Check size={12} />
                <span>{t("chat.tools.result.copied")}</span>
              </>
            ) : (
              <Copy size={12} />
            )}
          </button>
        </div>
        <pre className="tool-command-panel-pre">
          {commandHtml ? (
            <code
              className="hljs language-bash"
              dangerouslySetInnerHTML={{ __html: commandHtml }}
            />
          ) : (
            <code>{command}</code>
          )}
        </pre>
      </div>

      <div className="tool-bash-output">
        <div className="tool-bash-output-header">
          <span className="tool-bash-output-title">
            <span className="tool-bash-output-label">{t("chat.tools.result.outputLabel")}</span>
            {isRunning && (
              <span className="tool-bash-output-status">
                {t("chat.tools.result.runningOutput")}
              </span>
            )}
          </span>
          {hasOutput && (
            <button
              type="button"
              onClick={handleCopyOutput}
              className={`tool-bash-output-copy${copiedOutput ? " is-copied" : ""}`}
              data-tool-action="copy-output"
              title={t("chat.tools.result.copyOutput")}
            >
              {copiedOutput ? (
                <>
                  <Check size={12} />
                  <span>{t("chat.tools.result.copied")}</span>
                </>
              ) : (
                <Copy size={12} />
              )}
            </button>
          )}
        </div>

        <div ref={outputRef} className="tool-bash-output-body">
          {hasOutput ? (
            <div className="tool-bash-output-lines" data-tool-bash-output-lines="true">
              {outputHtmlLines.map((lineHtml, index) => (
                <div
                  key={index}
                  className="tool-bash-output-line"
                  data-tool-bash-output-line={index + 1}
                >
                  <span className="tool-bash-output-gutter">{index + 1}</span>
                  <pre
                    className="tool-bash-output-pre"
                    dangerouslySetInnerHTML={{ __html: lineHtml }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <span className="tool-bash-output-empty">
              {isRunning ? t("chat.tools.result.runningOutput") : t("chat.tools.result.noOutput")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineWebSearchContent / InlineWebFetchContent
// ---------------------------------------------------------------------------

interface WebSearchLink {
  readonly title: string;
  readonly url: string;
}

interface ParsedWebSearch {
  readonly links: readonly WebSearchLink[];
  readonly body: string;
}

/** Parse Claude Agent SDK WebSearch result string into link list + markdown body.
 *  Tolerant to missing prefix / missing Links line / malformed JSON. */
function parseWebSearchResult(result: string): ParsedWebSearch | null {
  let rest = result.trimStart();

  const queryLine = rest.match(/^Web search results for query:[^\n]*\n+/);
  if (queryLine) rest = rest.slice(queryLine[0].length);

  let links: WebSearchLink[] = [];
  const linksLine = rest.match(/^Links:\s*(\[.*\])\s*\n+/);
  if (linksLine) {
    try {
      const parsed = JSON.parse(linksLine[1]) as unknown;
      if (Array.isArray(parsed)) {
        links = (parsed as unknown[])
          .filter((it): it is Record<string, unknown> => typeof it === "object" && it !== null)
          .filter((it) => typeof it.title === "string" && typeof it.url === "string")
          .map((it) => ({
            title: it.title as string,
            url: it.url as string,
          }));
      }
      rest = rest.slice(linksLine[0].length);
    } catch {
      /* JSON parse failed — leave the Links line in the body */
    }
  }

  const body = rest.trim();
  if (!queryLine && links.length === 0) return null;
  return { links, body };
}

/** Extract host from URL for the small caption line; falls back to empty. */
function getUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function WebSearchLinkRow({ link }: { readonly link: WebSearchLink }) {
  const host = useMemo(() => getUrlHost(link.url), [link.url]);

  const handleOpen = useCallback(() => {
    openUrlInSystemBrowser(link.url).catch(() => {
      /* ignore */
    });
  }, [link.url]);

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="tool-web-source-row"
      data-tool-web-source-row="true"
      data-tool-web-source-url={link.url}
      title={link.url}
    >
      <span className="tool-web-source-icon">
        <Globe size={12} />
      </span>
      <span className="tool-web-source-text">
        <span className="tool-web-source-title">{link.title}</span>
        {host && <span className="tool-web-source-host">{host}</span>}
      </span>
      <ExternalLink size={12} className="tool-web-source-open-icon" aria-hidden="true" />
    </button>
  );
}

export function InlineWebSearchContent({ result }: { readonly result: string }) {
  const { t } = useTranslation();

  const parsed = useMemo(() => parseWebSearchResult(result), [result]);

  if (!parsed) {
    return <ResultContent result={result} />;
  }

  const { links, body } = parsed;

  return (
    <div className="tool-web-search-wrap">
      {links.length > 0 && (
        <div className="tool-web-sources-panel" data-tool-web-search-panel="true">
          <div className="tool-web-panel-header">
            <span className="tool-web-panel-label">
              {t("chat.tools.result.sources", { count: links.length })}
            </span>
          </div>
          <div className="tool-web-source-list">
            {links.map((link, i) => (
              <WebSearchLinkRow key={`${link.url}-${i}`} link={link} />
            ))}
          </div>
        </div>
      )}

      {body && (
        <ToolOutputPanel copyText={body} label={t("chat.tools.result.summaryLabel")}>
          <div className="tool-output-markdown" data-tool-web-summary="true">
            <MarkdownRenderer content={body} variant="compact" />
          </div>
        </ToolOutputPanel>
      )}
    </div>
  );
}

export function InlineWebFetchContent({ result }: { readonly result: string }) {
  const { t } = useTranslation();
  const content = result.trim();

  if (!content) return null;

  return (
    <ToolOutputPanel copyText={content} label={t("chat.tools.result.contentLabel")}>
      <div className="tool-output-markdown">
        <MarkdownRenderer content={content} variant="compact" />
      </div>
    </ToolOutputPanel>
  );
}

// ---------------------------------------------------------------------------
// InlineFileSearchContent - formatted file list for Grep / Glob tool results
// ---------------------------------------------------------------------------

interface ParsedFileSearch {
  readonly paths: readonly string[];
}

interface ContentSearchMatch {
  readonly filePath: string;
  readonly line: number;
  readonly column?: number;
  readonly text: string;
}

interface ContentSearchFileGroup {
  readonly filePath: string;
  readonly matches: readonly ContentSearchMatch[];
}

interface ParsedContentSearch {
  readonly groups: readonly ContentSearchFileGroup[];
  readonly totalMatches: number;
}

interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory" | "unknown";
}

interface ParsedDirectoryList {
  readonly basePath: string;
  readonly entries: readonly DirectoryEntry[];
}

function parseDirectoryToolInput(toolInput: string): string {
  try {
    const input = JSON.parse(toolInput) as Record<string, unknown>;
    const path = (input.path as string) ?? (input.directory as string) ?? ".";
    return path || ".";
  } catch {
    return ".";
  }
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function normalizeDirectoryLine(line: string): {
  readonly name: string;
  readonly kind: DirectoryEntry["kind"];
} | null {
  let text = stripAnsi(line).trim();
  if (!text || /^total\s+\d+/i.test(text)) return null;
  if (/^Directory listing for\b/i.test(text)) return null;

  text = text
    .replace(/^[│|]\s+/u, "")
    .replace(/^[├└]──\s*/u, "")
    .replace(/^[+`\\-]+--\s*/u, "")
    .trim();

  const longMatch = text.match(
    /^([bcdlps-][rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/,
  );
  if (longMatch) {
    const mode = longMatch[1]!;
    const rawName = longMatch[2]!.replace(/\s+->\s+.*$/, "");
    const name = rawName.replace(/\/$/, "");
    if (!name || name === "." || name === "..") return null;
    return { name, kind: mode.startsWith("d") ? "directory" : "file" };
  }

  const isDirectory = text.endsWith("/");
  const name = text.replace(/\/$/, "");
  if (!name || name === "." || name === "..") return null;
  return { name, kind: isDirectory ? "directory" : "unknown" };
}

function joinToolPath(basePath: string, name: string): string {
  if (name.startsWith("/") || /^[A-Za-z]:[\\/]/.test(name)) return name;
  if (name.startsWith("./")) return name.slice(2);
  if (name.includes("/") || name.includes("\\")) return name;
  if (!basePath || basePath === ".") return name;
  const sep = basePath.includes("\\") ? "\\" : "/";
  const trimmed = basePath.endsWith(sep) ? basePath.slice(0, -sep.length) : basePath;
  return `${trimmed}${sep}${name}`;
}

function parseDirectoryListResult(result: string, toolInput: string): ParsedDirectoryList | null {
  const basePath = parseDirectoryToolInput(toolInput);
  const entries = result
    .split("\n")
    .flatMap((line) => {
      const entry = normalizeDirectoryLine(line);
      return entry ? [entry] : [];
    })
    .map((entry) => ({
      ...entry,
      path: joinToolPath(basePath, entry.name),
    }));

  if (entries.length === 0) return null;
  return { basePath, entries };
}

function DirectoryListRow({ entry }: { readonly entry: DirectoryEntry }) {
  const ext = useMemo(() => getFileExtension(entry.name), [entry.name]);
  const icon =
    entry.kind === "directory" ? <FolderOpen size={14} /> : getFileIcon(ext || null, entry.name);

  const handleOpen = useCallback(() => {
    openResolvedToolFile(entry.path).catch(() => {});
  }, [entry.path]);

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="tool-directory-row"
      data-tool-directory-row="true"
      data-tool-directory-kind={entry.kind}
      data-tool-directory-path={entry.path}
      title={entry.path}
    >
      <span className="tool-directory-icon">{icon}</span>
      <span className="tool-directory-text">
        <span className="tool-directory-name">{entry.name}</span>
        {entry.path !== entry.name && <span className="tool-directory-path">{entry.path}</span>}
      </span>
    </button>
  );
}

export function InlineDirectoryListContent({
  toolInput,
  result,
}: {
  readonly toolInput: string;
  readonly result: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => parseDirectoryListResult(result, toolInput), [result, toolInput]);

  if (!parsed) {
    return <ResultContent result={result} />;
  }

  const { basePath, entries } = parsed;
  const folderCount = entries.filter((entry) => entry.kind === "directory").length;
  const fileCount = entries.length - folderCount;
  const isLong = entries.length > MAX_RESULT_LINES;
  const visibleEntries = isLong && !expanded ? entries.slice(0, MAX_RESULT_LINES) : entries;

  return (
    <div className="tool-directory-wrap">
      <div
        className="tool-directory-panel"
        data-tool-directory-panel="true"
        data-tool-directory-path={basePath}
      >
        <div className="tool-directory-header">
          <span className="tool-directory-label">
            {t("chat.tools.result.directoryEntries", { count: entries.length })}
          </span>
          <span className="tool-directory-summary">
            {folderCount > 0 && (
              <span>{t("chat.tools.result.folderCount", { count: folderCount })}</span>
            )}
            {fileCount > 0 && <span>{t("chat.tools.result.fileCount", { count: fileCount })}</span>}
          </span>
        </div>
        <div className="tool-directory-base" title={basePath}>
          {basePath}
        </div>
        <div className="tool-directory-list">
          {visibleEntries.map((entry, index) => (
            <DirectoryListRow key={`${entry.path}-${index}`} entry={entry} />
          ))}
        </div>
      </div>
      {isLong && (
        <ExpandCollapseButton
          expanded={expanded}
          hiddenCount={entries.length - MAX_RESULT_LINES}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </div>
  );
}

const FILE_SEARCH_HEADER_RE = /^(Found\b|No matches\b|No files\b|Searched\b)/i;
const FILE_SEARCH_FOOTER_PAGINATION_RE = /^\[Showing results with pagination/i;
const FILE_SEARCH_FOOTER_TRUNCATED_RE = /^\(Results are truncated/i;
const FILE_SEARCH_FOOTER_COUNT_TOTAL_RE =
  /^Found\s+\d+\s+total\s+(occurrences?|references?|matches?)/i;
const GREP_CONTENT_MODE_RE = /^[^:\n]+:\d+:/;
const GREP_COUNT_MODE_RE = /^[^:\n]+:\s*\d+\s*$/;
const GREP_CONTENT_LINE_RE = /^(.+?):(\d+)(?::(\d+))?:(.*)$/;

function isSearchNoiseLine(line: string): boolean {
  const text = line.trim();
  return (
    !text ||
    FILE_SEARCH_HEADER_RE.test(text) ||
    FILE_SEARCH_FOOTER_PAGINATION_RE.test(text) ||
    FILE_SEARCH_FOOTER_TRUNCATED_RE.test(text) ||
    FILE_SEARCH_FOOTER_COUNT_TOTAL_RE.test(text)
  );
}

function parseContentSearchLine(line: string): ContentSearchMatch | null {
  const text = stripAnsi(line).trimEnd();
  if (isSearchNoiseLine(text)) return null;
  const match = text.match(GREP_CONTENT_LINE_RE);
  if (!match) return null;

  const lineNumber = Number.parseInt(match[2]!, 10);
  const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) return null;
  if (column !== undefined && (!Number.isFinite(column) || column <= 0)) return null;

  return {
    filePath: match[1]!.trim(),
    line: lineNumber,
    column,
    text: match[4] ?? "",
  };
}

function parseContentSearchResult(result: string): ParsedContentSearch | null {
  const rawLines = result.split("\n");
  const matches = rawLines.flatMap((line) => {
    const parsed = parseContentSearchLine(line);
    return parsed ? [parsed] : [];
  });
  if (matches.length === 0) return null;

  const meaningfulLines = rawLines
    .map((line) => stripAnsi(line).trim())
    .filter((line) => line && !isSearchNoiseLine(line));
  if (matches.length < Math.max(1, meaningfulLines.length * 0.5)) return null;

  const grouped = new Map<string, ContentSearchMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.filePath);
    if (list) {
      list.push(match);
    } else {
      grouped.set(match.filePath, [match]);
    }
  }

  return {
    totalMatches: matches.length,
    groups: Array.from(grouped, ([filePath, fileMatches]) => ({
      filePath,
      matches: fileMatches,
    })),
  };
}

/** Parse Grep / Glob tool result string into a clean list of file paths.
 *  Returns null when the format looks like Grep content/count mode — caller
 *  falls back to plain <pre>. Otherwise treats remaining candidate lines as
 *  paths (incl. extensionless names like Makefile / Dockerfile / LICENSE).
 *
 *  SDK output formats (see @anthropic-ai/claude-agent-sdk cli.js Grep/Glob):
 *   - Grep files_with_matches: `Found N files [limit: K]\n<paths>`
 *   - Grep content:            `<file:line:text>...\n[Showing results ...]`
 *   - Grep count:              `<file: N>...\n\nFound M total ... across P files.`
 *   - Glob:                    `<paths>\n(Results are truncated. ...)` */
function parseFileSearchResult(result: string): ParsedFileSearch | null {
  const lines = result.split("\n").map((l) => l.trimEnd());

  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start++;
  while (end > start && !lines[end - 1]?.trim()) end--;

  if (start < end && FILE_SEARCH_HEADER_RE.test(lines[start]!.trim())) {
    start++;
  }

  for (let i = 0; i < 2 && end > start; i++) {
    const last = lines[end - 1]!.trim();
    if (
      !last ||
      FILE_SEARCH_FOOTER_PAGINATION_RE.test(last) ||
      FILE_SEARCH_FOOTER_TRUNCATED_RE.test(last) ||
      FILE_SEARCH_FOOTER_COUNT_TOTAL_RE.test(last)
    ) {
      end--;
    } else {
      break;
    }
  }

  const candidates = lines
    .slice(start, end)
    .map((l) => l.trim())
    .filter(Boolean);
  if (candidates.length === 0) return null;

  let noisy = 0;
  for (const c of candidates) {
    if (GREP_CONTENT_MODE_RE.test(c) || GREP_COUNT_MODE_RE.test(c)) noisy++;
  }
  if (noisy >= candidates.length * 0.5) return null;

  const paths = candidates.filter(
    (c) => !GREP_CONTENT_MODE_RE.test(c) && !GREP_COUNT_MODE_RE.test(c),
  );
  if (paths.length === 0) return null;
  return { paths };
}

/** Split a path into (directory, filename). */
function splitPath(path: string): { readonly dir: string; readonly name: string } {
  const sep = path.includes("\\") ? "\\" : "/";
  const idx = path.lastIndexOf(sep);
  if (idx < 0) return { dir: "", name: path };
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

function FileSearchRow({ path }: { readonly path: string }) {
  const { name, dir } = useMemo(() => splitPath(path), [path]);
  const ext = useMemo(() => getFileExtension(name), [name]);

  const handleOpen = useCallback(() => {
    openResolvedToolFile(path).catch(() => {});
  }, [path]);

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="tool-file-search-row"
      data-tool-file-search-row="true"
      data-tool-file-path={path}
      title={path}
    >
      <span className="tool-file-search-icon">{getFileIcon(ext || null, name)}</span>
      <span className="tool-file-search-path">
        <span className="tool-file-search-name">{name}</span>
        {dir && <span className="tool-file-search-dir">{dir}</span>}
      </span>
    </button>
  );
}

function ContentSearchMatchRow({ match }: { readonly match: ContentSearchMatch }) {
  return (
    <div
      className="tool-content-search-match"
      data-tool-content-search-match="true"
      data-tool-content-search-line={match.line}
      data-tool-content-search-column={match.column ?? ""}
    >
      <span className="tool-content-search-line">
        {match.column ? `${match.line}:${match.column}` : match.line}
      </span>
      <pre className="tool-content-search-code">{match.text || " "}</pre>
    </div>
  );
}

function ContentSearchFileGroup({ group }: { readonly group: ContentSearchFileGroup }) {
  const { t } = useTranslation();
  const { name, dir } = useMemo(() => splitPath(group.filePath), [group.filePath]);
  const ext = useMemo(() => getFileExtension(name), [name]);

  const handleOpen = useCallback(() => {
    openResolvedToolFile(group.filePath).catch(() => {});
  }, [group.filePath]);

  return (
    <section
      className="tool-content-search-file"
      data-tool-content-search-file="true"
      data-tool-file-path={group.filePath}
    >
      <button
        type="button"
        onClick={handleOpen}
        className="tool-content-search-file-header"
        title={group.filePath}
      >
        <span className="tool-file-search-icon">{getFileIcon(ext || null, name)}</span>
        <span className="tool-content-search-file-text">
          <span className="tool-content-search-file-name">{name || group.filePath}</span>
          {dir && <span className="tool-content-search-file-dir">{dir}</span>}
        </span>
        <span className="tool-content-search-file-count">
          {t("chat.tools.result.matches", { count: group.matches.length })}
        </span>
      </button>
      <div className="tool-content-search-matches">
        {group.matches.map((match, index) => (
          <ContentSearchMatchRow
            key={`${group.filePath}-${match.line}-${match.column ?? "line"}-${index}`}
            match={match}
          />
        ))}
      </div>
    </section>
  );
}

export function InlineFileSearchContent({ result }: { readonly result: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const contentSearch = useMemo(() => parseContentSearchResult(result), [result]);
  const parsed = useMemo(() => parseFileSearchResult(result), [result]);

  if (contentSearch) {
    const isLong = contentSearch.groups.length > MAX_RESULT_LINES;
    const visibleGroups =
      isLong && !expanded ? contentSearch.groups.slice(0, MAX_RESULT_LINES) : contentSearch.groups;

    return (
      <div className="tool-content-search-wrap">
        <div
          className="tool-content-search-panel"
          data-tool-content-search-panel="true"
          data-tool-content-search-count={contentSearch.totalMatches}
        >
          <div className="tool-content-search-header">
            <span className="tool-content-search-label">
              {t("chat.tools.result.matches", { count: contentSearch.totalMatches })}
            </span>
            <span className="tool-content-search-summary">
              {t("chat.tools.result.files", { count: contentSearch.groups.length })}
            </span>
          </div>
          <div className="tool-content-search-list">
            {visibleGroups.map((group) => (
              <ContentSearchFileGroup key={group.filePath} group={group} />
            ))}
          </div>
        </div>
        {isLong && (
          <ExpandCollapseButton
            expanded={expanded}
            hiddenCount={contentSearch.groups.length - MAX_RESULT_LINES}
            onToggle={() => setExpanded(!expanded)}
          />
        )}
      </div>
    );
  }

  if (!parsed) {
    return <ResultContent result={result} />;
  }

  const { paths } = parsed;
  const isLong = paths.length > MAX_RESULT_LINES;
  const visiblePaths = isLong && !expanded ? paths.slice(0, MAX_RESULT_LINES) : paths;

  return (
    <div className="tool-file-search-wrap">
      <div className="tool-file-search-panel" data-tool-file-search-panel="true">
        <div className="tool-file-search-header">
          <span className="tool-file-search-label">
            {t("chat.tools.result.files", { count: paths.length })}
          </span>
        </div>
        <div className="tool-file-search-list">
          {visiblePaths.map((p, i) => (
            <FileSearchRow key={`${p}-${i}`} path={p} />
          ))}
        </div>
      </div>
      {isLong && (
        <ExpandCollapseButton
          expanded={expanded}
          hiddenCount={paths.length - MAX_RESULT_LINES}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlinePlanContent - markdown-rendered plan body for ExitPlanMode tool
// ---------------------------------------------------------------------------

export function InlinePlanContent({ result }: { readonly result: string }) {
  const { t } = useTranslation();

  return (
    <div className="tool-plan-panel" data-tool-plan-panel="true">
      <div className="tool-plan-panel-header">
        <span className="tool-plan-panel-label">{t("chat.tools.result.planLabel")}</span>
      </div>
      <div className="tool-plan-panel-body">
        <MarkdownRenderer content={result} variant="compact" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TodoContent - ordered list display for TodoWrite tool
// ---------------------------------------------------------------------------

interface TodoItem {
  readonly content?: string;
  readonly description?: string;
  readonly subject?: string;
  readonly taskId?: string;
  readonly id?: string;
  readonly status?: "pending" | "in_progress" | "completed" | string;
  readonly activeForm?: string;
}

type NormalizedTodoStatus = "pending" | "in_progress" | "completed";

/** Extract display text from a todo item — handles both Claude (content) and Gemini (description) formats */
function todoText(item: TodoItem): string {
  return item.content || item.subject || item.description || item.taskId || item.id || "";
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function coerceTodoStatus(status: unknown): NormalizedTodoStatus {
  if (status === "completed" || status === "complete" || status === "done") return "completed";
  if (status === "in_progress" || status === "running" || status === "active") return "in_progress";
  return "pending";
}

function taskPreviewFromTool(
  toolName: string,
  input: Record<string, unknown>,
  result: string | undefined,
): readonly TodoItem[] {
  const resultObj = parseJsonObject(result);
  const resultTask =
    resultObj.task && typeof resultObj.task === "object" && !Array.isArray(resultObj.task)
      ? (resultObj.task as Record<string, unknown>)
      : null;

  if (toolName === "TaskList" && Array.isArray(resultObj.tasks)) {
    return (resultObj.tasks as Array<Record<string, unknown>>).map((task) => ({
      content:
        (task.subject as string) ?? (task.description as string) ?? (task.id as string) ?? "",
      status: coerceTodoStatus(task.status),
      activeForm: (task.activeForm as string) ?? (task.subject as string) ?? "",
    }));
  }

  if (toolName === "TaskGet" && resultTask) {
    return [
      {
        content:
          (resultTask.subject as string) ??
          (resultTask.description as string) ??
          (resultTask.id as string) ??
          "",
        status: coerceTodoStatus(resultTask.status),
        activeForm: (resultTask.activeForm as string) ?? (resultTask.subject as string) ?? "",
      },
    ];
  }

  if (toolName === "TaskCreate") {
    return [
      {
        content:
          (input.subject as string) ??
          (resultTask?.subject as string) ??
          (input.description as string) ??
          (resultTask?.id as string) ??
          "",
        status: coerceTodoStatus(input.status ?? resultTask?.status),
        activeForm: (input.activeForm as string) ?? (input.subject as string) ?? "",
      },
    ];
  }

  if (toolName === "TaskUpdate") {
    return [
      {
        content:
          (input.subject as string) ??
          (resultTask?.subject as string) ??
          (input.description as string) ??
          (input.taskId as string) ??
          "",
        status: coerceTodoStatus(input.status ?? resultTask?.status),
        activeForm: (input.activeForm as string) ?? (input.subject as string) ?? "",
      },
    ];
  }

  return [];
}

export function TodoContent({
  toolName,
  toolInput,
  result,
}: {
  readonly toolName?: string;
  readonly toolInput: string;
  readonly result?: string;
}) {
  const { t } = useTranslation();
  let todos: readonly TodoItem[] = [];
  try {
    const parsed = JSON.parse(toolInput) as { todos?: unknown };
    if (Array.isArray(parsed.todos)) {
      todos = parsed.todos as TodoItem[];
    } else if (toolName?.startsWith("Task")) {
      todos = taskPreviewFromTool(toolName, parsed as Record<string, unknown>, result);
    }
  } catch {
    return null;
  }

  if (todos.length === 0) return null;

  const counts = todos.reduce(
    (acc, todo) => {
      const status = coerceTodoStatus(todo.status);
      acc[status] += 1;
      return acc;
    },
    { completed: 0, in_progress: 0, pending: 0 },
  );

  const statusLabel = (status: TodoItem["status"]) => {
    switch (coerceTodoStatus(status)) {
      case "completed":
        return t("chat.tools.result.todoCompleted");
      case "in_progress":
        return t("chat.tools.result.todoRunning");
      default:
        return t("chat.tools.result.todoPending");
    }
  };

  return (
    <div className="tool-todo-panel" data-tool-todo-panel="true">
      <div className="tool-todo-panel-header">
        <span className="tool-todo-panel-label">
          {t("chat.tools.result.todoItems", { count: todos.length })}
        </span>
        <span className="tool-todo-panel-summary">
          {counts.in_progress > 0 && (
            <span className="tool-todo-count tool-todo-count-running">
              {t("chat.tools.result.todoRunningCount", { count: counts.in_progress })}
            </span>
          )}
          {counts.pending > 0 && (
            <span className="tool-todo-count tool-todo-count-pending">
              {t("chat.tools.result.todoPendingCount", { count: counts.pending })}
            </span>
          )}
          {counts.completed > 0 && (
            <span className="tool-todo-count tool-todo-count-completed">
              {t("chat.tools.result.todoCompletedCount", { count: counts.completed })}
            </span>
          )}
        </span>
      </div>
      <ol className="tool-todo-list">
        {todos.map((todo, i) => {
          const status = coerceTodoStatus(todo.status);
          return (
            <li
              key={i}
              className={`tool-todo-row tool-todo-row-${status}`}
              data-tool-todo-status={status}
            >
              <span className="tool-todo-status-icon" aria-hidden="true">
                {status === "completed" ? (
                  <Check size={12} />
                ) : status === "in_progress" ? (
                  <span className="thinking-spinner-active tool-todo-spinner" />
                ) : null}
              </span>
              <span className="tool-todo-text">{todoText(todo)}</span>
              <span className="tool-todo-status-label">{statusLabel(status)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AskUserQuestionContent — structured replay of an AskUserQuestion tool call.
// Renders each question with its options and highlights the chosen answer,
// instead of dumping the raw "Your questions have been answered: …" string.
// Falls back to plain text when the input can't be parsed.
// ---------------------------------------------------------------------------

interface AskUserReplayOption {
  readonly label: string;
  readonly description: string;
}

interface AskUserReplayQuestion {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: ReadonlyArray<AskUserReplayOption>;
}

type AskUserReplayStatus = "answered" | "timeout" | "unanswered";

function parseAskUserQuestions(toolInput: string): ReadonlyArray<AskUserReplayQuestion> | null {
  try {
    const parsed = JSON.parse(toolInput) as { questions?: unknown };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
    return parsed.questions.map((raw) => {
      const q = (raw ?? {}) as Record<string, unknown>;
      return {
        question: typeof q.question === "string" ? q.question : "",
        header: typeof q.header === "string" ? q.header : "",
        multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
        options: Array.isArray(q.options)
          ? (q.options as ReadonlyArray<Record<string, unknown>>).map((o) => ({
              label: typeof o.label === "string" ? o.label : "",
              description: typeof o.description === "string" ? o.description : "",
            }))
          : [],
      };
    });
  } catch {
    return null;
  }
}

/** Parse the SDK result string. Each answer is encoded as
 *  `"<full question text>"="<answer>"`; we locate it by the exact question text
 *  (known from the input) so embedded quotes / equals / commas inside the
 *  question can't confuse the match. Option labels never contain a `"`, so the
 *  answer terminates at the next double-quote. */
function parseAskUserAnswers(
  result: string | undefined,
  questions: ReadonlyArray<AskUserReplayQuestion>,
): { status: AskUserReplayStatus; answers: ReadonlyMap<string, string> } {
  const text = (result ?? "").trim();
  if (!text) return { status: "unanswered", answers: new Map() };
  if (/timed out/i.test(text)) return { status: "timeout", answers: new Map() };
  const answers = new Map<string, string>();
  for (const q of questions) {
    if (!q.question) continue;
    const needle = `"${q.question}"="`;
    const idx = text.indexOf(needle);
    if (idx < 0) continue;
    const start = idx + needle.length;
    const end = text.indexOf('"', start);
    if (end < 0) continue;
    answers.set(q.question, text.slice(start, end));
  }
  return { status: answers.size > 0 ? "answered" : "unanswered", answers };
}

const ASK_USER_PURPLE_BG = "color-mix(in srgb, var(--color-accent-purple) 9%, transparent)";
const ASK_USER_PURPLE_BORDER = "color-mix(in srgb, var(--color-accent-purple) 38%, transparent)";
const ASK_USER_CHIP_BG = "color-mix(in srgb, var(--color-accent-purple) 14%, transparent)";

/** Selection marker — filled purple square (multi-select) or circle (single). */
function AskUserMark({
  selected,
  multiSelect,
}: {
  readonly selected: boolean;
  readonly multiSelect: boolean;
}) {
  return (
    <span
      style={{
        marginTop: 1,
        flexShrink: 0,
        width: 15,
        height: 15,
        borderRadius: multiSelect ? 4 : 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: selected ? "var(--color-accent-purple)" : "transparent",
        border: `1.5px solid ${selected ? "var(--color-accent-purple)" : "var(--color-border-strong)"}`,
      }}
    >
      {selected && <Check size={10} strokeWidth={3} className="text-white" />}
    </span>
  );
}

export function AskUserQuestionContent({
  toolInput,
  result,
}: {
  readonly toolInput: string;
  readonly result?: string;
}) {
  const { t } = useTranslation();
  const questions = useMemo(() => parseAskUserQuestions(toolInput), [toolInput]);
  const parsed = useMemo(() => parseAskUserAnswers(result, questions ?? []), [result, questions]);

  // Unparseable input → fall back to the default text/JSON renderer.
  if (!questions) {
    return result ? <ResultContent result={result} toolName="AskUserQuestion" /> : null;
  }

  const { status, answers } = parsed;

  return (
    <div
      className="tool-ask-user-content"
      data-ask-user-replay="true"
      style={{ display: "flex", flexDirection: "column", gap: 16, padding: "6px 2px 4px" }}
    >
      {status !== "answered" && (
        <div
          data-ask-user-status={status}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            alignSelf: "flex-start",
            padding: "3px 10px",
            borderRadius: 6,
            fontSize: 11,
            color: "var(--color-muted)",
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          <Clock size={11} />
          {status === "timeout"
            ? t("chat.tools.result.askUserTimedOut")
            : t("chat.tools.result.askUserNoAnswer")}
        </div>
      )}

      {questions.map((q, qi) => {
        const answer = answers.get(q.question) ?? "";
        const parts = q.multiSelect
          ? answer
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : answer
            ? [answer.trim()]
            : [];
        const optionLabels = new Set(q.options.map((o) => o.label));
        const customParts = parts.filter((p) => !optionLabels.has(p));

        return (
          <div key={qi} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Question header */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              {q.header && (
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "2px 8px",
                    borderRadius: 4,
                    color: "var(--color-accent-purple)",
                    backgroundColor: ASK_USER_CHIP_BG,
                  }}
                >
                  {q.header}
                </span>
              )}
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: 1.45,
                  color: "var(--color-foreground)",
                }}
              >
                {q.question}
              </span>
            </div>

            {/* Options */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 2 }}>
              {q.options.map((opt, oi) => {
                const selected = parts.includes(opt.label);
                return (
                  <div
                    key={oi}
                    data-selected={selected || undefined}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 8,
                      backgroundColor: selected ? ASK_USER_PURPLE_BG : "transparent",
                      border: `1px solid ${selected ? ASK_USER_PURPLE_BORDER : "var(--color-border-light)"}`,
                    }}
                  >
                    <AskUserMark selected={selected} multiSelect={q.multiSelect} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: selected ? 600 : 400,
                          color: selected ? "var(--color-foreground)" : "var(--color-muted)",
                        }}
                      >
                        {opt.label}
                      </span>
                      {selected && opt.description && (
                        <span
                          style={{
                            fontSize: 11,
                            lineHeight: 1.5,
                            color: "var(--color-muted-foreground)",
                          }}
                        >
                          {opt.description}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Custom (Other) free-text answers — shown when the answer isn't one of the listed options. */}
              {customParts.map((cp, ci) => (
                <div
                  key={`custom-${ci}`}
                  data-ask-user-custom="true"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "8px 12px",
                    borderRadius: 8,
                    backgroundColor: ASK_USER_PURPLE_BG,
                    border: `1px solid ${ASK_USER_PURPLE_BORDER}`,
                  }}
                >
                  <AskUserMark selected multiSelect={q.multiSelect} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span
                      style={{ fontSize: 10, fontWeight: 600, color: "var(--color-accent-purple)" }}
                    >
                      {t("chat.tools.result.askUserCustomAnswer")}
                    </span>
                    <span
                      style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-foreground)" }}
                    >
                      {cp}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GroupStatusDot - green (all ok), red (all failed), yellow (partial)
// ---------------------------------------------------------------------------

export function GroupStatusDot({
  errorCount,
  successCount,
  warningCount = 0,
  size = 8,
}: {
  readonly errorCount: number;
  readonly successCount: number;
  readonly warningCount?: number;
  readonly size?: number;
}) {
  const color =
    errorCount > 0
      ? successCount === 0 && warningCount === 0
        ? "#EF4444"
        : "#F59E0B"
      : warningCount > 0
        ? "#F59E0B"
        : "#10B981";

  return (
    <span
      className={errorCount === 0 && warningCount === 0 ? "status-dot-active" : undefined}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: color,
      }}
    />
  );
}
