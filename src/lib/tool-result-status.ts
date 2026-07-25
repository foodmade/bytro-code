import type { ToolCall, ToolDisplayMeta } from "@/stores/chat-types";

export function resolveToolCallFinalStatus(
  display: ToolDisplayMeta | undefined,
  success: boolean,
): ToolCall["status"] {
  if (display?.status) return display.status;
  return success ? "success" : "error";
}
