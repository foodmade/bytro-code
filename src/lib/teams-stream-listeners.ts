/**
 * Teams event listeners — handles Tauri events from the teams sidecar handler.
 *
 * Follows the same pattern as chat-stream-listeners.ts but routes events
 * to the teams store instead of the chat store.
 */
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { windowListen } from "@/lib/window-listen";
import { formatChatError } from "@/lib/stream-handlers/system-handlers";
import { useTeamsStore } from "@/stores/teams-store";
import { useAppStore } from "@/stores/app-store";

// ---------------------------------------------------------------------------
// Event payload types (match Rust frontend event structs)
// ---------------------------------------------------------------------------

interface ToolDisplayMetaPayload {
  readonly status: "success" | "warning" | "error";
  readonly severity: "info" | "warning" | "error";
  readonly reason?: string;
}

interface TeamsStartPayload {
  readonly request_id: string;
  readonly agent_count: number;
  readonly agents: ReadonlyArray<{ name: string; role: string }>;
}

interface TeamsAgentDeltaPayload {
  readonly request_id: string;
  readonly agent_name: string;
  readonly delta: string;
}

interface TeamsAgentToolStartPayload {
  readonly request_id: string;
  readonly agent_name: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly tool_input: string;
}

interface TeamsAgentToolResultPayload {
  readonly request_id: string;
  readonly agent_name: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly tool_input: string;
  readonly success: boolean;
  readonly result: string;
  readonly display?: ToolDisplayMetaPayload;
}

interface TeamsAgentStatusPayload {
  readonly request_id: string;
  readonly agent_name: string;
  readonly status: "spawned" | "active" | "idle" | "stopped" | "error";
  readonly message?: string;
}

interface TeamsAgentThinkingPayload {
  readonly request_id: string;
  readonly agent_name: string;
  readonly delta: string;
}

interface TeamsReadyPayload {
  readonly request_id: string;
  readonly agents: ReadonlyArray<{ name: string; role: string }>;
}

interface TeamsCompletePayload {
  readonly request_id: string;
  readonly summary: string;
}

interface TeamsErrorPayload {
  readonly request_id: string;
  readonly error: string;
  readonly error_status?: number;
}

interface TeamsStartupStatusPayload {
  readonly request_id: string;
  readonly status: string;
  readonly message?: string;
  readonly attempt?: number;
  readonly max_attempts?: number;
  readonly retry_delay_ms?: number;
  readonly error_status?: number;
}

interface StreamRetryPayload {
  readonly request_id: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly reason: string;
}

