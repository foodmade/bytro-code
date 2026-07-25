import { useEffect, useRef } from "react";
import { useChatStore, useConversationStore } from "@/stores";
import { useStreamStateStore } from "@/stores/stream-state-store";
import { useSlideshowStore } from "@/stores/slideshow-store";
import { extractSlideshowJson } from "@/lib/slideshow-parser";

// ---------------------------------------------------------------------------
// useSlideshowDetector — watches the latest assistant message for
// ```slideshow code blocks and feeds parsed data to the slideshow store.
// Call once in ChatPanel.
// ---------------------------------------------------------------------------

export function useSlideshowDetector(): void {
  const messages = useChatStore((s) => s.messages);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);

  // Use direct store access for streaming state to avoid stale closures
  const prevRawRef = useRef<string>("");
  const autoOpenedForRef = useRef<string | null>(null);

  useEffect(() => {
    // Find the latest assistant message (roles: claude, gemini, codex, chatcmpl)
    const lastAssistant = [...messages].reverse().find((m) => m.role !== "user" && m.role !== "system");
    if (!lastAssistant) return;

    const content = lastAssistant.content;
    if (typeof content !== "string" || !content) return;

    // Quick check before full extraction
    if (!content.includes("```slideshow")) return;

    const { found } = extractSlideshowJson(content);
    if (!found) return;

    // Read streaming state directly to avoid dependency issues
    const isStreaming = useStreamStateStore.getState().isStreaming;

    // Feed content to store (it handles extraction + parsing internally)
    useSlideshowStore.getState().updateFromContent(content, isStreaming);

    // Auto-open panel on first detection for this message
    if (autoOpenedForRef.current !== lastAssistant.id && activeConversationId) {
      autoOpenedForRef.current = lastAssistant.id;
      // Always open — even if panel was manually closed then content updated
      useSlideshowStore.getState().openPanel(activeConversationId, lastAssistant.id);
    }
  }, [messages, activeConversationId]);

  // Reset auto-open tracking when conversation changes
  useEffect(() => {
    autoOpenedForRef.current = null;
    prevRawRef.current = "";
  }, [activeConversationId]);
}
