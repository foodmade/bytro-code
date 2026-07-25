import type { ChatMessage, ToolCall } from "@/stores/chat-store";

export type FileConfirmationKind = "created" | "edited" | "deleted";

export interface FileConfirmationPreview {
  readonly kind: FileConfirmationKind;
  readonly filePath: string;
  readonly fileName: string;
  readonly extension: string;
  readonly added: number;
  readonly removed: number;
  readonly oldText: string;
  readonly newText: string;
}

const WRITE_TOOL_NAMES = new Set(["Write", "write_file", "create_file"]);
const EDIT_TOOL_NAMES = new Set(["Edit", "replace"]);
const DELETE_TOOL_NAMES = new Set(["Delete", "delete_file", "remove_file"]);

// Returns the newest pending confirmation so rows and status indicators can
// stay in sync without importing the full confirmation dialog.
export function findPendingConfirmation(
  messages: ReadonlyArray<ChatMessage>,
): ToolCall | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.toolCalls) continue;
    const pending = msg.toolCalls.find(
      (tc) => tc.status === "pending_confirmation" && tc.confirmId,
    );
    if (pending) return pending as ToolCall;
  }
  return null;
}

function parseToolInputObject(toolInput: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(toolInput) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = asString(input[key]);
    if (value) return value;
  }
  return "";
}

export function getDisplayFileName(filePath: string): string {
  if (!filePath) return "";
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function getFileExtension(filePath: string): string {
  const fileName = getDisplayFileName(filePath);
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function countTextLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
}

function makeFilePreview(
  kind: FileConfirmationKind,
  filePath: string,
  oldText: string,
  newText: string,
): FileConfirmationPreview | null {
  if (!filePath) return null;
  return {
    kind,
    filePath,
    fileName: getDisplayFileName(filePath),
    extension: getFileExtension(filePath),
    added: countTextLines(newText),
    removed: countTextLines(oldText),
    oldText,
    newText,
  };
}

export function getFileConfirmationPreview(
  toolName: string,
  toolInput: string,
): FileConfirmationPreview | null {
  const input = parseToolInputObject(toolInput);
  if (!input) return null;

  const filePath = pickString(input, ["file_path", "path"]);

  if (WRITE_TOOL_NAMES.has(toolName)) {
    return makeFilePreview(
      "created",
      filePath,
      "",
      asString(input.content),
    );
  }

  if (EDIT_TOOL_NAMES.has(toolName)) {
    return makeFilePreview(
      "edited",
      filePath,
      pickString(input, ["old_string", "old_str", "oldText", "old_text"]),
      pickString(input, ["new_string", "new_str", "newText", "new_text", "replacement"]),
    );
  }

  if (DELETE_TOOL_NAMES.has(toolName)) {
    return makeFilePreview("deleted", filePath, "", "");
  }

  return null;
}
