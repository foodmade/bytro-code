import type { ToolCall, ThinkingEntry } from "@/stores/chat-store";

/** A harness-injected subagent completion notice embedded in message text
 *  (`<task-notification>...</task-notification>`). The CLI replays these into
 *  the assistant stream when background agents finish; they are machine
 *  notifications, not model prose, so the UI renders them as a compact chip
 *  instead of raw text. */
export interface TaskNotice {
  /** Range of the raw tag block in the content string (start inclusive). */
  readonly start: number;
  readonly end: number;
  /** Agent name parsed from "Agent `name` has completed", if present. */
  readonly agentName?: string;
  /** Inner text of the notification block, trimmed. */
  readonly text: string;
}

export type MessageSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly entry: ThinkingEntry; readonly isLastBlock: boolean }
  | { readonly kind: "tools"; readonly calls: ReadonlyArray<ToolCall> }
  | { readonly kind: "notices"; readonly notices: ReadonlyArray<TaskNotice> };

type PositionedItem =
  | { readonly offset: number; readonly sortKey: 0; readonly kind: "thinking"; readonly entry: ThinkingEntry; readonly isLastBlock: boolean }
  | { readonly offset: number; readonly sortKey: 1; readonly kind: "tools"; readonly calls: ToolCall[] }
  | { readonly offset: number; readonly sortKey: 2; readonly kind: "notices"; readonly notice: TaskNotice };

const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;
const NOTICE_AGENT_RE = /Agent\s+`([^`]+)`/;
/** Harness notices always open with e.g. "Completion notification received."
 *  — anything else inside the tags (regex literals, docs, quoted examples) is
 *  prose the model wrote and must render as-is. */
const NOTICE_BODY_RE = /^\w+ notification received/;

/** Byte ranges of fenced code blocks (``` / ~~~). An unterminated fence
 *  (still streaming) extends to the end of the content. Keep the fence regex
 *  in sync with hasBalancedStreamingFences above. */
function findFencedCodeRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const fenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})/g;
  let openStart: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(content)) !== null) {
    if (openStart === null) {
      openStart = match.index + match[1].length;
    } else {
      ranges.push({ start: openStart, end: fenceRe.lastIndex });
      openStart = null;
    }
  }
  if (openStart !== null) ranges.push({ start: openStart, end: content.length });
  return ranges;
}

/** Scan message content for `<task-notification>` blocks. An unterminated
 *  block (still streaming) extends to the end of the content. Matches inside
 *  fenced code blocks, or whose body doesn't look like a harness notice, are
 *  skipped — the model may legitimately write the tag in code or docs. */
export function extractTaskNotices(content: string): TaskNotice[] {
  if (!content.includes("<task-notification>")) return [];
  const codeRanges = findFencedCodeRanges(content);
  const inCode = (pos: number): boolean =>
    codeRanges.some((range) => pos >= range.start && pos < range.end);
  const notices: TaskNotice[] = [];
  TASK_NOTIFICATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TASK_NOTIFICATION_RE.exec(content)) !== null) {
    if (inCode(match.index)) continue;
    const text = match[1].trim();
    if (!NOTICE_BODY_RE.test(text)) continue;
    notices.push({
      start: match.index,
      end: match.index + match[0].length,
      agentName: NOTICE_AGENT_RE.exec(text)?.[1],
      text,
    });
  }
  return notices;
}

export interface NormalizedMessageContent {
  readonly content: string;
  readonly thinkingBlocks: ReadonlyArray<ThinkingEntry>;
  readonly mapOffset: (offset: number) => number;
  readonly canMapSourceOffsets: boolean;
}

