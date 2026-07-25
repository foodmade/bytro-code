import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Loader } from "lucide-react";
import { useAgentStatusStore } from "@/stores";
import { shouldShowCompactingForConversation } from "./agent-status-utils";

export interface AgentStatus {
  readonly name: string;
  readonly color: string;
  readonly status: string;
  readonly opacity?: number;
}

interface AgentStatusBarProps {
  readonly conversationId?: string | null;
}

// ---------------------------------------------------------------------------
// AgentStatusBar (Pencil node C3kfP)
// ---------------------------------------------------------------------------

/**
 * Agent status bar.
 *
 * Shows compacting indicator and agent status dots.
 */
export const AgentStatusBar = memo(function AgentStatusBar({ conversationId }: AgentStatusBarProps) {
  const { t } = useTranslation();
  const compacting = useAgentStatusStore((s) => s.compacting);

  const isCompacting = shouldShowCompactingForConversation(compacting, conversationId);

  if (isCompacting) {
    return (
      <div
        className="flex items-center status-bar-enter"
        style={{
          gap: 8,
          padding: "0 0 4px 0",
          width: "100%",
          height: 18,
        }}
      >
        <div className="flex items-center" style={{ gap: 5 }}>
          <Loader size={11} color="#F97316" strokeWidth={2} className="animate-spin" style={{ flexShrink: 0 }} />
          <span
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 11,
              fontWeight: 500,
              color: "#F97316",
              lineHeight: 1,
            }}
          >
            {t("chat.compacting")}
          </span>
        </div>
      </div>
    );
  }

  return null;
});
