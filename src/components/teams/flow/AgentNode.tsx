import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { AgentNodeData } from "./flow-types";
import { AgentCard, CARD_THEME } from "../AgentCard";
import type { AgentRole } from "@/stores";

const HANDLE_STYLE: React.CSSProperties = {
  width: 8,
  height: 8,
  border: "none",
  opacity: 0.6,
};

function AgentNodeInner({ data }: NodeProps) {
  const { agent, isSelected, onCardClick } = data as AgentNodeData;
  const isLeader = agent.role === "orchestrator" || agent.role === "leader";
  const accent = (CARD_THEME[agent.role as AgentRole] ?? CARD_THEME.coder).accent;

  return (
    <>
      {/* Target handle at top — leaders don't receive incoming edges */}
      {!isLeader && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ ...HANDLE_STYLE, background: accent }}
        />
      )}

      {/* Reuse the existing AgentCard, overriding position to remove absolute */}
      <AgentCard
        agent={agent}
        isSelected={isSelected}
        onClick={() => onCardClick(agent.name)}
        style={{ position: "relative", left: "auto", top: "auto" }}
      />

      {/* Source handle at bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ ...HANDLE_STYLE, background: accent }}
      />
    </>
  );
}

export const AgentNode = memo(AgentNodeInner);
