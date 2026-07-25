import { useMemo } from "react";
import type { AgentState } from "@/stores";
import {
  CARD_WIDTH,
  CARD_HEIGHT,
  CARD_HEIGHT_ORCHESTRATOR,
} from "../AgentCard";
import type { AgentFlowNode, AgentNodeData } from "./flow-types";

const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 80;

/** Worker role sort priority — lower = further left. */
const WORKER_ORDER: Record<string, number> = {
  coder: 0,
  reviewer: 1,
  researcher: 2,
  tester: 3,
};

interface LayoutInput {
  readonly agents: ReadonlyArray<AgentState>;
  readonly selectedAgent: string | null;
  readonly onCardClick: (name: string) => void;
}

/**
 * Computes React Flow node positions using a two-row centered layout.
 *
 * Row 0: leaders / orchestrators (centred)
 * Row 1: workers (centred beneath leaders)
 */
export function useAutoLayout({
  agents,
  selectedAgent,
  onCardClick,
}: LayoutInput): AgentFlowNode[] {
  return useMemo(() => {
    if (agents.length === 0) return [];

    const leaders: AgentState[] = [];
    const workers: AgentState[] = [];

    for (const agent of agents) {
      if (agent.role === "orchestrator" || agent.role === "leader") {
        leaders.push(agent);
      } else {
        workers.push(agent);
      }
    }

    // Sort workers by role priority, then name
    workers.sort((a, b) => {
      const ao = WORKER_ORDER[a.role] ?? 99;
      const bo = WORKER_ORDER[b.role] ?? 99;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });

    const leaderRowWidth =
      leaders.length * CARD_WIDTH +
      Math.max(0, leaders.length - 1) * HORIZONTAL_GAP;
    const workerRowWidth =
      workers.length * CARD_WIDTH +
      Math.max(0, workers.length - 1) * HORIZONTAL_GAP;
    const maxWidth = Math.max(leaderRowWidth, workerRowWidth);

    const nodes: AgentFlowNode[] = [];

    // Row 0 — leaders
    const leaderStartX = (maxWidth - leaderRowWidth) / 2;
    for (let i = 0; i < leaders.length; i++) {
      const agent = leaders[i];
      nodes.push(makeNode(agent, {
        x: leaderStartX + i * (CARD_WIDTH + HORIZONTAL_GAP),
        y: 0,
      }, CARD_HEIGHT_ORCHESTRATOR, selectedAgent, onCardClick));
    }

    // Row 1 — workers
    const workerStartX = (maxWidth - workerRowWidth) / 2;
    const workerY =
      (leaders.length > 0 ? CARD_HEIGHT_ORCHESTRATOR : 0) + VERTICAL_GAP;
    for (let i = 0; i < workers.length; i++) {
      const agent = workers[i];
      nodes.push(makeNode(agent, {
        x: workerStartX + i * (CARD_WIDTH + HORIZONTAL_GAP),
        y: workerY,
      }, CARD_HEIGHT, selectedAgent, onCardClick));
    }

    return nodes;
  }, [agents, selectedAgent, onCardClick]);
}

function makeNode(
  agent: AgentState,
  position: { x: number; y: number },
  height: number,
  selectedAgent: string | null,
  onCardClick: (name: string) => void,
): AgentFlowNode {
  return {
    id: agent.name,
    type: "agent",
    position,
    data: {
      agent,
      isSelected: selectedAgent === agent.name,
      onCardClick,
    } satisfies AgentNodeData as AgentNodeData,
    width: CARD_WIDTH,
    height,
  };
}
