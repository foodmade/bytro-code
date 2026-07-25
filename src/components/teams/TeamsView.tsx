import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTeamsStore, useAppStore } from "@/stores";
import { useTeamsChat } from "@/hooks";
import {
  ArrowLeft, StopCircle, CheckCircle, AlertCircle,
  Loader2, Wifi, WifiOff, Users, MessageSquare,
} from "lucide-react";
import { SharedTaskPanel } from "./SharedTaskPanel";
import { AgentDetailPanel } from "./AgentDetailPanel";
import { FloatingBubble } from "./FloatingBubble";
import { FlowCanvas } from "./flow";

// ---------------------------------------------------------------------------
// Stream alive indicator
// ---------------------------------------------------------------------------

function useStreamAlive(thresholdMs = 15_000): boolean {
  const lastActivity = useTeamsStore((s) => s.session?.lastActivityAt ?? 0);
  const phase = useTeamsStore((s) => s.session?.phase);
  const [alive, setAlive] = useState(true);

  useEffect(() => {
    if (phase === "error") {
      setAlive(false);
      return;
    }
    if (phase === "ready" || phase === "done") {
      setAlive(true);
      return;
    }
    const check = () => {
      setAlive(Date.now() - lastActivity < thresholdMs);
    };
    check();
    const timer = setInterval(check, 3_000);
    return () => clearInterval(timer);
  }, [lastActivity, phase, thresholdMs]);

  return alive;
}

// ---------------------------------------------------------------------------
// TeamsView — main orchestrating component
// ---------------------------------------------------------------------------

