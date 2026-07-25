import { Channel, invoke } from "@tauri-apps/api/core";
import type { FileChange } from "@/stores/file-changes-store";
import type { GitDiffFile } from "@/stores/git-store";

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

export async function readFileContent(path: string): Promise<string> {
  try {
    const content = await invoke<string>("read_file_content", { path });
    return content;
  } catch {
    return `[无法读取文件内容: ${path}]`;
  }
}

// ---------------------------------------------------------------------------
// Diff fetching
// ---------------------------------------------------------------------------

/** Convert an absolute file path to a path relative to the workspace root. */
export function toRelativePath(absolutePath: string, workspacePath: string): string {
  const normalizedAbs = absolutePath.replace(/\\/g, "/");
  const normalizedWs = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalizedAbs.startsWith(normalizedWs + "/")) {
    return normalizedAbs.slice(normalizedWs.length + 1);
  }
  return absolutePath;
}

/** Attempt to fetch the git diff for a single file. Returns null on failure. */
export async function fetchFileDiff(
  workspacePath: string,
  absoluteFilePath: string,
): Promise<GitDiffFile | null> {
  if (!workspacePath) return null;
  const relativePath = toRelativePath(absoluteFilePath, workspacePath);
  try {
    return await invoke<GitDiffFile>("get_file_diff", {
      path: workspacePath,
      filePath: relativePath,
      staged: false,
    });
  } catch {
    try {
      return await invoke<GitDiffFile>("get_file_diff", {
        path: workspacePath,
        filePath: relativePath,
        staged: true,
      });
    } catch {
      return null;
    }
  }
}

