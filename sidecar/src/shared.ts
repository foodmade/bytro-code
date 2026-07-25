// ---------------------------------------------------------------------------
// Shared utilities across all sidecar handlers
// ---------------------------------------------------------------------------

import type { QueryCommand, TodoItem, TodoDiffEntry } from "./protocol.js";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  openSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export type EmitFn = (evt: object) => void;

export const MAX_TOOL_OUTPUT_LENGTH = 4000;

export type ToolDisplayStatus = "success" | "warning" | "error";
export type ToolDisplaySeverity = "info" | "warning" | "error";

export interface ToolDisplayMeta {
  readonly status: ToolDisplayStatus;
  readonly severity: ToolDisplaySeverity;
  readonly reason?: string;
}

export function makeToolDisplay(status: ToolDisplayStatus, reason?: string): ToolDisplayMeta {
  const severity: ToolDisplaySeverity = status === "success" ? "info" : status;
  return reason ? { status, severity, reason } : { status, severity };
}

export function defaultToolDisplay(success: boolean): ToolDisplayMeta {
  return success ? makeToolDisplay("success") : makeToolDisplay("error");
}

export function prependPathDirsToEnv(
  env: Record<string, string | undefined>,
  dirs: ReadonlyArray<string> | undefined,
): void {
  const validDirs = (dirs ?? []).filter((dir) => dir && existsSync(dir));
  if (validDirs.length === 0) return;

  const sep = process.platform === "win32" ? ";" : ":";
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  const preferredPathKey =
    pathKeys.find((key) => key === (process.platform === "win32" ? "Path" : "PATH")) ??
    pathKeys[0] ??
    "PATH";
  const current = pathKeys
    .map((key) => env[key])
    .filter((value): value is string => Boolean(value))
    .join(sep);
  for (const key of pathKeys) {
    if (key !== preferredPathKey) {
      delete env[key];
    }
  }
  const pathKey = preferredPathKey;
  env[pathKey] = `${validDirs.join(sep)}${current ? sep + current : ""}`;
}

export function buildProcessEnvWithManagedPath(
  _dirs: ReadonlyArray<string> | undefined,
): Record<string, string | undefined> {
  return { ...process.env };
}

export function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// File logger — writes diagnostic logs to a persistent file on disk.
// Uses the OS temp directory so logs are always writable on any machine.
// ---------------------------------------------------------------------------
const DEBUG_LOG_PATH = join(tmpdir(), "bytro-community-sidecar-debug.log");

/** Return the absolute path of the diagnostic log file. */
export function getDebugLogPath(): string {
  return DEBUG_LOG_PATH;
}

// ---------------------------------------------------------------------------
// Log level system — controlled by BYTRO_LOG_LEVEL env var (default: info)
// ---------------------------------------------------------------------------
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};
const activeLogLevel: number =
  LOG_LEVEL_VALUES[(process.env.BYTRO_LOG_LEVEL as LogLevel) ?? "info"] ?? LOG_LEVEL_VALUES.info;

/** Check if a given log level is enabled. Use to guard expensive serialization. */
export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_VALUES[level] <= activeLogLevel;
}