export function TeamsView() {
  const session = useTeamsStore((s) => s.session);
  const selectedAgent = useTeamsStore((s) => s.selectedAgent);
  const selectAgent = useTeamsStore((s) => s.selectAgent);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const { sendTask, abortTeam } = useTeamsChat();
  const streamAlive = useStreamAlive();

  useEffect(() => {
    void invoke("watch_teams").catch(() => {});
  }, []);

  const handleBack = useCallback(() => {
    useTeamsStore.getState().clearSession();
    setActiveView("chat");
  }, [setActiveView]);

  const handleSendTask = useCallback((task: string, images?: ReadonlyArray<{ media_type: string; data: string }>) => {
    sendTask(task, images);
  }, [sendTask]);

  const handleCardClick = useCallback((agentName: string) => {
    selectAgent(selectedAgent === agentName ? null : agentName);
  }, [selectedAgent, selectAgent]);

  const handleCloseDetail = useCallback(() => {
    selectAgent(null);
  }, [selectAgent]);

  if (!session) {
    return (
      <div
        className="flex flex-col flex-1 items-center justify-center min-w-0 min-h-0"
        style={{ gap: 12 }}
      >
        <span style={{ fontSize: 14, color: "var(--color-text-muted)" }}>
          No active team session
        </span>
        <button
          onClick={handleBack}
          className="flex items-center transition-colors hover:bg-hover-overlay/[0.06]"
          style={{
            gap: 6, padding: "6px 12px", borderRadius: 6,
            border: "1px solid var(--color-border)", background: "none",
            color: "var(--color-text-muted)", fontSize: 12,
          }}
        >
          <ArrowLeft size={14} />
          <span>Back to Chat</span>
        </button>
      </div>
    );
  }

  const agentStates = Object.values(session.agentStates);
  const roleOrder: Record<string, number> = { orchestrator: 0, leader: 1 };
  const sortedAgents = [...agentStates].sort((a, b) => {
    const aOrder = roleOrder[a.role] ?? 2;
    const bOrder = roleOrder[b.role] ?? 2;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });

  const isInitializing = session.phase === "initializing";
  const isReady = session.phase === "ready";
  const isRunning = session.phase === "running";
  const isDone = session.phase === "done";
  const isError = session.phase === "error";
  const isActive = isReady || isRunning;

  const channelName = session.task
    ? `#${session.task.slice(0, 24).replace(/\s+/g, "-").toLowerCase()}`
    : "";

  return (
    <div className="flex flex-1 min-w-0 min-h-0" style={{ background: "#141414" }}>
      {/* Left Sidebar */}
      <div
        className="flex flex-col shrink-0"
        style={{
          width: 260, background: "#111118",
          borderRight: "1px solid #1E1E2E", overflow: "hidden",
        }}
      >
        {/* Sidebar Header */}
        <div
          className="flex flex-col shrink-0"
          style={{ padding: "16px 20px", gap: 12, borderBottom: "1px solid #1E1E2E" }}
        >
          <div className="flex items-center" style={{ gap: 8 }}>
            <Users size={16} style={{ color: "#A855F7" }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "#E0E0E0" }}>
              Dev Team
            </span>
            {isActive && (
              <div
                className="flex items-center"
                style={{ gap: 4, padding: "2px 8px", borderRadius: 10, background: "#10B98120" }}
              >
                <div style={{ width: 6, height: 6, borderRadius: 3, background: "#10B981", boxShadow: "0 0 6px #10B98160" }} />
                <span style={{ fontSize: 9, fontWeight: 500, color: "#10B981", fontFamily: "'JetBrains Mono', monospace" }}>
                  Active
                </span>
              </div>
            )}
          </div>
          <span style={{ fontSize: 11, color: "#555555" }}>
            Develop & review code collaboratively
          </span>
        </div>

        {/* Shared Task Panel */}
        <SharedTaskPanel agents={sortedAgents} />
      </div>

      {/* Main Area (canvas + optional detail panel) */}
      <div className="flex flex-1 min-w-0" style={{ overflow: "hidden" }}>
        {/* Canvas column */}
        <div className="flex flex-col flex-1 min-w-0" style={{ overflow: "hidden" }}>
          {/* Header */}
          <div
            className="flex items-center justify-between shrink-0"
            style={{ height: 48, padding: "0 20px", borderBottom: "1px solid #1E1E1E" }}
          >
            {/* Left */}
            <div className="flex items-center" style={{ gap: 10 }}>
              <button
                onClick={handleBack}
                className="flex items-center justify-center transition-colors hover:bg-hover-overlay/[0.06]"
                style={{ width: 28, height: 28, borderRadius: 6, background: "none", border: "none" }}
              >
                <ArrowLeft size={16} style={{ color: "#777777" }} />
              </button>
              <MessageSquare size={14} style={{ color: "#777777" }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#CCCCCC" }}>
                Team Chat
              </span>
              {channelName && (
                <>
                  <span style={{ fontSize: 13, color: "#333333" }}>/</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "#A855F7", fontFamily: "'JetBrains Mono', monospace" }}>
                    {channelName}
                  </span>
                </>
              )}
            </div>

            {/* Right */}
            <div className="flex items-center" style={{ gap: 12 }}>
              {!isDone && !isError && (
                <div
                  className="flex items-center"
                  style={{ gap: 3 }}
                  title={streamAlive ? "Stream connected" : "Stream may be disconnected"}
                >
                  {streamAlive
                    ? <Wifi size={11} style={{ color: "#10B981" }} />
                    : <WifiOff size={11} style={{ color: "#EF4444" }} />}
                  <span
                    style={{
                      width: 5, height: 5, borderRadius: 3,
                      background: streamAlive ? "#10B981" : "#EF4444",
                      boxShadow: streamAlive ? "0 0 6px #10B98160" : "none",
                    }}
                  />
                </div>
              )}

              {(isInitializing || isRunning) && (
                <>
                  <div className="flex items-center" style={{ gap: 4 }}>
                    <Loader2 size={11} className="animate-spin" style={{ color: "#A855F7" }} />
                    <span style={{ fontSize: 10, padding: "3px 8px", borderRadius: 10, background: "rgba(var(--theme-accent-rgb),0.125)", color: "#A855F7", fontWeight: 600 }}>
                      {isInitializing ? "Initializing" : "Running"}
                    </span>
                  </div>
                  <button
                    onClick={abortTeam}
                    className="flex items-center transition-colors"
                    style={{
                      gap: 4, padding: "4px 12px", borderRadius: 6,
                      background: "#EF444420", color: "#EF4444",
                      fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer",
                    }}
                  >
                    <StopCircle size={12} />
                    <span>Stop</span>
                  </button>
                </>
              )}
              {isError && (
                <div className="flex items-center" style={{ gap: 4, color: "#EF4444", fontSize: 11 }}>
                  <AlertCircle size={12} />
                  <span>Error</span>
                </div>
              )}
              {isDone && (
                <div className="flex items-center" style={{ gap: 4, color: "#6B7280", fontSize: 11 }}>
                  <CheckCircle size={12} />
                  <span>Idle</span>
                </div>
              )}
            </div>
          </div>

          {/* React Flow Canvas */}
          <FlowCanvas
            agents={sortedAgents}
            selectedAgent={selectedAgent}
            onCardClick={handleCardClick}
            isActive={isActive}
          >
            {/* Viewport-fixed overlays — not affected by canvas pan/zoom */}

            {/* Initializing hint */}
            {isInitializing && (
              <div
                className="flex flex-col items-center"
                style={{
                  position: "absolute", top: "50%", left: "50%",
                  transform: "translate(-50%, -50%)", textAlign: "center", gap: 8, zIndex: 5,
                }}
              >
                <Loader2 size={24} className="animate-spin" style={{ color: "#A855F7" }} />
                <span style={{ fontSize: 12, color: "#777777" }}>
                  Setting up team agents ({sortedAgents.filter((a) => a.status !== "idle").length}/{sortedAgents.length})...
                </span>
              </div>
            )}

            {/* Error overlay */}
            {session.error && (
              <div
                style={{
                  position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
                  width: "min(80%, 400px)", padding: "12px 16px", borderRadius: 8,
                  border: "1px solid #EF444440", background: "#EF444410",
                  fontSize: 12, color: "#EF4444", zIndex: 10,
                }}
              >
                {session.error}
              </div>
            )}

            {/* Floating input */}
            {(isReady || isRunning || isDone) && (
              <FloatingBubble
                onSend={handleSendTask}
                agentNames={sortedAgents.map((a) => a.name)}
                placeholder="Message your team..."
              />
            )}
          </FlowCanvas>
        </div>

        {/* Agent Detail Panel — slide in from right */}
        {selectedAgent && (
          <AgentDetailPanel
            agentName={selectedAgent}
            onClose={handleCloseDetail}
          />
        )}
      </div>
    </div>
  );
}
