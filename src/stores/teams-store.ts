import { create } from "zustand";
import { track } from "@/lib/tracking";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRole = "leader" | "coder" | "reviewer" | "researcher" | "tester" | "orchestrator";

export type AgentStatus = "idle" | "spawned" | "active" | "stopped" | "error";

export interface TeamsMessage {
  readonly id: string;
  readonly sender: "user" | string; // "user" or agent name
  readonly targetAgent?: string; // if directed, which agent
  readonly content: string;
  readonly timestamp: number;
  readonly type: "user_message" | "agent_response" | "system";
  /** Delivery status: queued (waiting), sent (delivered to backend), delivered (confirmed). */
  readonly status?: "queued" | "sent" | "delivered";
}

export interface TeamsToolDisplayMeta {
  readonly status: "success" | "warning" | "error";
  readonly severity: "info" | "warning" | "error";
  readonly reason?: string;
}

export interface AgentLogEntry {
  readonly type: "text" | "tool_start" | "tool_result" | "thinking" | "status_change" | "user_message";
  readonly timestamp: number;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TeamsAgentConfig {
  readonly name: string;
  readonly role: AgentRole;
  readonly description: string;
  readonly prompt: string;
  readonly tools?: ReadonlyArray<string>;
  readonly model?: "sonnet" | "opus" | "haiku";
}

export interface AgentToolOperation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly status: "running" | "success" | "warning" | "error";
  readonly result?: string;
  readonly display?: TeamsToolDisplayMeta;
  readonly timestamp: number;
}

export interface AgentState {
  readonly name: string;
  readonly role: AgentRole;
  readonly status: AgentStatus;
  readonly textDelta: string;
  readonly thinkingDelta: string;
  readonly toolOperations: ReadonlyArray<AgentToolOperation>;
  readonly logEntries: ReadonlyArray<AgentLogEntry>;
  readonly statusMessage?: string;
}

export interface PeerConnection {
  readonly from: string;
  readonly to: string;
}

export interface TeamsStartupStatus {
  readonly status: string;
  readonly message?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly errorStatus?: number;
}

export interface TeamsSession {
  readonly requestId: string;
  readonly task: string;
  readonly agents: ReadonlyArray<TeamsAgentConfig>;
  readonly agentStates: Readonly<Record<string, AgentState>>;
  readonly messages: ReadonlyArray<TeamsMessage>;
  /** Dynamic peer connections — only shown when actual communication occurs. */
  readonly peerConnections: ReadonlyArray<PeerConnection>;
  /**
   * "initializing" = launch sent to backend, waiting for SDK init;
   * "ready"        = SDK initialized, awaiting user task;
   * "running"      = executing task;
   * "done" / "error" = finished
   */
  readonly phase: "initializing" | "ready" | "running" | "done" | "error";
  readonly summary?: string;
  readonly error?: string;
  readonly startupStatus?: TeamsStartupStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  /** Timestamp (ms) of last sidecar event received — used to detect stale sessions. */
  readonly lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// Role metadata for UI rendering
// ---------------------------------------------------------------------------

export const ROLE_META: Record<AgentRole, { label: string; color: string; icon: string }> = {
  orchestrator: { label: "Orchestrator", color: "#A855F7", icon: "Brain" },
  leader: { label: "Leader", color: "#A855F7", icon: "Crown" },
  coder: { label: "Coder", color: "#10B981", icon: "Code" },
  reviewer: { label: "Reviewer", color: "#F59E0B", icon: "Eye" },
  researcher: { label: "Researcher", color: "#3B82F6", icon: "Search" },
  tester: { label: "Tester", color: "#EF4444", icon: "TestTube" },
};

// ---------------------------------------------------------------------------
// Team templates
// ---------------------------------------------------------------------------

export interface TeamTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly roles: ReadonlyArray<{ readonly role: AgentRole; readonly name: string }>;
}

