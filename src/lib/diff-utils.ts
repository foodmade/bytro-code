/**
 * Utilities for extracting and manipulating per-file sections from a unified diff string.
 */

export interface GitDiffHeaderPaths {
  readonly a: string;
  readonly b: string;
}

/**
 * Extract the unified diff section for a single file from a full multi-file diff.
 *
 * Splits on `diff --git` boundaries and matches the target file path
 * against both header and patch-path lines.
 *
 * Returns `null` if the file is not found in the diff.
 */
export function extractSingleFileDiff(fullDiff: string, filePath: string): string | null {
  const sections = splitDiffSections(fullDiff);
  const normalized = normalizePath(filePath);

  for (const section of sections) {
    if (sectionMatchesFile(section, normalized)) {
      return section;
    }
  }

  return null;
}

/**
 * Remove a single file's diff section from the full diff string.
 *
 * Used after a successful revert to update the stored `turnDiff`.
 * Returns the remaining diff (possibly empty).
 */
export function removeFileFromDiff(fullDiff: string, filePath: string): string {
  const sections = splitDiffSections(fullDiff);
  const normalized = normalizePath(filePath);

  const remaining = sections.filter((section) => !sectionMatchesFile(section, normalized));

  return remaining.join("\n").trim();
}

/**
 * Split a multi-file unified diff into per-file sections with their file paths.
 *
 * Used for cross-turn diff accumulation: merging diffs from multiple messages
 * into a single view while tracking which file belongs to which message.
 *
 * Returns an array of `{ filePath, diff }` entries.
 */
export function splitDiffWithPaths(
  fullDiff: string,
): readonly { readonly filePath: string; readonly diff: string }[] {
  const sections = splitDiffSections(fullDiff);
  return sections.map((section) => {
    const filePath = getDiffFilePath(section) ?? "unknown";
    return { filePath, diff: section };
  });
}

/**
 * Merge multiple diff sections for the **same file** into one.
 *
 * Keeps a single `diff --git` / `---` / `+++` header and concatenates
 * all `@@ ... @@` hunks from every section.
 *
 * If the latest section is a full-file write (`--- /dev/null`), it
 * replaces all earlier sections (the previous content is irrelevant).
 */
export function mergeSameFileDiffs(diffs: readonly string[]): string {
  if (diffs.length <= 1) return diffs[0] ?? "";

  // If the last diff is a full write, earlier diffs are superseded
  const last = diffs[diffs.length - 1];
  if (last.includes("--- /dev/null")) return last;

  let header: string[] | null = null;
  const allHunks: string[] = [];

  for (const diff of diffs) {
    const lines = diff.split("\n");

    // Find where hunks start (first @@ line)
    const hunkIdx = lines.findIndex((l) => l.startsWith("@@"));
    if (hunkIdx === -1) {
      // No hunks — skip (shouldn't happen for valid diffs)
      continue;
    }

    // Capture header from the first section that has `--- a/` (modification)
    if (header === null) {
      header = lines.slice(0, hunkIdx);
    } else if (
      header.some((h) => h.startsWith("--- /dev/null")) &&
      !lines.slice(0, hunkIdx).some((h) => h.startsWith("--- /dev/null"))
    ) {
      // Prefer modification header over creation header
      header = lines.slice(0, hunkIdx);
    }

    allHunks.push(...lines.slice(hunkIdx));
  }

  if (!header) return last;
  return [...header, ...allHunks].join("\n");
}

/**
 * Parse `diff --git` header paths and normalize `a/` / `b/` prefixes away.
 *
 * Supports both unquoted and quoted paths, including spaces.
 */
export function parseGitDiffHeader(line: string): GitDiffHeaderPaths | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return null;

  const rest = line.slice(prefix.length).trim();
  const [aRaw, bRaw] = tokenizeDiffHeader(rest);
  if (!aRaw || !bRaw) return null;

  return {
    a: normalizeDiffPathToken(aRaw),
    b: normalizeDiffPathToken(bRaw),
  };
}

