import { useCallback, useMemo, useState } from "react";
import { Rocket, X } from "lucide-react";
import { useAppStore, useConversationStore, useIdeaStore, useSettingsStore, useWorkspaceStore } from "@/stores";
import type { Idea } from "@/stores";

interface SummaryData {
  readonly problem: string;
  readonly approach: string;
  readonly keyPoints: ReadonlyArray<string>;
  readonly complexity: string;
}

export function SendToAiModal({
  idea,
  onClose,
  onBack,
}: {
  readonly idea: Idea;
  readonly onClose: () => void;
  readonly onBack: () => void;
}) {
  const activePlatformId = useSettingsStore((s) => s.activePlatformId);
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace);
  const createConversation = useConversationStore((s) => s.createConversation);
  const linkConversation = useIdeaStore((s) => s.linkConversation);
  const updateIdeaStatus = useIdeaStore((s) => s.updateIdeaStatus);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingQuickAction = useAppStore((s) => s.setPendingQuickAction);

  const [includeHistory, setIncludeHistory] = useState(true);
  const [usePlanMode, setUsePlanMode] = useState(true);
  const [isSending, setIsSending] = useState(false);

  const summary: SummaryData | null = useMemo(() => {
    if (!idea.summary_json) return null;
    try {
      return JSON.parse(idea.summary_json) as SummaryData;
    } catch {
      return null;
    }
  }, [idea.summary_json]);

  const handleSend = useCallback(async () => {
    if (isSending) return;
    setIsSending(true);

    try {
      // 1. Create new conversation for implementation
      const conv = await createConversation(
        "claude",
        idea.workspace_id ?? undefined,
      );

      // 2. Link to idea
      await linkConversation(idea.id, conv.id);

      // 3. Update status to building
      await updateIdeaStatus(idea.id, "building");

      // 4. Build the prompt from summary
      let prompt = `Please implement the following idea:\n\n`;
      prompt += `## ${idea.title}\n\n`;

      if (summary) {
        prompt += `### Problem\n${summary.problem}\n\n`;
        prompt += `### Approach\n${summary.approach}\n\n`;
        if (summary.keyPoints.length > 0) {
          prompt += `### Key Points\n${summary.keyPoints.map((p) => `- ${p}`).join("\n")}\n\n`;
        }
      } else {
        prompt += idea.raw_input + "\n\n";
      }

      if (usePlanMode) {
        prompt += `Please start by creating a detailed implementation plan before writing any code.\n`;
      }

      // 5. Switch to chat view and send the message
      setPendingQuickAction(prompt);
      setActiveView("chat");
      onClose();
      onBack();
    } catch {
      setIsSending(false);
    }
  }, [
    isSending, createConversation, idea, linkConversation,
    updateIdeaStatus, summary, usePlanMode, setPendingQuickAction,
    setActiveView, onClose, onBack,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxHeight: "80vh",
          borderRadius: 12,
          backgroundColor: "var(--color-card)",
          border: "1px solid var(--color-border-light)",
          boxShadow: "0 24px 48px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-2">
            <Rocket size={16} style={{ color: "#10B981" }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-foreground)" }}>
              Send to AI for Implementation
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--color-muted)",
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col flex-1 overflow-y-auto" style={{ padding: 20, gap: 16 }}>
          {/* Idea preview */}
          <div
            style={{
              padding: 14,
              borderRadius: 8,
              backgroundColor: "var(--color-surface-raised)",
              border: "1px solid var(--color-border)",
            }}
          >
            <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--color-foreground)", margin: "0 0 8px" }}>
              {idea.title}
            </h3>
            {summary ? (
              <div className="flex flex-col" style={{ gap: 6 }}>
                <div>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#A855F7" }}>Problem</span>
                  <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", margin: "2px 0 0", lineHeight: 1.5 }}>
                    {summary.problem}
                  </p>
                </div>
                <div>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#A855F7" }}>Approach</span>
                  <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", margin: "2px 0 0", lineHeight: 1.5 }}>
                    {summary.approach}
                  </p>
                </div>
                {summary.keyPoints.length > 0 && (
                  <div>
                    <span style={{ fontSize: 10, fontWeight: 600, color: "#A855F7" }}>Key Points</span>
                    <ul style={{ margin: "2px 0 0", paddingLeft: 14 }}>
                      {summary.keyPoints.map((p, i) => (
                        <li key={i} style={{ fontSize: 11, color: "var(--color-text-tertiary)", lineHeight: 1.5 }}>
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 11, color: "var(--color-text-tertiary)", margin: 0, lineHeight: 1.5 }}>
                {idea.raw_input.slice(0, 200)}
              </p>
            )}
          </div>

          {/* Options */}
          <div className="flex flex-col" style={{ gap: 10 }}>
            {/* Model */}
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>Model</span>
              <span
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  borderRadius: 6,
                  backgroundColor: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-foreground)",
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {activePlatformId}
              </span>
            </div>

            {/* Workspace */}
            <div className="flex items-center justify-between">
              <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>Workspace</span>
              <span
                style={{
                  fontSize: 11,
                  padding: "3px 10px",
                  borderRadius: 6,
                  backgroundColor: "var(--color-surface-raised)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-foreground)",
                }}
              >
                {activeWorkspace?.name ?? "Default"}
              </span>
            </div>

            {/* Checkboxes */}
            <label
              className="flex items-center cursor-pointer"
              style={{ gap: 8, padding: "4px 0" }}
            >
              <input
                type="checkbox"
                checked={includeHistory}
                onChange={(e) => setIncludeHistory(e.target.checked)}
                style={{ accentColor: "#A855F7" }}
              />
              <span style={{ fontSize: 12, color: "var(--color-foreground)" }}>
                Include full discussion history as context
              </span>
            </label>

            <label
              className="flex items-center cursor-pointer"
              style={{ gap: 8, padding: "4px 0" }}
            >
              <input
                type="checkbox"
                checked={usePlanMode}
                onChange={(e) => setUsePlanMode(e.target.checked)}
                style={{ accentColor: "#A855F7" }}
              />
              <span style={{ fontSize: 12, color: "var(--color-foreground)" }}>
                Use Plan mode (create plan before writing)
              </span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end shrink-0"
          style={{
            padding: "12px 20px",
            gap: 8,
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "7px 16px",
              borderRadius: 6,
              border: "1px solid var(--color-border-light)",
              backgroundColor: "transparent",
              color: "var(--color-text-tertiary)",
              fontSize: 12,
              cursor: "pointer",
              transition: "background-color 0.15s ease",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={isSending}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 20px",
              borderRadius: 6,
              border: "none",
              background: isSending
                ? "var(--color-border-light)"
                : "linear-gradient(135deg, #10B981 0%, #059669 100%)",
              color: "#FFFFFF",
              fontSize: 12,
              fontWeight: 600,
              cursor: isSending ? "wait" : "pointer",
              transition: "opacity 0.15s ease",
            }}
          >
            <Rocket size={14} />
            {isSending ? "Sending..." : "Send & Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
