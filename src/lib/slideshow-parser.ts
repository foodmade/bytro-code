import type { SlideshowData, SlideshowPatch } from "@/types/slideshow";
import { jsonrepair } from "jsonrepair";
import { parse as parsePartialJson } from "partial-json";

// ---------------------------------------------------------------------------
// Slideshow JSON extraction & robust parsing
//
// Uses two battle-tested libraries:
//   - jsonrepair  (2k+ stars) — fixes missing commas, quotes, brackets, etc.
//   - partial-json (OpenAI SDK uses it) — parses truncated/streaming JSON
// ---------------------------------------------------------------------------

const FENCE_OPEN = /```slideshow\s*\n?/;
const FENCE_CLOSE = /\n?```/;

export interface ExtractResult {
  /** Whether a ```slideshow block was found */
  found: boolean;
  /** The raw JSON string inside the fence (may be truncated) */
  rawJson: string;
  /** Whether the closing ``` was found (false during streaming) */
  isComplete: boolean;
}

/**
 * Extract the JSON content from a ```slideshow ... ``` fenced code block
 * in a chat message string.
 */
export function extractSlideshowJson(content: string): ExtractResult {
  const openMatch = FENCE_OPEN.exec(content);
  if (!openMatch) {
    return { found: false, rawJson: "", isComplete: false };
  }

  const jsonStart = openMatch.index + openMatch[0].length;
  const rest = content.slice(jsonStart);

  const closeMatch = FENCE_CLOSE.exec(rest);
  if (closeMatch) {
    return {
      found: true,
      rawJson: rest.slice(0, closeMatch.index),
      isComplete: true,
    };
  }

  // No closing fence yet — streaming in progress
  return { found: true, rawJson: rest, isComplete: false };
}

export interface ParseResult {
  data: SlideshowData | null;
  patch: SlideshowPatch | null;
  error: string | null;
}

/**
 * Parse a (possibly truncated / malformed) JSON string into SlideshowData.
 *
 * Strategy:
 *   1. Try JSON.parse directly (fast path for valid JSON)
 *   2. Use jsonrepair to fix LLM syntax errors (missing commas, quotes, etc.)
 *   3. If lenient, use partial-json to parse truncated streaming JSON
 */
export function parseSlideshowJson(
  raw: string,
  lenient: boolean,
): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { data: null, patch: null, error: null };
  }

  // Fast path: try parsing as-is
  const direct = tryParse(trimmed);
  if (direct.data || direct.patch) {
    return { ...direct, error: null };
  }

  // Step 1: Use jsonrepair to fix syntax errors
  try {
    const repaired = jsonrepair(trimmed);
    const result = tryParse(repaired);
    if (result.data || result.patch) {
      return { ...result, error: null };
    }
  } catch {
    // jsonrepair threw — JSON is too broken for repair alone
  }

  if (!lenient) {
    return { data: null, patch: null, error: "Invalid JSON" };
  }

  // Step 2: Use partial-json for truncated/streaming JSON
  // First try on the repaired version, then on raw
  for (const input of [tryRepairSafe(trimmed), trimmed]) {
    if (!input) continue;
    try {
      const parsed = parsePartialJson(input);
      const result = classify(parsed);
      if (result.data || result.patch) {
        return { ...result, error: null };
      }
    } catch {
      // partial-json couldn't handle it either
    }
  }

  return { data: null, patch: null, error: null };
}

/** jsonrepair wrapped to never throw */
function tryRepairSafe(json: string): string | null {
  try {
    return jsonrepair(json);
  } catch {
    return null;
  }
}

/** Validate the parsed object has the minimum SlideshowData shape */
export function isSlideshowData(val: unknown): boolean {
  return (
    val != null &&
    typeof val === "object" &&
    typeof (val as Record<string, unknown>).title === "string"
  );
}

/** Validate the parsed object has the SlideshowPatch shape */
export function isSlideshowPatch(val: unknown): boolean {
  return (
    val != null &&
    typeof val === "object" &&
    typeof (val as Record<string, unknown>).slideIndex === "number" &&
    (val as Record<string, unknown>).slide != null &&
    typeof (val as Record<string, unknown>).slide === "object"
  );
}

interface TryParseResult {
  data: SlideshowData | null;
  patch: SlideshowPatch | null;
}

function tryParse(json: string): TryParseResult {
  try {
    const parsed = JSON.parse(json);
    if (isSlideshowPatch(parsed)) {
      return { data: null, patch: parsed as SlideshowPatch };
    }
    if (isSlideshowData(parsed)) {
      return { data: parsed as SlideshowData, patch: null };
    }
    return { data: null, patch: null };
  } catch {
    return { data: null, patch: null };
  }
}

/** Classify an already-parsed value into data or patch */
function classify(val: unknown): TryParseResult {
  if (isSlideshowPatch(val)) {
    return { data: null, patch: val as SlideshowPatch };
  }
  if (isSlideshowData(val)) {
    return { data: val as SlideshowData, patch: null };
  }
  return { data: null, patch: null };
}