// ---------------------------------------------------------------------------
// Async write buffer — replaces per-line appendFileSync for much less I/O
// ---------------------------------------------------------------------------
let _writeBuffer: string[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushWriteBuffer(): void {
  if (_writeBuffer.length === 0) return;
  const batch = _writeBuffer.join("");
  _writeBuffer = [];
  _flushTimer = null;
  try {
    appendPrivateLogFile(DEBUG_LOG_PATH, batch);
  } catch {
    // Silently ignore write errors
  }
}

export function appendPrivateLogFile(filePath: string, contents: string): void {
  const noFollow =
    process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(
    filePath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_APPEND |
      noFollow,
    0o600,
  );
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeSync(fd, contents, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

function appendSafeDebugLine(line: string): void {
  _writeBuffer.push(line + "\n");
  if (_writeBuffer.length >= 100) {
    flushWriteBuffer();
  } else if (_flushTimer === null) {
    _flushTimer = setTimeout(flushWriteBuffer, 500);
    _flushTimer.unref();
  }
}

export function appendToDebugLog(line: string): void {
  appendSafeDebugLine(summarizeDiagnosticText(line, "external"));
}

export interface LeveledLogger {
  (msg: string): void;
  error: (msg: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
  trace: (msg: string) => void;
}

export function summarizeDiagnosticText(
  message: string,
  eventType = "message",
  _level: LogLevel = "info",
): string {
  const safeType =
    eventType.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 64) || "message";
  const length = Buffer.byteLength(message, "utf8");
  const digest = createHash("sha256").update(message, "utf8").digest("hex");
  return `event=${safeType} len=${length} sha256=${digest}`;
}

/**
 * Convert an untrusted handler failure into a small, stable UI category.
 * Raw exception text is reserved for hashed diagnostics and never crosses
 * the sidecar protocol boundary.
 */
export function publicSidecarErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("enoent") ||
    normalized.includes("not found") ||
    normalized.includes("unavailable")
  ) {
    return "Required provider CLI is unavailable";
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("credential") ||
    normalized.includes("401") ||
    normalized.includes("403")
  ) {
    return "Provider authentication failed";
  }
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  ) {
    return "Provider request timed out";
  }
  if (
    normalized.includes("invalid request") ||
    normalized.includes("bad request") ||
    normalized.includes("400")
  ) {
    return "Provider rejected the request";
  }
  return "Provider request failed";
}

export function createLogger(tag: string): LeveledLogger {
  const emit = (level: LogLevel, msg: string) => {
    if (LOG_LEVEL_VALUES[level] > activeLogLevel) return;
    // Raw prompts, arguments, answers, environment values, and RPC bodies are
    // never written, including at trace level. Trace only changes which
    // call-sites are enabled; every detail is reduced to metadata here.
    const summary = summarizeDiagnosticText(msg, `${tag}.${level}`, level);
    const line = `[sidecar:${tag}] ${summary}`;
    process.stderr.write(line + "\n");
    appendSafeDebugLine(`[${new Date().toISOString()}] ${line}`);
  };

  const fn = ((msg: string) => emit("info", msg)) as LeveledLogger;
  fn.error = (msg: string) => emit("error", msg);
  fn.warn = (msg: string) => emit("warn", msg);
  fn.info = (msg: string) => emit("info", msg);
  fn.debug = (msg: string) => emit("debug", msg);
  fn.trace = (msg: string) => emit("trace", msg);
  return fn;
}

