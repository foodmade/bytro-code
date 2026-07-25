import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentState, AgentRole } from "@/stores";
import { CARD_THEME } from "../AgentCard";
import { AgentNode } from "./AgentNode";
import { AgentEdge } from "./AgentEdge";
import { useFlowGraph } from "./useFlowGraph";
import type { AgentFlowNode, AgentFlowEdge, AgentNodeData } from "./flow-types";
import { LayoutGrid } from "lucide-react";

// Module-level constants so React Flow doesn't reinitialise on every render
const NODE_TYPES = { agent: AgentNode } as const;
const EDGE_TYPES = { agent: AgentEdge } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;
const FIT_VIEW_OPTIONS = { padding: 0.3 } as const;

interface FlowCanvasProps {
  readonly agents: ReadonlyArray<AgentState>;
  readonly selectedAgent: string | null;
  readonly onCardClick: (name: string) => void;
  readonly isActive: boolean;
  readonly children?: React.ReactNode;
}

function FlowCanvasInner({
  agents,
  selectedAgent,
  onCardClick,
  isActive,
  children,
}: FlowCanvasProps) {
  const { nodes: layoutNodes, edges: layoutEdges } = useFlowGraph({
    agents,
    selectedAgent,
    onCardClick,
    isActive,
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AgentFlowEdge>([]);
  const { fitView: rfFitView } = useReactFlow();

  // Track agent names to distinguish structural vs data changes
  const prevNamesRef = useRef<string>("");

  useEffect(() => {
    const nameKey = layoutNodes
      .map((n) => n.id)
      .sort()
      .join(",");
    const isFirstRender = prevNamesRef.current === "";
    const structuralChange = nameKey !== prevNamesRef.current;

    if (structuralChange && !isFirstRender) {
      console.warn(`[FlowCanvas] structural change: ${prevNamesRef.current} → ${nameKey}`);
    }

    prevNamesRef.current = nameKey;

    if (structuralChange) {
      // Agent added or removed — re-layout ALL nodes so dynamically added
      // agents are positioned correctly without overlapping existing nodes.
      setNodes(layoutNodes);

      // After the initial mount (handled by ReactFlow's `fitView` prop),
      // re-fit the viewport on every subsequent structural change so that
      // dynamically spawned agents are always visible.
      if (!isFirstRender) {
        requestAnimationFrame(() => {
          rfFitView({ padding: 0.3, duration: 300 });
        });
      }
    } else {
      // Data-only change (status, textDelta) — update data, preserve positions
      setNodes((prev) =>
        prev.map((n) => {
          const ln = layoutNodes.find((l) => l.id === n.id);
          return ln ? { ...n, data: ln.data } : n;
        }),
      );
    }

    setEdges(layoutEdges);
  }, [layoutNodes, layoutEdges, setNodes, setEdges, rfFitView]);

  // Reset all nodes to auto-layout positions
  const handleRelayout = useCallback(() => {
    setNodes(layoutNodes);
    requestAnimationFrame(() => {
      rfFitView({ padding: 0.3, duration: 300 });
    });
  }, [layoutNodes, setNodes, rfFitView]);

  // MiniMap node colour by role
  const minimapNodeColor = useCallback((node: AgentFlowNode) => {
    const d = node.data as AgentNodeData | undefined;
    const role = d?.agent?.role ?? "coder";
    return (CARD_THEME[role as AgentRole] ?? CARD_THEME.coder).accent;
  }, []);

  // Dark-themed controls/minimap styles
  const controlsStyle = useMemo(
    () =>
      ({
        background: "#1A1A24",
        border: "1px solid #2A2A3A",
        borderRadius: 8,
      }) as React.CSSProperties,
    [],
  );
  const minimapStyle = useMemo(
    () =>
      ({
        background: "#111118",
        border: "1px solid #2A2A3A",
        borderRadius: 8,
      }) as React.CSSProperties,
    [],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        background: "#0D0D12",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={PRO_OPTIONS}
        nodesConnectable={false}
        nodesDraggable
        zoomOnScroll
        zoomActivationKeyCode="Control"
        style={{ background: "#0D0D12" }}
      >
        <Background color="#1E1E2E" gap={20} size={1} />
        <Controls showInteractive={false} style={controlsStyle} />
        <MiniMap nodeColor={minimapNodeColor} maskColor="rgba(0,0,0,0.7)" style={minimapStyle} />
      </ReactFlow>

      {/* Auto-layout button */}
      <button
        onClick={handleRelayout}
        title="Auto-arrange cards"
        style={
          {
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 5,
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "#1A1A24",
            border: "1px solid #2A2A3A",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.15s ease",
            "--native-hover-bg": "#252536",
          } as React.CSSProperties
        }
        className="native-css-hover"
      >
        <LayoutGrid size={14} style={{ color: "#888888" }} />
      </button>

      {/* Viewport-fixed overlays — rendered outside ReactFlow, unaffected by pan/zoom */}
      {children}
    </div>
  );
}

/** Wrapped with ReactFlowProvider so internal hooks work. */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
