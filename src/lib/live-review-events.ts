// ---------------------------------------------------------------------------
// Live Reviewer ↔ Main Chat bridge — shared event names and message metadata
// types.  Lives in `lib/` (not `components/chat/`) so that both the reviewer
// panel (LiveReviewCard) and the main chat input (ChatInput) can import it
// without forming a UI ↔ UI cyclic dependency.
//
// Future-proofing notes:
//   - `source` is a string discriminator so we can add new providers
//     ("deep-review" once the agentic SDK reviewer ships, "external-tool"
//     for codex helpers, etc.) without breaking existing readers.
//   - `mode` distinguishes Lite (single ChatCompletion call) vs Deep (long-
//     running agentic reviewer session).  Card rendering switches on it.
//   - The same `ReviewForwardMeta` shape is reused for both the dispatched
//     CustomEvent payload AND for `ChatMessage.reviewForward`, ensuring the
//     compact card has every field it needs without re-querying any store.
// ---------------------------------------------------------------------------

/** Where the review came from.  Add new variants here as new sources land. */
export type ReviewForwardSource = "live-review";

/** Reviewer execution model. */
export type ReviewForwardMode = "lite" | "deep";

/**
 * What triggered the review batch.  Drives the small badge on the card so the
 * user knows whether a review summarises a single milestone (a TodoWrite item
 * just transitioning to `completed`) or the entire turn after the agent's
 * Stop hook fired.  `manual` is reserved for an explicit retry / re-run.
 */
export type ReviewScope = "milestone" | "turn" | "manual";

/** Reviewer-assigned severity, ordered roughly by urgency.  Defaults to
 *  `unknown` when the LLM didn't follow the trailing-marker convention so
 *  the UI can render a neutral state instead of guessing. */
export type ReviewSeverity = "ok" | "info" | "warning" | "critical" | "unknown";

/**
 * Parse the trailing `SEVERITY: <level>` (or `[severity: ...]`) marker the
 * reviewer prompt asks the LLM to emit, returning the level + the markdown
 * body with that marker stripped.  The marker is matched on the LAST line of
 * the body so a stray mention earlier in the review doesn't trigger it.
 *
 * Accepts (case-insensitive):
 *   SEVERITY: critical
 *   severity: warning
 *   [severity: info]
 *   严重程度：critical
 *   严重程度: warning
 */
export function parseSeverityTrailing(rawContent: string): {
  readonly severity: ReviewSeverity;
  readonly body: string;
} {
  const trimmed = rawContent.replace(/\s+$/, "");
  const lastNewline = trimmed.lastIndexOf("\n");
  const lastLine = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);
  const match = lastLine.match(
    /^\s*(?:\[\s*)?(?:severity|严重程度|严重等级|review[-_ ]?severity)\s*[:：]\s*(critical|warning|info|ok|严重|严重问题|警告|建议|提示|信息|无问题|良好|无)\s*\]?\s*$/i,
  );
  if (!match) {
    return { severity: "unknown", body: rawContent };
  }
  const token = match[1].toLowerCase();
  let severity: ReviewSeverity = "unknown";
  if (token === "critical" || token === "严重" || token === "严重问题") severity = "critical";
  else if (token === "warning" || token === "警告") severity = "warning";
  else if (token === "info" || token === "建议" || token === "提示" || token === "信息") severity = "info";
  else if (token === "ok" || token === "无问题" || token === "良好" || token === "无") severity = "ok";
  // Strip the marker line from the body
  const body = lastNewline === -1
    ? ""
    : trimmed.slice(0, lastNewline).replace(/\s+$/, "");
  return { severity, body };
}

/**
 * Compact descriptor for one of the files included in a review batch.  The
 * forward card uses these to render the file list (one row per file) when
 * the user expands the bubble.
 */
export interface ReviewForwardFile {
  /** Workspace-relative path (preferred for display). */
  readonly filePath: string;
  /** Last path segment — used for the compact pill in the collapsed card. */
  readonly fileName: string;
  readonly action: "edit" | "create" | "delete";
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Structured metadata attached to a chat message that originated as a
 * "forwarded review" — allows the message bubble to render as a compact,
 * collapsible card instead of a wall of markdown text.
 *
 * Multi-file batched reviews are the default: a single `files` array carries
 * every file the reviewer looked at this turn/milestone.  When a single-file
 * snapshot is needed (the collapsed pill), use `files[0]`.
 */
export interface ReviewForwardMeta {
  readonly source: ReviewForwardSource;
  readonly mode: ReviewForwardMode;
  /** What triggered this review batch (turn boundary / milestone / manual). */
  readonly scope: ReviewScope;
  /** Files included in this review batch.  Always ≥ 1; single-file reviews
   *  populate exactly one element. */
  readonly files: ReadonlyArray<ReviewForwardFile>;
  /** Optional task/milestone title — Stop-hook turns use the agent's last
   *  assistant message; TodoWrite milestones use the completed todo's
   *  `content`.  May be `null` when no contextual hint was available. */
  readonly taskTitle: string | null;
  /** Human-readable provider+model (e.g. "Codex · gpt-5.5"). */
  readonly reviewerModel: string;
  /** ≤120 chars summary used as the collapsed-card body. */
  readonly summary: string;
  /** Full review markdown — rendered when the card is expanded. */
  readonly fullContent: string;
  /** Severity classification derived from the reviewer's trailing marker.
   *  Drives the card's accent color and badge so users can tell at-a-glance
   *  whether the reviewer found problems. */
  readonly severity: ReviewSeverity;
  /** Original review id (used for de-dup / tracing). */
  readonly reviewId: string;
  /** When the review was originally produced (ms epoch). */
  readonly reviewedAt: number;
}

/**
 * Generic per-message metadata bag.  Lives at the chat-input → chat-streaming
 * boundary so future "structured user inputs" (e.g. agentic tool forwards,
 * external tool results) can extend it without touching call signatures.
 */
export interface ChatMessageMetadata {
  readonly reviewForward?: ReviewForwardMeta;
}

/** Window-level event used to forward a finished review into the main chat. */
export const LIVE_REVIEW_SEND_TO_CHAT_EVENT = "live-review-send-to-chat";

/** Payload of the {@link LIVE_REVIEW_SEND_TO_CHAT_EVENT} CustomEvent. */
export interface LiveReviewSendToChatDetail {
  /** Conversation that issued the review.  Used by ChatInput to ignore
   *  events not meant for its own chat instance. */
  readonly conversationId: string;
  /** What the LLM should see — typically `injectionPrefixBatch + fullContent`. */
  readonly prompt: string;
  /** Structured metadata used to render the compact card in the chat. */
  readonly meta: ReviewForwardMeta;
}

/**
 * Build a short single-line summary from a review's full markdown body.
 * Heuristic: first non-empty line, code/heading prefixes stripped, capped to
 * ~120 chars with an ellipsis.  Returned text is plain (markdown stripped).
 */
export function buildReviewSummary(fullContent: string, maxChars = 120): string {
  const firstLine = fullContent
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? "";
  // Strip leading markdown decorations: -, *, >, #, numbering, code fences
  const stripped = firstLine
    .replace(/^[-*>+•]\s*/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^`{1,3}/, "")
    .trim();
  if (stripped.length <= maxChars) return stripped;
  return stripped.slice(0, maxChars - 1) + "…";
}
