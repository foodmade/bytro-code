import type { CompactingState } from "@/stores/agent-status-store";

export function shouldShowCompactingForConversation(
  compacting: CompactingState | null,
  conversationId?: string | null,
): boolean {
  return compacting?.active === true
    && (!compacting.conversationId || compacting.conversationId === conversationId);
}