/**
 * Parse a path-carrying patch line such as:
 * - `--- a/file.ts`
 * - `+++ "b/new file.ts"`
 * - `rename from old.ts`
 * - `rename to new.ts`
 */
export function parsePatchPathLine(line: string): string | null {
  const prefixes = ["--- ", "+++ ", "rename from ", "rename to ", "copy from ", "copy to "];
  const prefix = prefixes.find((item) => line.startsWith(item));
  if (!prefix) return null;

  const rest = line.slice(prefix.length).trim();
  const [rawPath] = tokenizeDiffHeader(rest);
  if (!rawPath) return null;

  return normalizeDiffPathToken(rawPath);
}

/**
 * Resolve the primary file path for a diff section.
 *
 * Prefers the `b/` path, falling back to `a/` for deletions and then to
 * `---` / `+++` patch lines when the `diff --git` header is absent.
 */
export function getDiffFilePath(section: string): string | null {
  const lines = section.split("\n");
  const header = parseGitDiffHeader(lines[0] ?? "");
  if (header) {
    if (header.b !== "/dev/null") return normalizePath(header.b);
    if (header.a !== "/dev/null") return normalizePath(header.a);
  }

  for (const line of lines.slice(0, 8)) {
    const patchPath = parsePatchPathLine(line);
    if (patchPath && patchPath !== "/dev/null") {
      return normalizePath(patchPath);
    }
  }

  return null;
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Split a multi-file unified diff into per-file sections.
 * Each section starts with `diff --git`.
 *
 * If the diff omits the header but still looks like a patch, keep it as a
 * single section so newly created files from some providers still render.
 */
function splitDiffSections(fullDiff: string): readonly string[] {
  const marker = "diff --git ";
  const firstIdx = fullDiff.indexOf(marker);

  if (firstIdx === -1) {
    const trimmed = fullDiff.trim();
    if (/^(--- |\+\+\+ |@@ )/m.test(trimmed)) {
      return trimmed ? [trimmed] : [];
    }
    return [];
  }

  const sections: string[] = [];
  let idx = firstIdx;

  while (idx !== -1) {
    const next = fullDiff.indexOf(marker, idx + marker.length);
    const section = next === -1 ? fullDiff.slice(idx) : fullDiff.slice(idx, next);
    sections.push(section.trimEnd());
    idx = next;
  }

  return sections;
}

/**
 * Check if a diff section matches a target file path.
 *
 * Matches against:
 * - `diff --git a/<path> b/<path>` header
 * - `---` / `+++` patch lines
 * - `rename from` / `rename to` lines
 */
function sectionMatchesFile(section: string, filePath: string): boolean {
  for (const path of collectSectionPaths(section)) {
    if (path === filePath) {
      return true;
    }
  }

  return false;
}

function collectSectionPaths(section: string): readonly string[] {
  const paths = new Set<string>();
  const lines = section.split("\n");
  const header = parseGitDiffHeader(lines[0] ?? "");

  if (header?.a && header.a !== "/dev/null") {
    paths.add(normalizePath(header.a));
  }
  if (header?.b && header.b !== "/dev/null") {
    paths.add(normalizePath(header.b));
  }

  for (const line of lines.slice(0, 8)) {
    const patchPath = parsePatchPathLine(line);
    if (patchPath && patchPath !== "/dev/null") {
      paths.add(normalizePath(patchPath));
    }
  }

  return [...paths];
}

function tokenizeDiffHeader(input: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += decodeDiffEscape(ch);
      escaped = false;
      continue;
    }

    if (quote) {
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaped) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function decodeDiffEscape(ch: string): string {
  switch (ch) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case '"':
      return '"';
    case "'":
      return "'";
    case "\\":
      return "\\";
    default:
      return ch;
  }
}

function normalizeDiffPathToken(rawPath: string): string {
  const normalized = rawPath.trim();
  if (normalized === "/dev/null") return normalized;
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    return normalized.slice(2);
  }
  return normalized;
}

/** Normalize path separators to forward slashes and trim leading slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}
