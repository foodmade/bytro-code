import type { ToolCall } from "@/stores/chat-types";

interface EditInput {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
}

interface WriteInput {
  readonly file_path: string;
  readonly content: string;
}

interface FileChange {
  readonly kind: "edit" | "write";
  readonly oldString?: string;
  readonly newString?: string;
  readonly content?: string;
}

/**
 * Synthesize a unified diff string from Claude Edit/Write tool calls.
 *
 * Used as a fallback when `msg.turnDiff` is absent (Claude channel).
 * Returns `undefined` when no successful file-modifying tool calls exist.
 */
export function synthesizeUnifiedDiff(
  toolCalls: ReadonlyArray<ToolCall> | undefined,
): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  // Group changes by file path (preserving insertion order)
  const fileChanges = new Map<string, FileChange[]>();

  for (const tc of toolCalls) {
    if (tc.status !== "success") continue;

    const name = tc.toolName.toLowerCase();
    if (name !== "edit" && name !== "write") continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(tc.toolInput);
    } catch {
      continue;
    }

    if (name === "edit") {
      const input = parsed as unknown as EditInput;
      if (!input.file_path) continue;
      const changes = fileChanges.get(input.file_path) ?? [];
      changes.push({
        kind: "edit",
        oldString: input.old_string ?? "",
        newString: input.new_string ?? "",
      });
      fileChanges.set(input.file_path, changes);
    } else {
      const input = parsed as unknown as WriteInput;
      if (!input.file_path) continue;
      const changes = fileChanges.get(input.file_path) ?? [];
      changes.push({
        kind: "write",
        content: input.content ?? "",
      });
      fileChanges.set(input.file_path, changes);
    }
  }

  if (fileChanges.size === 0) return undefined;

  const parts: string[] = [];

  for (const [filePath, changes] of fileChanges) {
    // If the last operation is a full write, treat as new/overwrite
    const lastWrite = findLastWrite(changes);
    if (lastWrite !== undefined) {
      parts.push(formatWriteDiff(filePath, changes[lastWrite].content ?? ""));
      continue;
    }

    // Merge all edits for this file into a single diff entry with multiple hunks
    const edits = changes.filter(
      (c): c is FileChange & { readonly kind: "edit" } => c.kind === "edit",
    );
    if (edits.length > 0) {
      parts.push(formatMergedEditDiff(filePath, edits));
    }
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function findLastWrite(changes: FileChange[]): number | undefined {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].kind === "write") return i;
  }
  return undefined;
}

function formatWriteDiff(filePath: string, content: string): string {
  const lines = content.split("\n");
  const added = lines.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    added,
  ].join("\n");
}

/**
 * Merge multiple Edit operations on the same file into a single diff entry.
 *
 * Each edit becomes a separate hunk (`@@ ... @@`) under one `diff --git` header,
 * so the file only appears once in the diff viewer sidebar.
 */
function formatMergedEditDiff(
  filePath: string,
  edits: readonly FileChange[],
): string {
  const hunks: string[] = [];

  for (const edit of edits) {
    const oldStr = edit.oldString ?? "";
    const newStr = edit.newString ?? "";
    const oldLines = oldStr.split("\n");
    const newLines = newStr.split("\n");

    const removed = oldLines.map((l) => `-${l}`);
    const added = newLines.map((l) => `+${l}`);

    if (oldStr === "") {
      // Pure insertion
      hunks.push(
        [`@@ -1,0 +1,${newLines.length} @@`, ...added].join("\n"),
      );
    } else if (newStr === "") {
      // Pure deletion
      hunks.push(
        [`@@ -1,${oldLines.length} +1,0 @@`, ...removed].join("\n"),
      );
    } else {
      // Standard replacement
      hunks.push(
        [
          `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
          ...removed,
          ...added,
        ].join("\n"),
      );
    }
  }

  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    ...hunks,
  ].join("\n");
}
