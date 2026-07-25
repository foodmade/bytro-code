import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";
import { useLiveReviewStore } from "@/stores/live-review-store";
import { useConversationStore } from "@/stores/conversation-store";
import { cancelAllLiveReviews } from "@/lib/live-review-service";
import { Tooltip } from "@/components/ui";

/**
 * Toolbar entry point for the Live Reviewer.  Compact icon-only button so it
 * doesn't crowd the chat header — full description shows on hover via tooltip.
 * Active state is conveyed by icon color and a subtle accent ring.
 *
 * Brand-new conversation handling:
 *   When the user opens "New chat" but hasn't sent the first message yet,
 *   `activeConversationId` is `null` — toggling Live writes a sticky
 *   `pendingEnable` flag instead of a per-conversation entry.  The effect
 *   below watches for the id to flip from `null` → real value (the first
 *   `createConversation` resolution) and migrates the pending flag onto it.
 */
export function LiveReviewEntryButton(_props: { readonly compact?: boolean } = {}) {
  const { t } = useTranslation();
  const conversationId = useConversationStore((s) => s.activeConversationId);
  const enabled = useLiveReviewStore((s) =>
    conversationId ? s.enabledByConversation[conversationId] === true : s.pendingEnable,
  );
  const setEnabledFor = useLiveReviewStore((s) => s.setEnabledFor);
  const bindPendingToConversation = useLiveReviewStore((s) => s.bindPendingToConversation);

  useEffect(() => {
    if (conversationId) {
      bindPendingToConversation(conversationId);
    }
  }, [conversationId, bindPendingToConversation]);

  const handleToggle = useCallback(() => {
    const next = !enabled;
    // When disabling an active conversation, also clear its pending file
    // buffer and abort any in-flight review streams.  Without this, toggling
    // off → on would resurrect stale buffered changes the user already
    // walked past, and in-flight streams would keep burning tokens silently.
    // Run cancel BEFORE flipping the store so a fast off→on→edit sequence
    // can't have cancel arrive late and wipe buffer entries that already
    // belong to the next active phase.
    if (!next && conversationId) {
      cancelAllLiveReviews(conversationId);
    }
    setEnabledFor(conversationId, next);
  }, [conversationId, enabled, setEnabledFor]);

  const hoverBg = enabled ? "rgba(34, 197, 94, 0.12)" : "rgba(var(--hover-overlay-rgb), 0.10)";

  const tooltipText = enabled
    ? `${t("chat.codeReview.liveReview.title")} — ${t("chat.codeReview.liveReview.tooltipDisable")}`
    : `${t("chat.codeReview.liveReview.title")} — ${t("chat.codeReview.liveReview.tooltipEnable")}`;

  return (
    <Tooltip content={tooltipText}>
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center justify-center cursor-pointer native-css-hover"
        aria-label={t("chat.codeReview.liveReview.title")}
        aria-pressed={enabled}
        style={
          {
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: "transparent",
            border: "none",
            color: enabled ? "var(--color-accent-success)" : "var(--color-muted-foreground)",
            "--native-hover-bg-color": hoverBg,
          } as React.CSSProperties
        }
      >
        <Radio size={14} />
      </button>
    </Tooltip>
  );
}
