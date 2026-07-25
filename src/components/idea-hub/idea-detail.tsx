import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, MessageCircle, Sparkles, Send } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useIdeaStore, useSettingsStore, useToastStore } from "@/stores";
import {
  buildActiveProfileProxyUrl,
  resolveActiveCredentials,
  getEffectiveSdk,
} from "@/lib/platform-config";
import { IdeaChatPanel, buildInitialUserMessage } from "./idea-chat-panel";
import { SummaryPanel } from "./summary-panel";
import { SendToAiModal } from "./send-to-ai-modal";

export function IdeaDetail({
  ideaId,
  onBack,
  autoStartDiscussion = false,
}: {
  readonly ideaId: string;
  readonly onBack: () => void;
  readonly autoStartDiscussion?: boolean;
}) {
  const getIdea = useIdeaStore((s) => s.getIdea);
  const activeIdea = useIdeaStore((s) => s.activeIdea);
  const updateIdeaStatus = useIdeaStore((s) => s.updateIdeaStatus);
  const updateIdeaSummary = useIdeaStore((s) => s.updateIdeaSummary);
  const [showSendModal, setShowSendModal] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const { t } = useTranslation();
  const reopenDiscussion = useIdeaStore((s) => s.reopenDiscussion);

  useEffect(() => {
    getIdea(ideaId);
  }, [ideaId, getIdea]);

  // Generate summary and move directly to ready (skip "marked" step)
  const handleGenerateSummary = useCallback(async () => {
    const freshIdea = await getIdea(ideaId);
    if (!freshIdea) return;

    const convId = freshIdea.discussion_conversation_id;
    if (!convId) {
      // No discussion yet, just mark as ready
      await updateIdeaStatus(ideaId, "ready");
      await getIdea(ideaId);
      return;
    }

    setIsGeneratingSummary(true);
    try {
      const settings = useSettingsStore.getState();
      const platformConfig = settings.platforms[settings.activePlatformId];
      const creds = resolveActiveCredentials(platformConfig);
      const sdk = getEffectiveSdk(platformConfig);
      const proxy =
        sdk === "claude"
          ? buildActiveProfileProxyUrl(platformConfig)
          : settings.proxyEnabled && settings.proxyUrl
            ? settings.proxyUrl
            : undefined;

      const summaryJson = await invoke<string>("generate_idea_summary", {
        sdk,
        model: creds?.model || undefined,
        conversationId: convId,
        ideaTitle: freshIdea.title,
        ideaRawInput: freshIdea.raw_input,
        baseUrl: creds?.baseUrl || undefined,
        apiKey: creds?.apiKey || undefined,
        proxyUrl: proxy,
      });

      await updateIdeaSummary(ideaId, summaryJson);
      await updateIdeaStatus(ideaId, "ready");
      await getIdea(ideaId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      useToastStore.getState().addToast("error", `Summary generation failed: ${errMsg}`);
      // Still move to ready even if summary generation fails
      await updateIdeaStatus(ideaId, "ready");
      await getIdea(ideaId);
    } finally {
      setIsGeneratingSummary(false);
    }
  }, [ideaId, updateIdeaStatus, updateIdeaSummary, getIdea]);

  const handleReopenDiscussion = useCallback(async () => {
    await reopenDiscussion(ideaId);
    await getIdea(ideaId);
  }, [ideaId, reopenDiscussion, getIdea]);

  if (!activeIdea) {
    return (
      <div
        className="flex items-center justify-center flex-1"
        style={{ color: "var(--color-muted)" }}
      >
        Loading idea...
      </div>
    );
  }

  // Show "Generate Summary" for discussing/marked status (backward compat: treat marked as discussing)
  const canGenerateSummary = activeIdea.status === "discussing" || activeIdea.status === "marked";
  // Show "Reopen Discussion" for ready status
  const canReopenDiscussion = activeIdea.status === "ready";
  // Show "Send to AI" button in footer area if ready/marked with summary
  const canSendToAi =
    (activeIdea.status === "ready" || activeIdea.status === "marked") && activeIdea.summary_json;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* TopBar */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          height: 48,
          padding: "0 24px",
          backgroundColor: "var(--color-background)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        {/* Left: back + divider + title */}
        <div className="flex items-center" style={{ gap: 12, height: "100%" }}>
          <button
            onClick={onBack}
            className="flex items-center"
            style={{
              gap: 4,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <ArrowLeft size={16} style={{ color: "var(--color-muted)" }} />
            <span
              style={{
                fontSize: 12,
                color: "var(--color-muted)",
                fontFamily: "Inter, sans-serif",
              }}
            >
              {t("ideaHub.back")}
            </span>
          </button>

          {/* Divider */}
          <div style={{ width: 1, height: 16, backgroundColor: "var(--color-border-light)" }} />

          {/* Idea title */}
          <span
            className="truncate"
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--color-foreground)",
              fontFamily: "Inter, sans-serif",
            }}
          >
            {activeIdea.title}
          </span>
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center" style={{ gap: 10, height: "100%" }}>
          {/* Generate Summary button — shown for discussing/marked */}
          {canGenerateSummary && (
            <button
              onClick={handleGenerateSummary}
              disabled={isGeneratingSummary}
              className="flex items-center native-css-hover"
              style={
                {
                  gap: 6,
                  padding: "0 14px",
                  height: 32,
                  borderRadius: 6,
                  border: "none",
                  background: "linear-gradient(135deg, #22C55E 0%, #16A34A 100%)",
                  color: "#0D0D0D",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: isGeneratingSummary ? "wait" : "pointer",
                  fontFamily: "Inter, sans-serif",
                  opacity: isGeneratingSummary ? 0.7 : 1,
                  "--native-hover-opacity": !isGeneratingSummary ? "0.9" : undefined,
                } as React.CSSProperties
              }
            >
              {isGeneratingSummary ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {isGeneratingSummary
                ? t("ideaHub.card.generatingSummary")
                : t("ideaHub.card.generateSummary")}
            </button>
          )}

          {/* Reopen Discussion — shown for ready */}
          {canReopenDiscussion && (
            <button
              onClick={handleReopenDiscussion}
              className="flex items-center native-css-hover"
              style={
                {
                  gap: 6,
                  padding: "0 14px",
                  height: 32,
                  borderRadius: 6,
                  border: "1px solid rgba(var(--theme-accent-rgb),0.251)",
                  backgroundColor: "rgba(var(--theme-accent-rgb),0.094)",
                  color: "#A855F7",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: "Inter, sans-serif",
                  transition: "background-color 0.15s ease",
                  "--native-hover-bg-color": "rgba(var(--theme-accent-rgb),0.145)",
                } as React.CSSProperties
              }
            >
              <MessageCircle size={14} />
              {t("ideaHub.card.reopenDiscussion")}
            </button>
          )}

          {/* Send to AI — shown when ready with summary */}
          {canSendToAi && (
            <button
              onClick={() => setShowSendModal(true)}
              className="flex items-center native-css-hover"
              style={
                {
                  gap: 6,
                  padding: "0 14px",
                  height: 32,
                  borderRadius: 6,
                  border: "none",
                  background: "linear-gradient(180deg, #22C55E 0%, #16A34A 100%)",
                  color: "#0D0D0D",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "Inter, sans-serif",
                  transition: "opacity 0.15s ease",
                  "--native-hover-opacity": "0.9",
                } as React.CSSProperties
              }
            >
              <Send size={14} />
              {t("ideaHub.card.sendToAi")}
            </button>
          )}
        </div>
      </div>

      {/* Content: Discussion (left, fill) + Summary (right, 400px) */}
      <div className="flex flex-1 min-h-0">
        <IdeaChatPanel
          idea={activeIdea}
          autoSendPrompt={autoStartDiscussion ? buildInitialUserMessage(activeIdea) : undefined}
        />

        <SummaryPanel idea={activeIdea} onSendToAi={() => setShowSendModal(true)} />
      </div>

      {/* Send to AI Modal */}
      {showSendModal && (
        <SendToAiModal idea={activeIdea} onClose={() => setShowSendModal(false)} onBack={onBack} />
      )}
    </div>
  );
}