function hasBalancedStreamingFences(markdown: string): boolean {
  // `[ \t]*` tolerates indented fences (e.g. list-nested code blocks). Without
  // it an open fence like "  ```ts" is missed, the count looks balanced, and a
  // still-open block can be sliced into the stable segment — which renders via
  // the non-lightweight (rehypeHighlight) path with no dangling-fence repair.
  // Keep this regex in sync with closeDanglingCodeFence in markdown-renderer.
  const fences = [...markdown.matchAll(/(^|\n)[ \t]*(`{3,}|~{3,})([^\n]*)/g)];
  return fences.length % 2 === 0;
}

export function findStableStreamingMarkdownBoundary(markdown: string): number {
  const minTailLength = 240;
  if (markdown.length <= minTailLength * 2) return 0;

  let candidate = markdown.lastIndexOf("\n\n", markdown.length - minTailLength);
  while (candidate > 0) {
    const boundary = candidate + 2;
    if (hasBalancedStreamingFences(markdown.slice(0, boundary))) {
      return boundary;
    }
    candidate = markdown.lastIndexOf("\n\n", candidate - 1);
  }

  return 0;
}

function extractInlineThinkTags(text: string): NormalizedMessageContent {
  const regex = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/g;
  const thinkingBlocks: ThinkingEntry[] = [];
  const removedRanges: Array<{ start: number; end: number }> = [];
  let cleaned = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      cleaned += text.slice(lastIndex, match.index);
    }

    const isClosed = match[0].endsWith("</think>") || match[0].endsWith("</thinking>");
    const thinkContent = match[1].trim();
    if (thinkContent) {
      thinkingBlocks.push({
        text: thinkContent,
        textOffset: cleaned.length,
        complete: isClosed,
      });
    }

    removedRanges.push({
      start: match.index,
      end: match.index + match[0].length,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    cleaned += text.slice(lastIndex);
  }

  const mapOffset = (offset: number): number => {
    if (removedRanges.length === 0) return offset;

    let removed = 0;
    for (const range of removedRanges) {
      if (offset <= range.start) break;
      removed += Math.min(offset, range.end) - range.start;
      if (offset < range.end) break;
    }

    const mapped = offset - removed;
    if (mapped <= 0) return 0;
    if (mapped >= cleaned.length) return cleaned.length;
    return mapped;
  };

  return { content: cleaned, thinkingBlocks, mapOffset, canMapSourceOffsets: true };
}

export function normalizeMessageContent(
  content: string,
  thinkingBlocks?: ReadonlyArray<ThinkingEntry>,
): NormalizedMessageContent {
  let resolvedContent = content;
  let canMapSourceOffsets = true;
  const trimmed = content.trimStart();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
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
        if (texts.length > 0) {
          resolvedContent = texts.join("\n\n");
          canMapSourceOffsets = false;
        }
      }
    } catch {
      // Not valid JSON, keep the original content.
    }
  }

  const inlineResult = /<think(?:ing)?>/.test(resolvedContent)
    ? extractInlineThinkTags(resolvedContent)
    : {
        content: resolvedContent,
        thinkingBlocks: [] as ThinkingEntry[],
        mapOffset: (offset: number) => offset,
        canMapSourceOffsets: true,
      };

  return {
    content: inlineResult.content,
    thinkingBlocks: [
      ...(thinkingBlocks ?? []),
      ...inlineResult.thinkingBlocks,
    ],
    mapOffset: inlineResult.mapOffset,
    canMapSourceOffsets: canMapSourceOffsets && inlineResult.canMapSourceOffsets,
  };
}

export function getVisibleMessageContentLength({
  sourceContent,
  visibleSourceContent,
  normalized,
  isRevealActive,
}: {
  readonly sourceContent: string;
  readonly visibleSourceContent: string;
  readonly normalized: NormalizedMessageContent;
  readonly isRevealActive: boolean;
}): number | undefined {
  if (!isRevealActive || visibleSourceContent === sourceContent) return undefined;
  if (normalized.canMapSourceOffsets) {
    return normalized.mapOffset(visibleSourceContent.length);
  }
  return normalizeMessageContent(visibleSourceContent).content.length;
}

export function buildSegments(
  content: string,
  toolCalls?: ReadonlyArray<ToolCall>,
  thinkingBlocks?: ReadonlyArray<ThinkingEntry>,
  mapOffset: (offset: number) => number = (offset) => offset,
  visibleLength?: number,
): MessageSegment[] {
  const visibleEnd = visibleLength === undefined
    ? content.length
    : Math.min(content.length, Math.max(0, visibleLength));
  const notices = extractTaskNotices(content);
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasThinking = thinkingBlocks && thinkingBlocks.length > 0;
  const hasNotices = notices.length > 0;

  if (!hasToolCalls && !hasThinking && !hasNotices) {
    const visibleText = content.slice(0, visibleEnd);
    if (!visibleText) return [];
    return [{ kind: "text", text: visibleText }];
  }

  // Tools without offsets render after the text. When notices exist the text
  // still needs positional cutting, so defer the tools to the tail instead of
  // taking the simple path.
  let positionedTools = hasToolCalls ? toolCalls : undefined;
  let trailingTools: ReadonlyArray<ToolCall> | null = null;
  if (hasToolCalls && !hasThinking) {
    const hasOffsets = toolCalls.some((tc) => tc.textOffset !== undefined);
    if (!hasOffsets) {
      if (!hasNotices) {
        const segs: MessageSegment[] = [];
        const visibleText = content.slice(0, visibleEnd);
        if (visibleText) segs.push({ kind: "text", text: visibleText });
        if (visibleEnd >= content.length) segs.push({ kind: "tools", calls: toolCalls });
        return segs;
      }
      trailingTools = toolCalls;
      positionedTools = undefined;
    }
  }

  const clampOffset = (offset: number): number => {
    if (offset <= 0) return 0;
    if (offset >= content.length) return content.length;
    return offset;
  };

  const items: PositionedItem[] = [];

  if (hasThinking) {
    for (let idx = 0; idx < thinkingBlocks.length; idx += 1) {
      const offset = clampOffset(thinkingBlocks[idx].textOffset);
      if (offset > visibleEnd) continue;
      items.push({
        offset,
        sortKey: 0,
        kind: "thinking",
        entry: thinkingBlocks[idx],
        isLastBlock: idx === thinkingBlocks.length - 1,
      });
    }
  }

  if (positionedTools) {
    const groups = new Map<number, ToolCall[]>();
    for (const tc of positionedTools) {
      const offset = clampOffset(mapOffset(tc.textOffset ?? 0));
      if (offset > visibleEnd) continue;
      const group = groups.get(offset);
      if (group) {
        group.push(tc);
      } else {
        groups.set(offset, [tc]);
      }
    }
    for (const [offset, calls] of groups) {
      items.push({ offset, sortKey: 1, kind: "tools", calls });
    }
  }

  for (const notice of notices) {
    if (notice.start > visibleEnd) continue;
    items.push({ offset: notice.start, sortKey: 2, kind: "notices", notice });
  }

  if (items.length === 0) {
    const segs: MessageSegment[] = [];
    const visibleText = content.slice(0, visibleEnd);
    if (visibleText) segs.push({ kind: "text", text: visibleText });
    return segs;
  }

  items.sort((a, b) => a.offset - b.offset || a.sortKey - b.sortKey);

  const segments: MessageSegment[] = [];
  let lastOffset = 0;

  for (const item of items) {
    if (item.offset > lastOffset) {
      const text = content.slice(lastOffset, Math.min(item.offset, visibleEnd));
      if (text.trim()) segments.push({ kind: "text", text });
    }

    if (item.kind === "thinking") {
      segments.push({ kind: "thinking", entry: item.entry, isLastBlock: item.isLastBlock });
    } else if (item.kind === "tools") {
      // Merge tools segments that are adjacent (no visible text or thinking
      // between them) so a multi-step tool chain renders as one unit instead
      // of fragmenting per text offset.
      const prev = segments[segments.length - 1];
      if (prev?.kind === "tools") {
        segments[segments.length - 1] = { kind: "tools", calls: [...prev.calls, ...item.calls] };
      } else {
        segments.push({ kind: "tools", calls: item.calls });
      }
    } else {
      // Notices occupy a range of raw content — render the chip, then skip
      // the raw tag text entirely. Adjacent notices merge into one chip group.
      const prev = segments[segments.length - 1];
      if (prev?.kind === "notices") {
        segments[segments.length - 1] = { kind: "notices", notices: [...prev.notices, item.notice] };
      } else {
        segments.push({ kind: "notices", notices: [item.notice] });
      }
      lastOffset = Math.max(lastOffset, item.notice.end);
      continue;
    }
    lastOffset = Math.max(lastOffset, item.offset);
  }

  if (lastOffset < visibleEnd) {
    const text = content.slice(lastOffset, visibleEnd);
    if (text.trim()) segments.push({ kind: "text", text });
  }

  if (trailingTools && visibleEnd >= content.length) {
    segments.push({ kind: "tools", calls: trailingTools });
  }

  return segments;
}
