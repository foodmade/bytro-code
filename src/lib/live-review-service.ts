import { Channel, invoke } from "@tauri-apps/api/core";
import type { FileChange } from "@/stores/file-changes-store";
import {
  useLiveReviewStore,
  type LiveReviewFileSnapshot,
  type LiveReviewItem,
  type LiveReviewMode,
} from "@/stores/live-review-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useChatStore } from "@/stores/chat-store";
import {
  fetchFileDiff,
  formatDiffText,
  readFileContent,
  toRelativePath,
} from "@/lib/code-review-service";
import {
  parseSeverityTrailing,
  type ReviewScope,
} from "@/lib/live-review-events";
import {
  getEffectiveSdk,
  buildActiveProfileProxyUrl,
  resolveActiveCredentials,
  PLATFORM_REGISTRY,
  type PlatformConfig,
  type PlatformId,
} from "@/lib/platform-config";

// ---------------------------------------------------------------------------
// Live Review Service — buffer-and-flush PR-style reviewer
// ---------------------------------------------------------------------------
// Design:
//   * `bufferFileChange()`           — called for every file_changed event;
//                                      accumulates into a per-conversation
//                                      pending set without triggering review
//   * `triggerMilestoneReview()`     — called when a TodoWrite item just
//                                      transitioned to `completed`; flushes
//                                      buffer into one batched review
//   * `triggerTurnReview()`          — called when the SDK Stop hook fires;
//                                      flushes buffer into one batched review
//   * `cancelAllLiveReviews()`       — called when the user closes the panel
//                                      or workspace switches; clears buffer
//                                      and aborts in-flight streams
//
// Key behaviour:
//   * An empty buffer → triggerTurnReview / triggerMilestoneReview is a no-op
//     (avoids duplicate reviews when MILESTONE has just consumed the buffer
//     and TURN immediately follows with nothing left).
//   * Concurrency cap = 3.  Reviews beyond the cap are queued.
//   * Aborting only stops the front-end from delivering further deltas — the
//     Rust task continues to completion silently (no cancel API for now).
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 3;
// Generous per-section caps — modern reviewer models (Claude Sonnet 4.6,
// Opus 4.7, gpt-5.5, DeepSeek V3, etc.) all carry ≥ 64k context, so we'd
// rather risk a soft truncation tail than withhold information that makes
// the reviewer abstain ("can't judge, file truncated").  Per-file cap is
// the dominant lever: 60k chars covers ~99 % of source files in this repo.
const MAX_DIFF_CHARS = 24_000;
const MAX_FILE_CHARS = 60_000;
const MAX_USER_CONTEXT_CHARS = 2_000;
const MAX_TASK_TITLE_CHARS = 1_500;

/** Per-conversation pending file buffer.  `Map<filePath, snapshot>` so that
 *  the LATEST snapshot for a given file wins (e.g. multiple Edit calls in the
 *  same turn — only the final +/- counts matter). */
const pendingByConv = new Map<string, Map<string, LiveReviewFileSnapshot>>();
/** Per-reviewId in-flight abort controllers. */
const activeAborts = new Map<string, AbortController>();
/** Concurrency-limited execution queue. */
const inflight = { value: 0 };
const queue: Array<() => void> = [];

function makeReviewId(): string {
  return `lr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function clipText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n// ... (${label} truncated to first ${maxChars} chars)`;
}

