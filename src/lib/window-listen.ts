import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Window-scoped event listener. Only receives events sent to *this* window
 * via `app.emit_to(window_label, event, payload)` on the Rust side.
 *
 * This replaces the global `listen()` from `@tauri-apps/api/event` which
 * receives events from ALL windows — a problem in multi-window setups
 * where e.g. window B's chat-done event would leak into window A.
 */
export function windowListen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<T>(event, handler);
}
