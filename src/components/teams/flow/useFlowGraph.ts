import { useMemo } from "react";
import type { AgentState, AgentRole } from "@/stores";
import { useTeamsStore } from "@/stores";
import { CARD_THEME } from "../AgentCard";
import type { AgentFlowNode, AgentFlowEdge, AgentEdgeData } from "./flow-types";
import { useAutoLayout } from "./useAutoLayout";

// ---------------------------------------------------------------------------
// Edge generation
// ---------------------------------------------------------------------------

function getEdgeLabel(_sourceRole: string, targetRole: string): string {
  switch (targetRole) {
    case "coder":
      return "Task Assign";
    case "reviewer":
      return "Review Assign";
    case "researcher":
      return "Research";
    case "tester":
      return "Test Task";
    default:
      return "Assign";
  }
}

function getPeerEdgeLabel(sourceRole: string, targetRole: string): string {
  if (sourceRole === "coder" && targetRole === "reviewer") return "Code Review";
  if (sourceRole === "reviewer" && targetRole === "coder") return "Feedback";
  if (sourceRole === "researcher") return "Findings";
  if (sourceRole === "tester") return "Test Results";
  return "Message";
}

function buildEdges(
  agents: ReadonlyArray<AgentState>,
  isActive: boolean,
  peerConnections: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): AgentFlowEdge[] {
  const leaders = agents.filter(
    (a) => a.role === "orchestrator" || a.role === "leader",
  );
  const workers = agents.filter(
    (a) => a.role !== "orchestrator" && a.role !== "leader",
  );
  const agentMap = new Map(agents.map((a) => [a.name, a]));
  const edges: AgentFlowEdge[] = [];

  // Leader → each worker (always present)
  for (const leader of leaders) {
    const theme = CARD_THEME[leader.role as AgentRole] ?? CARD_THEME.leader;
    for (const worker of workers) {
      edges.push({
        id: `${leader.name}->${worker.name}`,
        source: leader.name,
        target: worker.name,
        type: "agent",
        data: {
          label: getEdgeLabel(leader.role, worker.role),
          color: theme.accent,
          animated: isActive && worker.status === "active",
        } satisfies AgentEdgeData as AgentEdgeData,
      });
    }
  }

  // Peer connections — only shown when actual communication has occurred
  const seenPairs = new Set<string>();
  for (const conn of peerConnections) {
    const source = agentMap.get(conn.from);
    const target = agentMap.get(conn.to);
    if (!source || !target) continue;
    // Skip leader connections (already handled above)
    if (source.role === "orchestrator" || source.role === "leader") continue;
    if (target.role === "orchestrator" || target.role === "leader") continue;
    // Deduplicate bidirectional: use sorted pair key
    const pairKey = [conn.from, conn.to].sort().join("<->");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    edges.push({
      id: `${conn.from}<->${conn.to}`,
      source: conn.from,
      target: conn.to,
      type: "agent",
      data: {
        label: getPeerEdgeLabel(source.role, target.role),
        color: "#6366F1",
        animated:
          isActive &&
          (source.status === "active" || target.status === "active"),
      } satisfies AgentEdgeData as AgentEdgeData,
    });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseFlowGraphInput {
  readonly agents: ReadonlyArray<AgentState>;
  readonly selectedAgent: string | null;
  readonly onCardClick: (name: string) => void;
  readonly isActive: boolean;
}

export function useFlowGraph({
  agents,
  selectedAgent,
  onCardClick,
  isActive,
}: UseFlowGraphInput): {
  nodes: AgentFlowNode[];
  edges: AgentFlowEdge[];
} {
  const peerConnections = useTeamsStore((s) => s.session?.peerConnections ?? []);
  const nodes = useAutoLayout({ agents, selectedAgent, onCardClick });
  const edges = useMemo(
    () => buildEdges(agents, isActive, peerConnections),
    [agents, isActive, peerConnections],
  );
  return { nodes, edges };
}