/** Format a GitDiffFile into a human-readable unified diff string. */
export function formatDiffText(diff: GitDiffFile): string {
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    lines.push(hunk.header.trim());
    for (const line of hunk.lines) {
      const prefix =
        line.line_type === "add" ? "+" :
        line.line_type === "delete" ? "-" : " ";
      lines.push(prefix + line.content);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** Maximum characters per individual file before truncation. */
const MAX_FILE_CHARS = 12_000;

/** Maximum characters for the diff section of a single file. */
const MAX_DIFF_CHARS = 8_000;

/** Maximum total characters across all file blocks before excluding more files. */
const MAX_TOTAL_CHARS = 120_000;

interface FileEntry {
  readonly path: string;
  readonly content: string;
  readonly action: string;
  readonly diff: GitDiffFile | null;
}

function truncateText(
  text: string,
  maxChars: number,
  label: string,
): { snippet: string; note: string } {
  if (text.length <= maxChars) return { snippet: text, note: "" };
  return {
    snippet: text.slice(0, maxChars),
    note: `\n// ... (${label}已截断，仅展示前 ${maxChars} 字符)`,
  };
}

function buildReviewPrompt(files: ReadonlyArray<FileEntry>): string {
  let totalChars = 0;
  const includedBlocks: string[] = [];
  const excludedPaths: string[] = [];

  for (const { path, content, action, diff } of files) {
    // --- Deleted file ---
    if (action === "delete") {
      includedBlocks.push(`### 已删除文件: \`${path}\`\n(文件已被删除，无内容)`);
      continue;
    }

    // --- Created file (no diff baseline) ---
    if (action === "create") {
      const { snippet, note } = truncateText(content, MAX_FILE_CHARS, "文件");
      const blockSize = snippet.length + note.length + path.length + 50;
      if (totalChars + blockSize > MAX_TOTAL_CHARS) {
        excludedPaths.push(path);
        continue;
      }
      totalChars += blockSize;
      includedBlocks.push(
        `### 新增文件: \`${path}\`\n\`\`\`\n${snippet}${note}\n\`\`\``,
      );
      continue;
    }

    // --- Edited file with diff available ---
    if (diff && diff.hunks.length > 0) {
      const diffText = formatDiffText(diff);
      const { snippet: diffSnippet, note: diffNote } = truncateText(diffText, MAX_DIFF_CHARS, "diff");
      const { snippet: contentSnippet, note: contentNote } = truncateText(content, MAX_FILE_CHARS, "文件");

      const blockSize = diffSnippet.length + diffNote.length + contentSnippet.length + contentNote.length + path.length + 200;
      if (totalChars + blockSize > MAX_TOTAL_CHARS) {
        excludedPaths.push(path);
        continue;
      }
      totalChars += blockSize;
      includedBlocks.push(
        `### 已修改文件: \`${path}\` (+${diff.additions} -${diff.deletions})\n\n` +
        `**变更内容 (diff) — 请重点审查此部分:**\n\`\`\`diff\n${diffSnippet}${diffNote}\n\`\`\`\n\n` +
        `**完整文件内容（仅作上下文参考，无需逐行审查）:**\n\`\`\`\n${contentSnippet}${contentNote}\n\`\`\``,
      );
      continue;
    }

    // --- Edited file without diff (fallback) ---
    const { snippet, note } = truncateText(content, MAX_FILE_CHARS, "文件");
    const blockSize = snippet.length + note.length + path.length + 50;
    if (totalChars + blockSize > MAX_TOTAL_CHARS) {
      excludedPaths.push(path);
      continue;
    }
    totalChars += blockSize;
    includedBlocks.push(
      `### 已修改文件（无 diff 可用）: \`${path}\`\n\`\`\`\n${snippet}${note}\n\`\`\``,
    );
  }

  const exclusionNote =
    excludedPaths.length > 0
      ? `\n> **注意：以下文件因内容过大已被排除，未纳入本次审查：**\n${excludedPaths.map((p) => `> - \`${p}\``).join("\n")}\n`
      : "";

  const fileBlocks = includedBlocks.join("\n\n") + exclusionNote;

  return `你是一位专业的代码审查专家。以下是本次编码会话中被修改的文件。

**重要审查原则：**
- 对于标记为"已修改文件"的内容，请**只审查 diff 中显示的新增（+）和修改的代码**。完整文件内容仅作为理解上下文的参考，不需要逐行审查未变更的部分。
- 对于标记为"新增文件"的内容，请审查整个文件。
- 对于标记为"无 diff 可用"的文件，请审查整个文件内容。

审查重点：
1. **性能问题** - 低效算法、不必要的重渲染、过度内存使用
2. **设计缺陷** - 反模式、违反 SOLID 原则、抽象不合理
3. **安全漏洞** - XSS、注入攻击、密钥暴露、不安全操作
4. **代码质量** - 可读性、可维护性、命名规范

响应格式要求：
- 如果发现显著问题，请列出具体问题清单（包含文件路径、严重程度、问题描述），并在最后提供一份简洁的【优化方案】，描述需要做哪些具体修改。
- 如果代码整体良好，请简要说明无重大问题，并指出值得表扬的亮点。

请使用中文回复。

---

${fileBlocks}`;
}

// ---------------------------------------------------------------------------
// Provider config passed from the store (resolved by resolveStreamConfig)
// ---------------------------------------------------------------------------

interface ReviewProviderConfig {
  readonly sdk: string;            // "claude" | "codex" | "gemini" | "chatcmpl"
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly proxyUrl: string | undefined;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface CodeReviewRequest {
  readonly changes: ReadonlyArray<FileChange>;
  readonly providerConfig: ReviewProviderConfig;
  readonly workspacePath: string;
}

/** Shape of each event sent from Rust through the Channel. */
interface ReviewStreamChunk {
  readonly type: "delta" | "done" | "error";
  readonly text?: string;
  readonly message?: string;
}

function secretState(value: string | undefined): "(set)" | "(empty)" {
  return value ? "(set)" : "(empty)";
}

function sanitizedUrlForLog(value: string | undefined): string {
  if (!value) return "(empty)";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid)";
  }
}

/**
 * Reads all changed file contents, builds a code review prompt, then streams
 * the AI response back via a Tauri v2 Channel.
 *
 * `onDelta`  — called for each text chunk as it arrives
 * `onDone`   — called once when the stream finishes cleanly
 * `onError`  — called if the stream ends with an error
 */
export async function performCodeReviewStreaming(
  request: CodeReviewRequest,
  onDelta: (chunk: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  const { changes, providerConfig, workspacePath } = request;

  if (changes.length === 0) {
    throw new Error("没有需要审查的文件");
  }

  // Read contents (and diffs for edited files) in parallel
  const fileEntries = await Promise.all(
    changes.map(async (c): Promise<FileEntry> => {
      if (c.action === "delete") {
        return { path: c.filePath, content: "", action: c.action, diff: null };
      }
      if (c.action === "edit") {
        const [content, diff] = await Promise.all([
          readFileContent(c.filePath),
          fetchFileDiff(workspacePath, c.filePath),
        ]);
        return { path: c.filePath, content, action: c.action, diff };
      }
      // action === "create": full content only, no diff baseline
      const content = await readFileContent(c.filePath);
      return { path: c.filePath, content, action: c.action, diff: null };
    }),
  );

  const prompt = buildReviewPrompt(fileEntries);

  // Debug: report only credential presence and a sanitized endpoint.
  console.error("[code-review] invoking ai_code_review_stream", {
    sdk: providerConfig.sdk,
    baseUrl: sanitizedUrlForLog(providerConfig.baseUrl),
    model: providerConfig.model || "(empty)",
    apiKey: secretState(providerConfig.apiKey),
    proxyUrl: secretState(providerConfig.proxyUrl),
    promptLength: prompt.length,
    fileCount: changes.length,
  });

  // Create a Tauri v2 Channel — Rust sends ReviewStreamEvent through this
  const channel = new Channel<ReviewStreamChunk>();
  channel.onmessage = (msg) => {
    if (msg.type === "delta" && msg.text) {
      onDelta(msg.text);
    } else if (msg.type === "done") {
      onDone();
    } else if (msg.type === "error") {
      onError(msg.message ?? "Unknown streaming error");
    }
  };

  await invoke("ai_code_review_stream", {
    onChunk: channel,
    sdk: providerConfig.sdk,
    baseUrl: providerConfig.baseUrl || null,
    apiKey: providerConfig.apiKey || null,
    model: providerConfig.model || null,
    proxyUrl: providerConfig.proxyUrl || null,
    prompt,
  });
}