function getPendingMap(conversationId: string): Map<string, LiveReviewFileSnapshot> {
  let map = pendingByConv.get(conversationId);
  if (!map) {
    map = new Map<string, LiveReviewFileSnapshot>();
    pendingByConv.set(conversationId, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a file change to the per-conversation buffer.  Latest snapshot wins.
 * Called from `file-change-handlers` for every `chat-file-changed` event when
 * the live reviewer is enabled for that conversation.
 */
export function bufferFileChange(
  conversationId: string,
  change: FileChange,
): void {
  if (!conversationId) return;
  const state = useLiveReviewStore.getState();
  if (!state.isEnabledFor(conversationId)) return;

  const map = getPendingMap(conversationId);
  map.set(change.filePath, {
    filePath: change.filePath,
    action: change.action,
    additions: change.additions,
    deletions: change.deletions,
  });
}

/**
 * Trigger a batched review for everything in the buffer, attributed to the
 * milestone whose `taskTitle` is the just-completed todo's `content`.  Called
 * from `file-change-handlers` when the `chat-todo-updated` event includes a
 * status_changed → completed transition.
 *
 * Empty-buffer is a no-op: nothing was edited since the last flush.
 */
export function triggerMilestoneReview(
  conversationId: string,
  completedTodoContent: string,
): void {
  flushBuffer(conversationId, "milestone", completedTodoContent || null);
}

/**
 * Trigger a batched review at the end of an SDK turn (Stop hook).  Empty
 * buffer → skip (the previous milestone has already reviewed everything; we
 * don't want a duplicate "nothing changed" card).
 */
export function triggerTurnReview(
  conversationId: string,
  lastAssistantMessage: string | null,
): void {
  flushBuffer(conversationId, "turn", lastAssistantMessage);
}

/**
 * Cancel all in-flight reviews for the given conversation and clear its
 * pending buffer.  Called when the user disables the panel or switches away
 * from a workspace.
 */
export function cancelAllLiveReviews(conversationId: string): void {
  const buf = pendingByConv.get(conversationId);
  if (buf) buf.clear();
  pendingByConv.delete(conversationId);

  const store = useLiveReviewStore.getState();
  const conv = store.reviewsByConversation[conversationId];
  if (!conv) return;
  for (const reviewId of Object.keys(conv.reviews)) {
    const ctrl = activeAborts.get(reviewId);
    if (ctrl) {
      ctrl.abort();
      activeAborts.delete(reviewId);
    }
  }
}

/**
 * Manually re-run a previously-failed review by recreating it from the same
 * file snapshot.  Card UI calls this on Retry click.
 */
export function retryLiveReview(
  conversationId: string,
  item: LiveReviewItem,
): void {
  if (!conversationId) return;
  enqueueReview(conversationId, {
    scope: item.scope,
    files: [...item.files],
    taskTitle: item.taskTitle,
  });
}

// ---------------------------------------------------------------------------
// Internal: buffer flush + queue + execution
// ---------------------------------------------------------------------------

function flushBuffer(
  conversationId: string,
  scope: ReviewScope,
  taskTitle: string | null,
): void {
  if (!conversationId) return;
  const state = useLiveReviewStore.getState();
  if (!state.isEnabledFor(conversationId)) return;

  const map = pendingByConv.get(conversationId);
  if (!map || map.size === 0) return;

  const files: LiveReviewFileSnapshot[] = Array.from(map.values());
  // Reset buffer atomically before kicking off the review
  map.clear();

  enqueueReview(conversationId, { scope, files, taskTitle });
}

interface ReviewBatch {
  readonly scope: ReviewScope;
  readonly files: ReadonlyArray<LiveReviewFileSnapshot>;
  readonly taskTitle: string | null;
}

function enqueueReview(conversationId: string, batch: ReviewBatch): void {
  if (batch.files.length === 0) return;

  const reviewId = makeReviewId();
  // Snapshot the reviewer label at scheduling time so the footer "Reviewed
  // by …" badge and the forwarded-meta payload stay truthful even if the
  // user changes provider/model after the stream starts.
  const reviewerModel = resolveReviewerLabel();
  const seedItem: LiveReviewItem = {
    reviewId,
    scope: batch.scope,
    status: inflight.value < MAX_CONCURRENT ? "streaming" : "queued",
    content: "",
    error: null,
    startedAt: Date.now(),
    completedAt: null,
    files: batch.files,
    taskTitle: clipTaskTitle(batch.taskTitle),
    reviewerModel,
    forwardedAt: null,
    severity: "unknown",
  };
  useLiveReviewStore.getState().addReview(conversationId, seedItem);

  const run = (): void => {
    inflight.value += 1;
    void executeReview(conversationId, reviewId, batch).finally(() => {
      inflight.value -= 1;
      const next = queue.shift();
      if (next) next();
    });
  };

  if (inflight.value < MAX_CONCURRENT) {
    run();
  } else {
    queue.push(run);
  }
}

/**
 * Resolve "Platform · model" label using the provider snapshot at THIS instant.
 * Stored on the LiveReviewItem so the footer credit cannot drift mid-stream.
 *
 * Returns `null` when the configured local provider no longer exists or has
 * no usable credentials.
 */
function resolveReviewerLabel(): string | null {
  const store = useLiveReviewStore.getState();
  const settings = useSettingsStore.getState();
  const override = store.providerOverride;
  const platformId = (override.platformId
    ?? settings.activePlatformId) as PlatformId;
  const meta = PLATFORM_REGISTRY[platformId];
  const platformConfig = settings.platforms[platformId];
  if (!meta || !platformConfig) return null;
  const creds = resolveActiveCredentials(platformConfig);
  if (!creds) return null;
  const modelId =
    override.modelId
    ?? creds.model
    ?? platformConfig.activeModelId
    ?? "";
  return modelId ? `${meta.displayName} · ${modelId}` : meta.displayName;
}

function clipTaskTitle(title: string | null): string | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;
  if (t.length <= MAX_TASK_TITLE_CHARS) return t;
  return t.slice(0, MAX_TASK_TITLE_CHARS - 1) + "…";
}

async function executeReview(
  conversationId: string,
  reviewId: string,
  batch: ReviewBatch,
): Promise<void> {
  const store = useLiveReviewStore.getState();
  const abortCtrl = new AbortController();
  activeAborts.set(reviewId, abortCtrl);

  // ── Resolve provider config ────────────────────────────────────────────
  const providerCfg = resolveProviderConfig();
  if (!providerCfg) {
    store.markError(conversationId, reviewId, "no-provider");
    activeAborts.delete(reviewId);
    return;
  }

  // ── Workspace + per-file diff/content collection ──────────────────────
  const workspace = useWorkspaceStore.getState().activeWorkspace;
  const workspacePath = workspace?.path ?? "";

  const fileSections: FileSection[] = [];
  for (const file of batch.files) {
    if (abortCtrl.signal.aborted) {
      activeAborts.delete(reviewId);
      return;
    }
    fileSections.push(await collectFileSection(workspacePath, file));
  }

  if (abortCtrl.signal.aborted) {
    activeAborts.delete(reviewId);
    return;
  }

  const prompt = buildBatchReviewPrompt({
    workspacePath,
    scope: batch.scope,
    taskTitle: batch.taskTitle,
    files: fileSections,
    userTask: getRecentUserTaskContext(),
    mode: store.mode,
  });

  // ── Stream via Tauri Channel ──────────────────────────────────────────
  const channel = new Channel<{
    type: "delta" | "done" | "error";
    text?: string;
    message?: string;
  }>();

  channel.onmessage = (msg) => {
    if (abortCtrl.signal.aborted) return;
    if (msg.type === "delta" && msg.text) {
      useLiveReviewStore
        .getState()
        .appendDelta(conversationId, reviewId, msg.text);
    } else if (msg.type === "done") {
      const storeState = useLiveReviewStore.getState();
      const conv = storeState.reviewsByConversation[conversationId];
      const item = conv?.reviews[reviewId];
      if (item) {
        const { severity, body } = parseSeverityTrailing(item.content);
        storeState.setSeverityAndContent(
          conversationId,
          reviewId,
          severity,
          body,
        );
      }
      storeState.markDone(conversationId, reviewId);
    } else if (msg.type === "error") {
      useLiveReviewStore
        .getState()
        .markError(
          conversationId,
          reviewId,
          msg.message ?? "Stream error",
        );
    }
  };

  try {
    await invoke("ai_code_review_stream", {
      onChunk: channel,
      sdk: providerCfg.sdk,
      baseUrl: providerCfg.baseUrl || null,
      apiKey: providerCfg.apiKey || null,
      model: providerCfg.model || null,
      proxyUrl: providerCfg.proxyUrl || null,
      prompt,
    });
  } catch (err) {
    if (!abortCtrl.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      useLiveReviewStore
        .getState()
        .markError(conversationId, reviewId, msg);
    }
  } finally {
    if (activeAborts.get(reviewId) === abortCtrl) {
      activeAborts.delete(reviewId);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file diff/content collection
// ---------------------------------------------------------------------------

interface FileSection {
  readonly file: LiveReviewFileSnapshot;
  readonly diffText: string | null;
  readonly fileBody: string | null;
}

async function collectFileSection(
  workspacePath: string,
  file: LiveReviewFileSnapshot,
): Promise<FileSection> {
  let diffText: string | null = null;
  let fileBody: string | null = null;
  try {
    if (workspacePath && file.action !== "create") {
      const diff = await fetchFileDiff(workspacePath, file.filePath);
      if (diff && diff.hunks.length > 0) {
        diffText = formatDiffText(diff);
      }
    }
    if (file.action !== "delete") {
      fileBody = await readFileContent(file.filePath);
    }
  } catch (err) {
    void err;
  }
  return { file, diffText, fileBody };
}

// ---------------------------------------------------------------------------
// Provider resolution — independent of the main chat
// ---------------------------------------------------------------------------

interface ResolvedProviderConfig {
  readonly sdk: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly proxyUrl: string | undefined;
}

function resolveProviderConfig(): ResolvedProviderConfig | null {
  const store = useLiveReviewStore.getState();
  const settings = useSettingsStore.getState();

  const proxyUrl =
    settings.proxyEnabled && settings.proxyUrl ? settings.proxyUrl : undefined;
  const platformId =
    store.providerOverride.platformId ?? settings.activePlatformId;
  const platformConfig: PlatformConfig | undefined =
    settings.platforms[platformId];
  if (!platformConfig) return null;

  const creds = resolveActiveCredentials(platformConfig);
  if (!creds) return null;

  const model = store.providerOverride.modelId ?? creds.model ?? platformConfig.activeModelId;

  const sdk = getEffectiveSdk(platformConfig);
  const providerProxyUrl = sdk === "claude" ? buildActiveProfileProxyUrl(platformConfig) : proxyUrl;

  return {
    sdk,
    baseUrl: creds.baseUrl ?? "",
    apiKey: creds.apiKey ?? "",
    model: model ?? "",
    proxyUrl: providerProxyUrl,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — multi-file batched PR-style review
// ---------------------------------------------------------------------------

interface BuildBatchPromptArgs {
  readonly workspacePath: string;
  readonly scope: ReviewScope;
  readonly taskTitle: string | null;
  readonly files: ReadonlyArray<FileSection>;
  readonly userTask: string | null;
  readonly mode: LiveReviewMode;
}

function buildBatchReviewPrompt(args: BuildBatchPromptArgs): string {
  const sections: string[] = [];

  sections.push(
    `You are a senior code reviewer. The main coding agent just finished a batch of edits${
      args.scope === "milestone"
        ? " for one milestone"
        : args.scope === "turn"
          ? " in this turn"
          : ""
    }. Review the entire batch as a small PR. Reply in the same language the user used in their task description (default: 简体中文 if unclear).`,
  );

  sections.push(
    `Constraints:
- Look at the batch as a coherent change set.  Group findings by theme; don't duplicate the same point per file.
- Keep the review SHORT (≤ 400 words).  3–6 bullets, or one paragraph.
- Flag only items that are actionable: bug, security, breakage, perf hot path, clear style violation.
- Skip generic praise.  If the batch is fine, say "Looks good." plus one sentence why and stop.
- Output plain markdown.  No headings deeper than ###.
- If a file body or diff carries a "(... truncated to first N chars)" tail, do NOT abstain on that
  basis alone.  Review what IS visible — the diff is always provided in full and is sufficient for
  most judgments.  Only flag missing context if a SPECIFIC line in the visible diff cannot be
  judged without seeing the trimmed portion; otherwise proceed as if the truncated tail were not a
  blocker.

**MANDATORY** — End your reply with EXACTLY one line of the form:
\`SEVERITY: <level>\`
where <level> is one of:
- \`critical\` — bug, security flaw, breakage, or correctness issue requiring immediate fix
- \`warning\` — likely problem, perf hot path, or risky pattern that should be addressed
- \`info\` — minor suggestion, style nit, or non-blocking refactor idea
- \`ok\` — change is fine, no action needed

Pick the level honestly based on the worst finding in the batch.  This line MUST be the very last line of the response, on its own, with no surrounding markup, code fence, or other text after it.`,
  );

  if (args.taskTitle) {
    const heading =
      args.scope === "milestone"
        ? "Milestone (just-completed todo)"
        : args.scope === "turn"
          ? "Turn summary (last assistant message)"
          : "Task";
    sections.push(
      `### ${heading}\n${clipText(args.taskTitle, MAX_TASK_TITLE_CHARS, "task title")}`,
    );
  }

  if (args.userTask) {
    sections.push(
      `### Main chat task context (most recent user message)
${clipText(args.userTask, MAX_USER_CONTEXT_CHARS, "user message")}`,
    );
  }

  // ── Per-file sections ────────────────────────────────────────────────
  sections.push(`### Files in this batch (${args.files.length})`);
  for (const fs of args.files) {
    const relPath = args.workspacePath
      ? toRelativePath(fs.file.filePath, args.workspacePath)
      : fs.file.filePath;
    const header = `#### \`${relPath}\` — ${fs.file.action} (+${fs.file.additions}/-${fs.file.deletions})`;
    const blocks: string[] = [header];

    if (fs.file.action === "delete") {
      blocks.push(`_(file deleted)_`);
    } else if (fs.file.action === "create" || !fs.diffText) {
      if (fs.fileBody) {
        blocks.push(
          `Full content (no diff baseline available):\n\`\`\`\n${clipText(fs.fileBody, MAX_FILE_CHARS, "file")}\n\`\`\``,
        );
      } else {
        blocks.push(`_(file content unavailable)_`);
      }
    } else {
      blocks.push(
        `Diff:\n\`\`\`diff\n${clipText(fs.diffText, MAX_DIFF_CHARS, "diff")}\n\`\`\``,
      );
      if (fs.fileBody) {
        blocks.push(
          `Full file (context only — do not review unchanged parts):\n\`\`\`\n${clipText(fs.fileBody, MAX_FILE_CHARS, "file")}\n\`\`\``,
        );
      }
    }

    sections.push(blocks.join("\n\n"));
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Pull the most recent user message from the active main chat conversation.
// ---------------------------------------------------------------------------

function getRecentUserTaskContext(): string | null {
  try {
    const messages = useChatStore.getState().messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === "user") {
        const text = msg.displayContent ?? msg.content;
        if (text && text.trim()) return text;
      }
    }
    return null;
  } catch {
    return null;
  }
}
