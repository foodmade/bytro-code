import { memo } from "react";
import { BaseEdge, getBezierPath, EdgeLabelRenderer } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { AgentEdgeData } from "./flow-types";

function AgentEdgeInner(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
  } = props;

  const { color = "#A855F7", label, animated = false } = (data ?? {}) as AgentEdgeData;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const pathId = `edge-path-${id}`;

  return (
    <>
      {/* Glow layer — wider, blurred */}
      <path
        d={edgePath}
        stroke={color}
        strokeWidth={6}
        strokeOpacity={0.15}
        fill="none"
        style={{ filter: "blur(3px)" }}
      />

      {/* Main edge path */}
      <BaseEdge
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: 2,
          strokeOpacity: 0.6,
          strokeLinecap: "round",
        }}
      />

      {/* Hidden path for animateMotion reference */}
      <path id={pathId} d={edgePath} fill="none" stroke="none" />

      {/* Flowing particles (only when animated) */}
      {animated && (
        <>
          {/* Main dot */}
          <circle r={4} fill={color} opacity={0.9}>
            <animateMotion dur="2.5s" repeatCount="indefinite">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
          {/* Glow around main dot */}
          <circle r={4} fill={color} opacity={0.3} style={{ filter: "blur(4px)" }}>
            <animateMotion dur="2.5s" repeatCount="indefinite">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
          {/* Trail dot (offset) */}
          <circle r={2.5} fill={color} opacity={0.5}>
            <animateMotion dur="2.5s" repeatCount="indefinite" begin="0.15s">
              <mpath href={`#${pathId}`} />
            </animateMotion>
          </circle>
        </>
      )}

      {/* Edge label */}
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
              padding: "3px 8px",
              borderRadius: 6,
              background: `${color}15`,
              border: `1px solid ${color}40`,
              fontSize: 8,
              fontWeight: 600,
              color,
              fontFamily: "'JetBrains Mono', monospace",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const AgentEdge = memo(AgentEdgeInner);
