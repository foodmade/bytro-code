import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { AgentRole } from "@/types";
import { resolveAgentConfig } from "./message-config";
import { useStreamStateStore } from "@/stores/stream-state-store";
import type { StreamPhase } from "@/stores/stream-state-store";

interface AgentLoadingProps {
  readonly role: AgentRole;
  readonly modelTag?: string;
  readonly retryAttempt?: number | null;
  readonly retryMaxAttempts?: number | null;
  readonly streamElapsed?: number;
  readonly streamPhase?: StreamPhase;
}

/** Default model tags shown when no explicit modelTag is provided. */
const DEFAULT_MODEL_TAGS: Partial<Record<AgentRole, string>> = {
  claude: "opus-4",
  codex: "codex-mini",
  gemini: "2.5-flash",
  chatcmpl: "assistant",
};

/** i18n keys for each cold-start phase */
const PHASE_I18N: Record<Exclude<StreamPhase, null>, string> = {
  connecting: "chat.agentLoading.connecting",
  waiting: "chat.agentLoading.waiting",
  thinking: "chat.agentLoading.thinking",
};

/** Main AgentLoading dispatcher */
export function AgentLoading({
  role,
  modelTag,
  retryAttempt: retryAttemptProp = null,
  retryMaxAttempts: retryMaxAttemptsProp = null,
  streamElapsed: streamElapsedProp,
  streamPhase: streamPhaseProp = null,
}: AgentLoadingProps) {
  const { t } = useTranslation();
  const config = resolveAgentConfig(role, modelTag);
  const retryAttemptState = useStreamStateStore((s) => s.retryAttempt);
  const retryMaxAttemptsState = useStreamStateStore((s) => s.retryMaxAttempts);
  const streamPhaseState = useStreamStateStore((s) => s.streamPhase);
  const streamElapsedState = useStreamStateStore((s) => s.streamElapsed);
  const retryAttempt = retryAttemptProp ?? retryAttemptState;
  const retryMaxAttempts = retryMaxAttemptsProp ?? retryMaxAttemptsState;
  const streamPhase = streamPhaseProp ?? streamPhaseState;
  const streamElapsed = streamElapsedProp ?? streamElapsedState;

  const dotColor = config.brandColor || "var(--color-accent-purple)";
  const isRetrying = retryAttempt !== null && retryMaxAttempts !== null;
  const phaseText = streamPhase ? t(PHASE_I18N[streamPhase]) : null;
  const showElapsed = streamPhase === "waiting" && streamElapsed >= 3000;
  const elapsedSec = Math.floor(streamElapsed / 1000);

  return (
    <div className="flex gap-3 animate-slide-in-bottom">
      {/* Avatar */}
      <div
        className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 text-[13px] font-bold font-sans overflow-hidden"
        style={{ backgroundColor: config.avatarBg, color: config.avatarTextColor }}
      >
        {config.iconUrl ? (
          <img src={config.iconUrl} alt={config.label} className="w-full h-full object-cover" />
        ) : (
          config.avatar
        )}
      </div>

      {/* Dark bubble */}
      <div
        className="flex flex-col max-w-[760px]"
        style={{
          backgroundColor: "var(--color-card)",
          borderRadius: "4px 16px 16px 16px",
          padding: "12px 16px",
        }}
      >
        <div className="flex flex-col gap-2">
          {/* Header */}
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold font-sans" style={{ color: config.nameColor }}>
              {config.label}
            </span>
            <span className="text-[10px] font-mono" style={{ color: config.modelColor }}>
              {modelTag || DEFAULT_MODEL_TAGS[role] || ""}
            </span>
          </div>

          {/* Breathing wave dots + optional retry indicator */}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full animate-dot-pulse"
              style={{ backgroundColor: dotColor }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full animate-dot-pulse-delay-1"
              style={{ backgroundColor: dotColor }}
            />
            <span
              className="w-1.5 h-1.5 rounded-full animate-dot-pulse-delay-2"
              style={{ backgroundColor: dotColor }}
            />
            {isRetrying && (
              <>
                <RefreshCw
                  size={11}
                  className="shrink-0 animate-spin ml-1.5"
                  style={{ color: "var(--color-muted)", animationDuration: "1.5s" }}
                />
                <span
                  className="font-sans"
                  style={{ fontSize: 11, color: "var(--color-muted)" }}
                >
                  {t("chat.streamRetry.compact", { current: retryAttempt, total: retryMaxAttempts })}
                </span>
              </>
            )}
          </div>

          {/* Phase text with shimmer effect */}
          {phaseText && (
            <div className="flex items-center gap-1.5 agent-loading-phase-text">
              <span
                className="text-[11px] font-sans agent-loading-shimmer"
              >
                {phaseText}
              </span>
              {showElapsed && (
                <span
                  className="text-[11px] font-mono"
                  style={{ color: "var(--color-muted)" }}
                >
                  {elapsedSec}s
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
