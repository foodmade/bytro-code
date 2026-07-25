import type { Node, Edge } from "@xyflow/react";
import type { AgentState } from "@/stores";

/** Data payload embedded in each React Flow node. */
export interface AgentNodeData extends Record<string, unknown> {
  readonly agent: AgentState;
  readonly isSelected: boolean;
  readonly onCardClick: (agentName: string) => void;
}

/** Data payload embedded in each React Flow edge. */
export interface AgentEdgeData extends Record<string, unknown> {
  readonly label?: string;
  readonly color: string;
  readonly animated: boolean;
}

/** Typed aliases for React Flow generics. */
export type AgentFlowNode = Node<AgentNodeData, "agent">;
export type AgentFlowEdge = Edge<AgentEdgeData>;