/** Generate a unique tool call ID with the given prefix. */
export function makeToolCallId(prefix: string): string {
  return `${prefix}-tc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Synthesize EnterPlanMode tool card for non-Claude handlers.
 * Claude CLI stream events expose EnterPlanMode natively; Codex (and other handlers
 * using custom plan mode) need this synthetic event so the frontend shows
 * a visible "entered plan mode" tool card.
 */
export function emitEnterPlanMode(requestId: string, emit: EmitFn, prefix: string): void {
  const toolCallId = makeToolCallId(prefix);
  emit({
    evt: "tool_start",
    id: requestId,
    toolCallId,
    toolName: "EnterPlanMode",
    toolInput: "{}",
  });
  emit({
    evt: "tool_result",
    id: requestId,
    toolCallId,
    toolName: "EnterPlanMode",
    toolInput: "{}",
    success: true,
    result: "Entered plan mode",
    display: defaultToolDisplay(true),
  });
}

/** Truncate text to a maximum length, appending an indicator if truncated. */
export function truncate(text: string, limit: number = MAX_TOOL_OUTPUT_LENGTH): string {
  return text.length > limit ? text.slice(0, limit) + "\n...(truncated)" : text;
}

/**
 * Build the effective prompt from command context.
 * Embeds system instructions, conversation history, and image notices.
 * When a model name is provided, conversation history is truncated to fit
 * within the model's context window.
 */
export function buildEffectivePrompt(
  cmd: QueryCommand,
  opts?: { includeImages?: boolean; model?: string },
): string {
  const { systemPrompt, messages, images } = cmd;
  const model = opts?.model || cmd.model;
  // Truncate current prompt if it alone exceeds context budget
  const prompt = truncatePrompt(cmd.prompt, model);
  const parts: string[] = [];

  if (opts?.includeImages && images && images.length > 0) {
    parts.push(
      `[${images.length} image(s) were provided by the user but cannot be forwarded through the CLI. Please ask the user to describe the image content if needed.]`,
    );
  }
  if (systemPrompt) {
    parts.push(`<system_instructions>\n${systemPrompt}\n</system_instructions>`);
  }
  if (messages && messages.length > 0) {
    const promptTokens = estimateTokens(prompt) + estimateTokens(systemPrompt || "");
    const trimmed = truncateMessages(messages, model, promptTokens);
    const ctx = trimmed.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    parts.push(`<conversation_history>\n${ctx}\n</conversation_history>`);
    parts.push(`User: ${prompt}`);
  } else {
    parts.push(prompt);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Model context window sizes (tokens)
// Claude models are not listed here — the Claude CLI adapter returns
// contextWindow directly via modelUsage.
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic / Claude
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-mythos-preview": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  // OpenAI / Codex
  o3: 200_000,
  "o4-mini": 200_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-5.6": 1_050_000,
  "gpt-5": 400_000,
  "codex-mini-latest": 200_000,
  // Gemini
  "gemini-3-pro": 1_048_576,
  "gemini-3-flash": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.0-flash": 1_048_576,
  // DeepSeek / ChatCompletion
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 64_000,
  // Qwen (通义千问)
  "qwen3.5-plus": 131_072,
  "qwen3-max-2026-01-23": 131_072,
  "qwen3-coder-next": 131_072,
  "qwen3-coder-plus": 131_072,
  "qwen3-coder": 131_072,
  "kimi-k2.5": 131_072,
  "MiniMax-M2.5": 131_072,
  // MiniMax
  "MiniMax-M2.7": 1_000_000,
  "MiniMax-M2.7-highspeed": 1_000_000,
  "MiniMax-M2.5-highspeed": 1_000_000,
  // BigModel (智谱) — GLM 全系默认 1M 上下文窗口。
  // 用 "glm" 前缀兜底覆盖所有型号(glm-5.x / glm-4.x，含 air/airx/flashx/long 等变体)。
  // getContextWindowForModel 按 key 长度降序匹配，如个别型号窗口不同，可在此行之前
  // 用更长的精确 key 显式覆盖(例如 "glm-4.5-air": 128_000)。
  glm: 1_000_000,
};

/** Look up the context window size for a model. Returns 0 if unknown. */
export function getContextWindowForModel(model: string): number {
  const normalizedModel = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;

  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  if (MODEL_CONTEXT_WINDOWS[normalizedModel]) return MODEL_CONTEXT_WINDOWS[normalizedModel];
  // Try prefix matching for versioned model names (e.g. "gpt-4o-2024-08-06").
  // Sort by key length descending so longer (more specific) prefixes match first
  // (e.g. "gpt-4o-mini" before "gpt-4o").
  const sorted = Object.entries(MODEL_CONTEXT_WINDOWS).sort(([a], [b]) => b.length - a.length);
  for (const [key, value] of sorted) {
    if (model.startsWith(key)) return value;
    if (normalizedModel.startsWith(key)) return value;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Token estimation & message truncation
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Fraction of context window reserved for system prompt + model output. */
const RESERVED_RATIO = 0.3;
/** Minimum number of messages to keep even if over budget. */
const MIN_KEEP_MESSAGES = 4;

/**
 * Truncate a single user prompt so it doesn't exceed a hard character limit
 * derived from the model's context window.  This is a safety net for cases
 * where large file contents are embedded in the prompt.
 */
export function truncatePrompt(prompt: string, model: string): string {
  const contextWindow = getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW;
  // Reserve 30% for system prompt + output, use at most 70% of context for the prompt.
  // Rough conversion: 1 token ≈ 3 chars (conservative for mixed content).
  const maxChars = Math.floor(contextWindow * (1 - RESERVED_RATIO) * 3);
  if (prompt.length <= maxChars) return prompt;
  return prompt.slice(0, maxChars) + "\n...(prompt truncated to fit context window)";
}

/**
 * Rough token estimate — no external dependency needed.
 * Uses ~3.5 chars/token for Latin text, ~1.5 chars/token for CJK.
 * We lean conservative (fewer chars per token → higher estimate) to avoid
 * under-counting and hitting the limit.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters (rough heuristic: Unicode range 0x3000–0x9FFF, 0xF900–0xFAFF)
  let cjkChars = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      cjkChars++;
    }
  }
  const latinChars = text.length - cjkChars;
  return Math.ceil(latinChars / 3.5) + Math.ceil(cjkChars / 1.5);
}

/**
 * Truncate a ChatMessage array so the total estimated tokens fit within the
 * model's context window.  Keeps the most recent messages; drops older ones.
 *
 * @param messages  Conversation history (oldest first).
 * @param model     Model name — used to look up context window size.
 * @param extraTokens  Additional tokens already consumed (e.g. system prompt,
 *                     current user message) that should be subtracted from the
 *                     budget.
 * @returns A (possibly shorter) array, preserving order.
 */
export function truncateMessages<T extends { content: string }>(
  messages: ReadonlyArray<T>,
  model: string,
  extraTokens: number = 0,
): T[] {
  const contextWindow = getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW;
  const budget = Math.floor(contextWindow * (1 - RESERVED_RATIO)) - extraTokens;

  if (budget <= 0) {
    // No room at all — keep minimum recent messages
    return messages.slice(-MIN_KEEP_MESSAGES) as T[];
  }

  // Walk backwards from newest, accumulating token estimates
  let used = 0;
  let cutIndex = 0; // will keep messages[cutIndex .. end]
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i].content);
    if (used + tokens > budget && messages.length - i >= MIN_KEEP_MESSAGES) {
      cutIndex = i + 1;
      break;
    }
    used += tokens;
  }

  return messages.slice(cutIndex) as T[];
}

// ---------------------------------------------------------------------------
// Claude Code executable resolution
//
// Community Edition uses only a user-configured local executable or PATH.
// ---------------------------------------------------------------------------

let cachedClaudePath: string | undefined;

/**
 * Resolve Claude Code from `CLAUDE_CLI_PATH`, then the user's system PATH.
 * The optional argument is retained for wire compatibility but is ignored.
 */
export function findClaudeCodePath(_injectedPath?: string): string | undefined {
  const configuredPath = process.env.CLAUDE_CLI_PATH?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    cachedClaudePath = configuredPath;
    return configuredPath;
  }

  if (cachedClaudePath !== undefined && existsSync(cachedClaudePath)) {
    return cachedClaudePath;
  }
  cachedClaudePath = undefined;

  const isWin = process.platform === "win32";
  try {
    const cmd = isWin ? "where.exe" : "which";
    const results = execFileSync(cmd, ["claude"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/);

    for (const result of results) {
      const trimmed = result.trim();
      if (!trimmed || !existsSync(trimmed)) continue;
      cachedClaudePath = trimmed;
      return cachedClaudePath;
    }
  } catch {
    // Claude is not available on PATH.
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Todo diff computation — shared between claude-handler and teams-handler
// ---------------------------------------------------------------------------

export function computeTodoDiff(
  previous: ReadonlyArray<TodoItem>,
  current: ReadonlyArray<TodoItem>,
): ReadonlyArray<TodoDiffEntry> {
  const prevMap = new Map(previous.map((t) => [t.content, t]));
  const currMap = new Map(current.map((t) => [t.content, t]));
  const result: TodoDiffEntry[] = [];

  for (const todo of current) {
    const prev = prevMap.get(todo.content);
    if (!prev) {
      result.push({ content: todo.content, changeType: "added", newStatus: todo.status });
    } else if (prev.status !== todo.status) {
      result.push({
        content: todo.content,
        changeType: "status_changed",
        oldStatus: prev.status,
        newStatus: todo.status,
      });
    } else {
      result.push({ content: todo.content, changeType: "unchanged" });
    }
  }

  for (const todo of previous) {
    if (!currMap.has(todo.content)) {
      result.push({ content: todo.content, changeType: "removed", oldStatus: todo.status });
    }
  }

  return result;
}