interface TeamsMessageRoutedPayload {
  readonly request_id: string;
  readonly target_agent: string;
  readonly content: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Helper: ensure dynamically-spawned agents are registered in the store
// ---------------------------------------------------------------------------

/**
 * Ensure an agent name exists in the session's agentStates.
 * If not, dynamically register it so status updates don't get dropped.
 */
function ensureAgentRegistered(agentName: string): void {
  const teamsStore = useTeamsStore.getState();
  const session = teamsStore.session;
  if (!session) return;
  if (!session.agentStates[agentName]) {
    teamsStore.registerDynamicAgent(agentName);
  }
}

// ---------------------------------------------------------------------------
// Helper: transition to "ready" — triggered by [TEAMS_READY] sentinel
// ---------------------------------------------------------------------------

/** Guard to prevent duplicate transitions. */
let transitionDone = false;

function doTransition(): void {
  const teamsStore = useTeamsStore.getState();
  const session = teamsStore.session;

  if (!session) {
    console.warn("[teams-transition] doTransition: no session — skipped");
    return;
  }
  if (session.phase !== "initializing") {
    console.warn(`[teams-transition] doTransition: phase="${session.phase}" — skipped`);
    return;
  }
  if (transitionDone) {
    console.warn("[teams-transition] doTransition: already done — skipped");
    return;
  }

  transitionDone = true;
  console.warn("[teams-transition] TRANSITIONING to ready + teams view");
  teamsStore.setSessionReady();
  teamsStore.closeLaunchPanel();
  useAppStore.getState().setActiveView("teams");
}

/** Reset transition state when a new session starts. */
function resetTransitionState(): void {
  transitionDone = false;
}

function isActionableRetry(reason: string): boolean {
  return /HTTP\s+\d{3}/.test(reason);
}

function failInitializingSession(error: string): void {
  const teamsStore = useTeamsStore.getState();
  const session = teamsStore.session;
  if (!session || session.phase !== "initializing") return;
  invoke("abort_chat", { requestId: session.requestId }).catch(() => {
    console.error("[teams-event] abort_chat failed for failed team launch");
  });
  teamsStore.setSessionError(error);
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/**
 * Register all teams-specific Tauri event listeners.
 * Returns unlisten functions for cleanup.
 */
export async function registerTeamsStreamListeners(): Promise<UnlistenFn[]> {
  const unsubs: UnlistenFn[] = [];

  // teams-start — sidecar has received the command and started processing
  unsubs.push(
    await windowListen<TeamsStartPayload>("teams-start", (event) => {
      console.warn(
        `[teams-transition] teams-start received: agentCount=${event.payload.agents.length}`,
      );
      // Reset transition state for this new session
      resetTransitionState();
      // Register all agents from the payload (including "main" orchestrator).
      // This is a belt-and-suspenders fix: createSession should already include
      // "main", but if the session was created before teams-start arrives, or
      // if new agents appear in the payload, this ensures they're registered.
      for (const agent of event.payload.agents) {
        ensureAgentRegistered(agent.name);
      }
      // Wait for teams-ready before switching views.
    }),
  );

  // teams-agent-delta
  unsubs.push(
    await windowListen<TeamsAgentDeltaPayload>("teams-agent-delta", (event) => {
      const { agent_name, delta } = event.payload;
      ensureAgentRegistered(agent_name);
      useTeamsStore.getState().appendAgentDelta(agent_name, delta);
    }),
  );

  // teams-agent-tool-start
  unsubs.push(
    await windowListen<TeamsAgentToolStartPayload>("teams-agent-tool-start", (event) => {
      const { agent_name, tool_call_id, tool_name, tool_input } = event.payload;
      ensureAgentRegistered(agent_name);
      const store = useTeamsStore.getState();
      store.addAgentToolStart(agent_name, tool_call_id, tool_name, tool_input);
      // Detect peer communication for dynamic edge display.
      // When an agent uses SendMessage or Task targeting another non-main agent,
      // record the peer connection so the flow canvas shows the link.
      if (tool_name === "SendMessage" || tool_name === "Task") {
        try {
          const input = JSON.parse(tool_input);
          const targetAgent = input.recipient ?? input.name ?? input.target_agent_id ?? "";
          if (targetAgent && agent_name !== "main" && targetAgent !== "main") {
            store.addPeerConnection(agent_name, targetAgent);
          }
        } catch {
          // ignore parse errors
        }
      }
    }),
  );

  // teams-agent-tool-result
  unsubs.push(
    await windowListen<TeamsAgentToolResultPayload>("teams-agent-tool-result", (event) => {
      const { agent_name, tool_call_id, success, result, display } = event.payload;
      ensureAgentRegistered(agent_name);
      useTeamsStore.getState().addAgentToolResult(agent_name, tool_call_id, success, result, display);
    }),
  );

  // teams-agent-status — updates individual agent states in the store
  unsubs.push(
    await windowListen<TeamsAgentStatusPayload>("teams-agent-status", (event) => {
      const { agent_name, status, message } = event.payload;
      console.warn(
        `[teams-event] agent-status: agent="${agent_name}" status="${status}"`,
      );
      ensureAgentRegistered(agent_name);
      useTeamsStore.getState().updateAgentStatus(agent_name, status, message);
    }),
  );

  // teams-agent-thinking
  unsubs.push(
    await windowListen<TeamsAgentThinkingPayload>("teams-agent-thinking", (event) => {
      const { agent_name, delta } = event.payload;
      ensureAgentRegistered(agent_name);
      useTeamsStore.getState().appendAgentThinking(agent_name, delta);
    }),
  );

  // teams-ready — [TEAMS_READY] sentinel detected: all agents are spawned
  unsubs.push(
    await windowListen<TeamsReadyPayload>("teams-ready", (event) => {
      console.warn(
        `[teams-transition] teams-ready received: agents=[${event.payload.agents.map((a) => a.name).join(",")}]`,
      );
      // Dynamically register any agents reported by the backend
      for (const agent of event.payload.agents) {
        ensureAgentRegistered(agent.name);
      }
      doTransition();
    }),
  );

  // teams-complete
  unsubs.push(
    await windowListen<TeamsCompletePayload>("teams-complete", (event) => {
      const { summary } = event.payload;
      console.warn(`[teams-event] teams-complete received`);
      useTeamsStore.getState().endSession(summary);
    }),
  );

  // teams-error
  unsubs.push(
    await windowListen<TeamsErrorPayload>("teams-error", (event) => {
      failInitializingSession(
        formatChatError(event.payload.error, event.payload.error_status),
      );
    }),
  );

  // teams-startup-status — surface SDK startup status/retry inside the launch panel.
  unsubs.push(
    await windowListen<TeamsStartupStatusPayload>("teams-startup-status", (event) => {
      const teamsStore = useTeamsStore.getState();
      const session = teamsStore.session;
      if (!session) return;
      if (session.requestId !== event.payload.request_id) return;
      if (session.phase !== "initializing") return;
      teamsStore.setStartupStatus({
        status: event.payload.status,
        message: event.payload.message
          ? formatChatError(event.payload.message, event.payload.error_status)
          : undefined,
        attempt: event.payload.attempt,
        maxAttempts: event.payload.max_attempts,
        retryDelayMs: event.payload.retry_delay_ms,
        errorStatus: event.payload.error_status,
      });
    }),
  );

  // chat-stream-retry — legacy fallback if teams startup retries are emitted through the chat path.
  unsubs.push(
    await windowListen<StreamRetryPayload>("chat-stream-retry", (event) => {
      const teamsStore = useTeamsStore.getState();
      const session = teamsStore.session;
      if (!session) return;
      if (session.requestId !== event.payload.request_id) return;
      if (session.phase !== "initializing") return;
      if (!isActionableRetry(event.payload.reason)) return;
      const statusMatch = event.payload.reason.match(/HTTP\s+(\d{3})/i);
      const status = statusMatch ? Number(statusMatch[1]) : undefined;
      const safeReason = formatChatError(event.payload.reason, status);
      teamsStore.setStartupStatus({
        status: "api_retry",
        message: safeReason,
        attempt: event.payload.attempt,
        maxAttempts: event.payload.max_attempts,
      });
      if (event.payload.attempt >= event.payload.max_attempts) {
        console.warn(
          `[teams-event] startup retries exhausted status=${status ?? "none"}`,
        );
        failInitializingSession(safeReason);
      }
    }),
  );

  // teams-message-routed — directed message confirmed by sidecar
  unsubs.push(
    await windowListen<TeamsMessageRoutedPayload>("teams-message-routed", (event) => {
      const { target_agent, content, timestamp } = event.payload;
      useTeamsStore.getState().addMessage({
        id: crypto.randomUUID(),
        sender: "user",
        targetAgent: target_agent,
        content,
        timestamp,
        type: "system",
        status: "delivered",
      });
    }),
  );

  // chat-error — handle sidecar crash/error. The Rust stdout reader emits
  // chat-error (not teams-error) when the sidecar exits unexpectedly.
  unsubs.push(
    await windowListen<TeamsErrorPayload>("chat-error", (event) => {
      const teamsStore = useTeamsStore.getState();
      const session = teamsStore.session;
      if (!session) return;
      // Only handle if this error is for our teams request
      if (session.requestId !== event.payload.request_id) return;
      const safeError = formatChatError(event.payload.error, event.payload.error_status);
      if (session.phase === "initializing") {
        console.warn(
          `[teams-event] chat-error during initialization status=${event.payload.error_status ?? "none"}`,
        );
        failInitializingSession(safeError);
      } else if (session.phase === "running") {
        console.warn(
          `[teams-event] chat-error during session status=${event.payload.error_status ?? "none"}`,
        );
        teamsStore.setSessionError(safeError);
      }
    }),
  );

  // chat-new-turn — a queued user message just started a new turn.
  // Mark all "queued" messages as "delivered" since the backend is now processing them.
  unsubs.push(
    await windowListen<{ request_id: string }>("chat-new-turn", (_event) => {
      const teamsStore = useTeamsStore.getState();
      const session = teamsStore.session;
      if (!session) return;
      for (const msg of session.messages) {
        if (msg.status === "queued") {
          teamsStore.updateMessageStatus(msg.id, "delivered");
        }
      }
    }),
  );

  // team-inbox-changed — Rust file watcher detected an inbox file update.
  // NOTE: The sidecar's inbox monitor now handles reading and injecting actual
  // message content directly into the PromptStream. The frontend listener is
  // kept for diagnostic logging only — no nudge is sent.
  unsubs.push(
    await windowListen<{ team: string; agent: string }>("team-inbox-changed", () => {}),
  );

  return unsubs;
}
