/**
 * Parse helpers for @ mention triggers and / slash command triggers
 * in the chat input textarea.
 */

/** Find the active @ trigger position and query from cursor position */
export function parseMentionTrigger(
  text: string,
  cursorPos: number,
): { atIndex: number; query: string } | null {
  // Walk backwards from cursor to find the nearest @
  const beforeCursor = text.slice(0, cursorPos);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return null;

  // @ can appear anywhere — no whitespace-before requirement

  const query = beforeCursor.slice(atIndex + 1);

  // Trim trailing non-breaking spaces (\u00A0) that contentEditable may insert
  // after the user's typed text. Without this, a phantom NBSP at the end would
  // bypass the space check and reach the file search, causing "no match".
  const trimmed = query.replace(/\u00A0+$/, "");

  // If query contains a space (or internal NBSP), the mention is "closed"
  if (trimmed.includes(" ") || trimmed.includes("\u00A0")) return null;

  return { atIndex, query: trimmed };
}

/** Find the active / trigger position and query from cursor position */
export function parseSlashTrigger(
  text: string,
  cursorPos: number,
): { slashIndex: number; query: string } | null {
  const beforeCursor = text.slice(0, cursorPos);
  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex === -1) return null;

  // / must be at start of text or preceded by whitespace/newline
  if (slashIndex > 0) {
    const charBefore = text[slashIndex - 1];
    if (charBefore !== " " && charBefore !== "\n" && charBefore !== "\t") return null;
  }

  const query = beforeCursor.slice(slashIndex + 1);

  // Trim trailing non-breaking spaces (\u00A0) from contentEditable
  const trimmed = query.replace(/\u00A0+$/, "");

  // If query contains a space (or internal NBSP), the slash trigger is "closed"
  if (trimmed.includes(" ") || trimmed.includes("\u00A0")) return null;

  return { slashIndex, query: trimmed };
}

/** Image MIME types supported for paste/attach */
export const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
]);
