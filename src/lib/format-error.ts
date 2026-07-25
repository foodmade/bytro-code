/** Extract a human-readable message from an unknown error value. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Max length of error messages shown in toast notifications. */
export const ERROR_MESSAGE_MAX_LEN = 320;

/**
 * Truncate a pre-resolved error message for display in toast notifications.
 * Pair with `formatError()` when converting an unknown error value first.
 */
export function truncateError(message: string, maxLen: number = ERROR_MESSAGE_MAX_LEN): string {
  return message.length > maxLen ? `${message.slice(0, maxLen)}...` : message;
}