export const TEAM_TEMPLATES: ReadonlyArray<TeamTemplate> = [
  {
    id: "dev",
    name: "Dev Team",
    description: "Develop & review code",
    roles: [
      { role: "coder", name: "dev" },
      { role: "reviewer", name: "reviewer" },
    ],
  },
  {
    id: "review",
    name: "Review Team",
    description: "Thorough code review",
    roles: [
      { role: "reviewer", name: "reviewer" },
      { role: "tester", name: "tester" },
    ],
  },
  {
    id: "research",
    name: "Research Team",
    description: "Research & implement",
    roles: [
      { role: "researcher", name: "researcher" },
      { role: "coder", name: "dev" },
    ],
  },
  {
    id: "fullstack",
    name: "Full Stack",
    description: "Complete team coverage",
    roles: [
      { role: "coder", name: "dev" },
      { role: "reviewer", name: "reviewer" },
      { role: "researcher", name: "researcher" },
      { role: "tester", name: "tester" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Default agent prompts per role
// ---------------------------------------------------------------------------

const DEFAULT_PROMPTS: Record<AgentRole, string> = {
  orchestrator: "You are the main orchestrator. Coordinate all agents, delegate tasks, and synthesize results.",
  leader: "You are the team leader. Coordinate the team, break down tasks, and ensure quality output.",
  coder: "You are a senior developer. Write clean, efficient, well-tested code following best practices.",
  reviewer: "You are a code reviewer. Review code for quality, security, maintainability, and correctness.",
  researcher: "You are a researcher. Investigate solutions, analyze documentation, and provide technical insights.",
  tester: "You are a test engineer. Write comprehensive tests, identify edge cases, and validate implementations.",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 500;
const LOG_AGGREGATION_WINDOW_MS = 2000;

/** Aggregation-aware append for log entries.
 *  For "text" and "thinking" types, if the last entry has the same type and
 *  its timestamp is within the aggregation window, the content is concatenated
 *  rather than creating a new entry. */
function appendLogEntry(
  entries: ReadonlyArray<AgentLogEntry>,
  entry: AgentLogEntry,
): ReadonlyArray<AgentLogEntry> {
  const canAggregate = entry.type === "text" || entry.type === "thinking";
  if (canAggregate && entries.length > 0) {
    const last = entries[entries.length - 1];
    if (last.type === entry.type && entry.timestamp - last.timestamp < LOG_AGGREGATION_WINDOW_MS) {
      const merged: AgentLogEntry = {
        ...last,
        content: last.content + entry.content,
        timestamp: entry.timestamp,
      };
      const updated = [...entries.slice(0, -1), merged];
      return updated.length > MAX_LOG_ENTRIES ? updated.slice(updated.length - MAX_LOG_ENTRIES) : updated;
    }
  }
  const updated = [...entries, entry];
  return updated.length > MAX_LOG_ENTRIES ? updated.slice(updated.length - MAX_LOG_ENTRIES) : updated;
}

/** Guess an agent role from its name. Falls back to "coder". */
function guessRoleFromName(name: string): AgentRole {
  const lower = name.toLowerCase();
  if (lower === "main" || lower.includes("orchestrat")) return "orchestrator";
  if (lower.includes("lead")) return "leader";
  if (lower.includes("review")) return "reviewer";
  if (lower.includes("research") || lower.includes("explore")) return "researcher";
  if (lower.includes("test")) return "tester";
  return "coder";
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface TeamsState {
  readonly session: TeamsSession | null;
  readonly isLaunchPanelOpen: boolean;
  readonly selectedAgent: string | null;

  // Actions
  readonly openLaunchPanel: () => void;
  readonly closeLaunchPanel: () => void;
  readonly selectAgent: (name: string | null) => void;
  readonly addMessage: (msg: TeamsMessage) => void;
  readonly updateMessageStatus: (msgId: string, status: "queued" | "sent" | "delivered") => void;
  readonly appendAgentLogEntry: (agentName: string, entry: AgentLogEntry) => void;
  /** Create session in "initializing" state — backend call has been sent. */
  readonly createSession: (requestId: string, agents: ReadonlyArray<TeamsAgentConfig>) => void;
  /** SDK initialized — transition from "initializing" → "ready". */
  readonly setSessionReady: () => void;
  /** Set task and transition from "ready" → "running". */
  readonly startRunning: (requestId: string, task: string) => void;
  readonly endSession: (summary?: string) => void;
  readonly setSessionError: (error: string) => void;
  readonly setStartupStatus: (status: TeamsStartupStatus) => void;
  /** Dynamically register an agent that was spawned by the SDK but wasn't
   *  pre-configured in the launch panel (e.g. name mismatch or extra agent). */
  readonly registerDynamicAgent: (agentName: string, role?: AgentRole) => void;
  readonly updateAgentStatus: (agentName: string, status: AgentStatus, message?: string) => void;
  readonly appendAgentDelta: (agentName: string, delta: string) => void;
  readonly appendAgentThinking: (agentName: string, delta: string) => void;
  readonly addAgentToolStart: (agentName: string, toolCallId: string, toolName: string, toolInput: string) => void;
  readonly addAgentToolResult: (agentName: string, toolCallId: string, success: boolean, result: string, display?: TeamsToolDisplayMeta) => void;
  /** Record a peer-to-peer communication link (triggers dynamic edge in flow canvas). */
  readonly addPeerConnection: (from: string, to: string) => void;
  readonly clearSession: () => void;
  readonly getDefaultPrompt: (role: AgentRole) => string;
}

export const useTeamsStore = create<TeamsState>((set) => ({
  session: null,
  isLaunchPanelOpen: false,
  selectedAgent: null,

  openLaunchPanel: () => set({ isLaunchPanelOpen: true }),
  closeLaunchPanel: () => set({ isLaunchPanelOpen: false }),

  selectAgent: (name) => set({ selectedAgent: name }),

  addMessage: (msg) =>
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          messages: [...state.session.messages, msg],
          lastActivityAt: Date.now(),
        },
      };
    }),

  updateMessageStatus: (msgId, status) =>
    set((state) => {
      if (!state.session) return state;
      const idx = state.session.messages.findIndex((m) => m.id === msgId);
      if (idx < 0) return state;
      const updated = [...state.session.messages];
      updated[idx] = { ...updated[idx], status };
      return {
        session: {
          ...state.session,
          messages: updated,
        },
      };
    }),

  appendAgentLogEntry: (agentName, entry) =>
    set((state) => {
      if (!state.session) return state;
      const agentState = state.session.agentStates[agentName];
      if (!agentState) return state;
      return {
        session: {
          ...state.session,
          lastActivityAt: Date.now(),
          agentStates: {
            ...state.session.agentStates,
            [agentName]: {
              ...agentState,
              logEntries: appendLogEntry(agentState.logEntries, entry),
            },
          },
        },
      };
    }),

  createSession: (requestId, agents) => {
    track("teams", "teams.session_started");
    const agentStates: Record<string, AgentState> = {};

    // Always include the "main" orchestrator — it's the team leader that
    // coordinates all other agents. Without it in the initial state, the
    // FlowCanvas has no leader node and SharedTaskPanel can't show delegations.
    // Previously "main" was only added dynamically via ensureAgentRegistered
    // when the first event arrived, causing an intermittent race condition
    // where the teams view rendered without the orchestrator.
    const hasOrchestrator = agents.some(
      (a) => a.name === "main" || a.role === "orchestrator" || a.role === "leader",
    );
    if (!hasOrchestrator) {
      agentStates["main"] = {
        name: "main",
        role: "orchestrator",
        status: "idle",
        textDelta: "",
        thinkingDelta: "",
        toolOperations: [],
        logEntries: [],
      };
    }

    for (const agent of agents) {
      agentStates[agent.name] = {
        name: agent.name,
        role: agent.role,
        status: "idle",
        textDelta: "",
        thinkingDelta: "",
        toolOperations: [],
        logEntries: [],
      };
    }

    const now = Date.now();
    set({
      session: {
        requestId,
        task: "",
        agents,
        agentStates,
        messages: [],
        peerConnections: [],
        phase: "initializing",
        startedAt: now,
        lastActivityAt: now,
      },
      // Keep launch panel open — it shows a loading spinner.
      // The panel will close when teams-ready fires and switches to TeamsView.
    });
  },

  setSessionReady: () =>
    set((state) => {
      if (!state.session || state.session.phase !== "initializing") return state;
      return {
        session: {
          ...state.session,
          phase: "ready",
        },
      };
    }),

  startRunning: (requestId, task) =>
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          requestId,
          task,
          phase: "running",
          lastActivityAt: Date.now(),
        },
      };
    }),

  endSession: (summary) =>
    set((state) => {
      if (!state.session) return state;
      // Mark all remaining "running" tool operations across all agents as
      // "success" — if the session ended, those tools have completed.
      const updatedAgentStates: Record<string, AgentState> = {};
      for (const [name, agentState] of Object.entries(state.session.agentStates)) {
        const hasRunning = agentState.toolOperations.some((op) => op.status === "running");
        updatedAgentStates[name] = hasRunning
          ? {
              ...agentState,
              toolOperations: agentState.toolOperations.map((op) =>
                op.status === "running" ? { ...op, status: "success" as const } : op,
              ),
            }
          : agentState;
      }
      return {
        session: {
          ...state.session,
          agentStates: updatedAgentStates,
          phase: "done",
          summary,
          completedAt: Date.now(),
        },
      };
    }),

  setSessionError: (error) =>
    set((state) => {
      if (!state.session) return state;
      // Mark remaining "running" operations as "error" on session failure.
      const updatedAgentStates: Record<string, AgentState> = {};
      for (const [name, agentState] of Object.entries(state.session.agentStates)) {
        const hasRunning = agentState.toolOperations.some((op) => op.status === "running");
        updatedAgentStates[name] = hasRunning
          ? {
              ...agentState,
              toolOperations: agentState.toolOperations.map((op) =>
                op.status === "running" ? { ...op, status: "error" as const } : op,
              ),
            }
          : agentState;
      }
      return {
        session: {
          ...state.session,
          agentStates: updatedAgentStates,
          phase: "error",
          error,
          completedAt: Date.now(),
        },
      };
    }),

  setStartupStatus: (startupStatus) =>
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          startupStatus,
          lastActivityAt: Date.now(),
        },
      };
    }),

  registerDynamicAgent: (agentName, role) =>
    set((state) => {
      if (!state.session) return state;
      if (state.session.agentStates[agentName]) return state;
      const guessedRole = role ?? guessRoleFromName(agentName);
      const newAgent: AgentState = {
        name: agentName,
        role: guessedRole,
        status: "idle",
        textDelta: "",
        thinkingDelta: "",
        toolOperations: [],
        logEntries: [],
      };
      const newAgentStates = {
        ...state.session.agentStates,
        [agentName]: newAgent,
      };
      console.warn(
        `[teams-store] registerDynamicAgent("${agentName}"): role="${guessedRole}" total=${Object.keys(newAgentStates).length}`,
      );
      return {
        session: {
          ...state.session,
          agentStates: newAgentStates,
        },
      };
    }),

  updateAgentStatus: (agentName, status, message) =>
    set((state) => {
      if (!state.session) return state;
      const agentState = state.session.agentStates[agentName];
      if (!agentState) return state;
      const now = Date.now();
      const logEntry: AgentLogEntry = {
        type: "status_change",
        timestamp: now,
        content: message ?? status,
        metadata: { status },
      };
      // When agent stops or goes idle, mark all remaining "running" tool
      // operations as "success" — the tools have completed but their result
      // events may have been lost (e.g. subagent file watcher race condition).
      const updatedOps = (status === "stopped" || status === "idle")
        ? agentState.toolOperations.map((op) =>
            op.status === "running" ? { ...op, status: "success" as const } : op,
          )
        : agentState.toolOperations;
      return {
        session: {
          ...state.session,
          lastActivityAt: now,
          agentStates: {
            ...state.session.agentStates,
            [agentName]: {
              ...agentState,
              status,
              statusMessage: message,
              toolOperations: updatedOps,
              logEntries: appendLogEntry(agentState.logEntries, logEntry),
            },
          },
        },
      };
    }),

  appendAgentDelta: (agentName, delta) =>
    set((state) => {
      if (!state.session) return state;
      const agentState = state.session.agentStates[agentName];
      if (!agentState) return state;
      const now = Date.now();
      const newText = agentState.textDelta + delta;
      const logEntry: AgentLogEntry = {
        type: "text",
        timestamp: now,
        content: delta,
      };
      return {
        session: {
          ...state.session,
          lastActivityAt: now,
          agentStates: {
            ...state.session.agentStates,
            [agentName]: {
              ...agentState,
              textDelta: newText,
              status: "active",
              logEntries: appendLogEntry(agentState.logEntries, logEntry),
            },
          },
        },
      };
    }),

  appendAgentThinking: (agentName, delta) =>
    set((state) => {
      if (!state.session) return state;
      const agentState = state.session.agentStates[agentName];
      if (!agentState) return state;
      const now = Date.now();
      const newThinking = agentState.thinkingDelta + delta;
      const logEntry: AgentLogEntry = {
        type: "thinking",
        timestamp: now,
        content: delta,
      };
      return {
        session: {
          ...state.session,
          agentStates: {
            ...state.session.agentStates,
            [agentName]: {
              ...agentState,
              thinkingDelta: newThinking,
              logEntries: appendLogEntry(agentState.logEntries, logEntry),
            },
          },
        },
      };
    }),

  addAgentToolStart: (agentName, toolCallId, toolName, toolInput) =>
    set((state) => {
      if (!state.session) return state;
      const agentState = state.session.agentStates[agentName];
      if (!agentState) return state;
      // Deduplicate: skip if this toolCallId already exists
      if (agentState.toolOperations.some((op) => op.toolCallId === toolCallId)) return state;
      const now = Date.now();
      const op: AgentToolOperation = {
        toolCallId,
        toolName,
        toolInput,
        status: "running",
        timestamp: now,
      };
      const logEntry: AgentLogEntry = {
        type: "tool_start",
        timestamp: now,
        content: toolName,
        metadata: { toolCallId, toolName, toolInput },
      };
      return {
        session: {
          ...state.session,
          lastActivityAt: now,
          agentStates: {
            ...state.session.agentStates,
            [agentName]: {
              ...agentState,
              toolOperations: [...agentState.toolOperations, op],
              status: "active",
              logEntries: appendLogEntry(agentState.logEntries, logEntry),
            },
          },
        },
      };
    }),

  addAgentToolResult: (agentName, toolCallId, success, result, display) =>
    set((state) => {
      if (!state.session) return state;
      const agentState = state.session.agentStates[agentName];
      if (!agentState) return state;
      const ops = agentState.toolOperations.map((op) =>
        op.toolCallId === toolCallId
          ? { ...op, status: display?.status ?? (success ? ("success" as const) : ("error" as const)), result, ...(display !== undefined ? { display } : {}) }
          : op,
      );
      const now = Date.now();
      const toolOp = agentState.toolOperations.find((op) => op.toolCallId === toolCallId);
      const logEntry: AgentLogEntry = {
        type: "tool_result",
        timestamp: now,
        content: result,
        metadata: { toolCallId, toolName: toolOp?.toolName, success, displayStatus: display?.status },
      };
      return {
        session: {
          ...state.session,
          lastActivityAt: now,
          agentStates: {
            ...state.session.agentStates,
            [agentName]: {
              ...agentState,
              toolOperations: ops,
              logEntries: appendLogEntry(agentState.logEntries, logEntry),
            },
          },
        },
      };
    }),

  addPeerConnection: (from, to) =>
    set((state) => {
      if (!state.session) return state;
      // Skip if connection already exists (either direction)
      const exists = state.session.peerConnections.some(
        (c) => (c.from === from && c.to === to) || (c.from === to && c.to === from),
      );
      if (exists) return state;
      return {
        session: {
          ...state.session,
          peerConnections: [...state.session.peerConnections, { from, to }],
        },
      };
    }),

  clearSession: () => set({ session: null }),

  getDefaultPrompt: (role) => DEFAULT_PROMPTS[role],
}));
