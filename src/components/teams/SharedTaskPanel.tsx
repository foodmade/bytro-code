import { ROLE_META } from "@/stores";
import type { AgentState } from "@/stores";
import { ROLE_ICON, STATUS_CONFIG, getActiveLabel, extractFilePath } from "./AgentCard";
import {
  Loader2, AlertCircle, CircleCheck, ListChecks, ArrowRight, Code,
} from "lucide-react";

// ---------------------------------------------------------------------------
// AgentStatusRow — one row per agent showing name, role, and current status
// ---------------------------------------------------------------------------

function AgentStatusRow({ agent }: { readonly agent: AgentState }) {
  const roleMeta = ROLE_META[agent.role];
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const RoleIcon = ROLE_ICON[agent.role] ?? Code;
  const statusLabel = agent.status === "active"
    ? getActiveLabel(agent.role)
    : statusCfg.label;

  // Show latest tool being used (if active)
  const runningOps = agent.toolOperations.filter((op) => op.status === "running");
  const latestRunningOp = runningOps.length > 0 ? runningOps[runningOps.length - 1] : undefined;
  const latestOpSummary = latestRunningOp
    ? `${latestRunningOp.toolName}${extractFilePath(latestRunningOp.toolInput) ? `: ${extractFilePath(latestRunningOp.toolInput)}` : ""}`
    : undefined;

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 4, padding: "8px 10px", borderRadius: 6,
        background: agent.status === "active" ? roleMeta.color + "08" : "transparent",
        border: agent.status === "active" ? `1px solid ${roleMeta.color}15` : "1px solid transparent",
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <div
          className="flex items-center justify-center shrink-0"
          style={{ width: 22, height: 22, borderRadius: 11, background: roleMeta.color + "20" }}
        >
          <RoleIcon size={11} style={{ color: roleMeta.color }} />
        </div>
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#CCCCCC", fontFamily: "'JetBrains Mono', monospace" }}>
            {agent.name}
          </span>
          <span style={{ fontSize: 9, color: roleMeta.color }}>{roleMeta.label}</span>
        </div>
        <div className="flex items-center shrink-0" style={{ gap: 3 }}>
          {agent.status === "active" && <Loader2 size={9} className="animate-spin" style={{ color: statusCfg.color }} />}
          <div style={{ width: 5, height: 5, borderRadius: 3, background: statusCfg.color, boxShadow: statusCfg.glow ? `0 0 4px ${statusCfg.color}60` : "none" }} />
          <span style={{ fontSize: 8, fontWeight: 600, color: statusCfg.color, fontFamily: "'JetBrains Mono', monospace" }}>
            {statusLabel}
          </span>
        </div>
      </div>
      {/* Show current activity when active */}
      {latestOpSummary && (
        <span style={{
          fontSize: 9, color: "#666", fontFamily: "'JetBrains Mono', monospace",
          paddingLeft: 30, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {latestOpSummary}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskDelegationRow — shows a task delegated from orchestrator to an agent
// ---------------------------------------------------------------------------

interface TaskDelegation {
  readonly agentName: string;
  readonly description: string;
  readonly status: "running" | "success" | "error" | "warning";
}

function TaskDelegationRow({ task }: { readonly task: TaskDelegation }) {
  const isRunning = task.status === "running";
  const isSuccess = task.status === "success";
  const isError = task.status === "error";
  const agentColor = getAgentColorFromName(task.agentName);

  return (
    <div
      className="flex items-center"
      style={{
        gap: 6, padding: "5px 10px", borderRadius: 5,
        background: isRunning ? agentColor + "08" : "transparent",
      }}
    >
      {isRunning && <Loader2 size={9} className="animate-spin" style={{ color: agentColor, flexShrink: 0 }} />}
      {isSuccess && <CircleCheck size={9} style={{ color: "#10B981", flexShrink: 0 }} />}
      {isError && <AlertCircle size={9} style={{ color: "#EF4444", flexShrink: 0 }} />}
      <ArrowRight size={9} style={{ color: agentColor, flexShrink: 0 }} />
      <span style={{ fontSize: 9, fontWeight: 700, color: agentColor, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
        @{task.agentName}
      </span>
      <span style={{ fontSize: 9, color: "#999", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
        {task.description}
      </span>
    </div>
  );
}

function getAgentColorFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("lead") || lower.includes("orchestrat") || lower === "main") return "#A855F7";
  if (lower.includes("review")) return "#F59E0B";
  if (lower.includes("research") || lower.includes("explore")) return "#3B82F6";
  if (lower.includes("test")) return "#EF4444";
  return "#10B981";
}

// ---------------------------------------------------------------------------
// SharedTaskPanel
// ---------------------------------------------------------------------------

export function SharedTaskPanel({ agents }: { readonly agents: ReadonlyArray<AgentState> }) {
  // Extract task delegations from the orchestrator's (main) Task tool operations
  const orchestrator = agents.find((a) => a.role === "orchestrator" || a.role === "leader");
  const delegations: TaskDelegation[] = [];

  if (orchestrator) {
    for (const op of orchestrator.toolOperations) {
      if (op.toolName === "Task") {
        try {
          const parsed = JSON.parse(op.toolInput);
          const agentName = parsed.name ?? parsed.description?.split(" ")[0] ?? "agent";
          const desc = parsed.description ?? "";
          delegations.push({ agentName, description: desc, status: op.status });
        } catch {
          delegations.push({ agentName: "agent", description: "Task", status: op.status });
        }
      }
    }
  }

  // Non-orchestrator agents for status display
  const workerAgents = agents.filter((a) => a.role !== "orchestrator" && a.role !== "leader");

  const activeCount = agents.filter((a) => a.status === "active").length;
  const completedDelegations = delegations.filter((d) => d.status === "success").length;

  return (
    <div className="flex flex-col" style={{ flex: 1, padding: 12, gap: 4, overflow: "auto" }}>
      {/* Header */}
      <div className="flex flex-col" style={{ gap: 8, padding: "0 4px 10px 4px", borderBottom: "1px solid #1E1E2E" }}>
        <div className="flex items-center" style={{ gap: 6 }}>
          <ListChecks size={12} style={{ color: "#A855F7" }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: "#555555", letterSpacing: 1.5, fontFamily: "Inter, sans-serif" }}>
            TEAM STATUS
          </span>
        </div>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span style={{ fontSize: 9, color: "#555", fontFamily: "'JetBrains Mono', monospace" }}>
            {activeCount} active · {agents.length} total
          </span>
        </div>
        {delegations.length > 0 && (
          <div className="flex items-center" style={{ gap: 8 }}>
            <div style={{ flex: 1, height: 3, borderRadius: 2, background: "#1E1E2E", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: delegations.length > 0 ? `${Math.round((completedDelegations / delegations.length) * 100)}%` : "0%",
                background: "#A855F7", borderRadius: 2, transition: "width 0.3s ease",
              }} />
            </div>
            <span style={{ fontSize: 9, fontWeight: 600, color: "#A855F7", fontFamily: "'JetBrains Mono', monospace" }}>
              {completedDelegations}/{delegations.length}
            </span>
          </div>
        )}
      </div>

      {/* Task Delegations */}
      {delegations.length > 0 && (
        <div className="flex flex-col" style={{ gap: 4, paddingTop: 4 }}>
          <div className="flex items-center" style={{ gap: 4, padding: "2px 4px" }}>
            <div style={{ width: 5, height: 5, borderRadius: 3, background: "#A855F7" }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: "#555", letterSpacing: 1, fontFamily: "Inter, sans-serif" }}>
              DELEGATED TASKS
            </span>
          </div>
          {delegations.map((task, idx) => (
            <TaskDelegationRow key={`del-${idx}`} task={task} />
          ))}
        </div>
      )}

      {/* Agent Status */}
      <div className="flex flex-col" style={{ gap: 4, paddingTop: 8 }}>
        <div className="flex items-center" style={{ gap: 4, padding: "2px 4px" }}>
          <div style={{ width: 5, height: 5, borderRadius: 3, background: "#10B981" }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: "#555", letterSpacing: 1, fontFamily: "Inter, sans-serif" }}>
            AGENTS
          </span>
        </div>
        {workerAgents.map((agent) => (
          <AgentStatusRow key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}
