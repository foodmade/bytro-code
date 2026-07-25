import { useEffect, useRef } from "react";
import { ROLE_META } from "@/stores";
import type { AgentState, AgentToolOperation, AgentLogEntry, AgentRole } from "@/stores";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import {
  Loader2, Code, Eye, ArrowRight, Check, AlertCircle,
  Crown, Search, TestTube, GripVertical, FolderOpen,
  Pencil, Terminal, Brain, MessageSquare, Send,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants — role-specific card styling
// ---------------------------------------------------------------------------

export const CARD_THEME: Record<AgentRole, {
  readonly bg: string;
  readonly avatarBg: string;
  readonly accent: string;
}> = {
  orchestrator: { bg: "#13111F", avatarBg: "#2D1B4E", accent: "#A855F7" },
  leader:       { bg: "#13111F", avatarBg: "#2D1B4E", accent: "#A855F7" },
  coder:        { bg: "#0F1A15", avatarBg: "#0F2922", accent: "#10B981" },
  reviewer:     { bg: "#15120A", avatarBg: "#2A1F00", accent: "#F59E0B" },
  researcher:   { bg: "#0F1320", avatarBg: "#0F1B38", accent: "#3B82F6" },
  tester:       { bg: "#1A0F0F", avatarBg: "#2A1414", accent: "#EF4444" },
};

export const ROLE_ICON: Record<string, typeof Crown> = {
  orchestrator: Brain,
  leader: Crown,
  coder: Code,
  reviewer: Eye,
  researcher: Search,
  tester: TestTube,
};

export const STATUS_CONFIG: Record<string, { color: string; label: string; glow: boolean }> = {
  idle:    { color: "#6B7280", label: "idle",     glow: false },
  spawned: { color: "#3B82F6", label: "starting", glow: true },
  active:  { color: "#10B981", label: "active",   glow: true },
  stopped: { color: "#6B7280", label: "done",     glow: false },
  error:   { color: "#EF4444", label: "error",    glow: false },
};

export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 300;
export const CARD_HEIGHT_ORCHESTRATOR = 360;

export function getActiveLabel(role: string): string {
  switch (role) {
    case "orchestrator": return "Orchestrating";
    case "leader": return "Leading";
    case "coder": return "Writing code";
    case "reviewer": return "Reviewing";
    case "researcher": return "Researching";
    case "tester": return "Testing";
    default: return "Working";
  }
}

// ---------------------------------------------------------------------------
// Tool info helper (shared with AgentDetailPanel)
// ---------------------------------------------------------------------------

export function getToolInfo(toolName: string): {
  Icon: typeof Code;
  color: string;
  activeBg: string;
  activeBorder: string;
  pathColor: string;
} {
  switch (toolName) {
    case "Read":
    case "Grep":
    case "Glob":
      return { Icon: FolderOpen, color: "#A855F7", activeBg: "#141414", activeBorder: "transparent", pathColor: "#555555" };
    case "Write":
    case "Edit":
      return { Icon: Pencil, color: "#F59E0B", activeBg: "#1A1700", activeBorder: "#3D350050", pathColor: "#B08C00" };
    case "Bash":
      return { Icon: Terminal, color: "#10B981", activeBg: "#0F1A15", activeBorder: "#10B98130", pathColor: "#0F8A65" };
    case "Task":
      return { Icon: MessageSquare, color: "#3B82F6", activeBg: "#0F1320", activeBorder: "#3B82F630", pathColor: "#2563EB" };
    case "SendMessage":
      return { Icon: Send, color: "#8B5CF6", activeBg: "#130F20", activeBorder: "#8B5CF630", pathColor: "#7C3AED" };
    default:
      return { Icon: Code, color: "#6B7280", activeBg: "#141414", activeBorder: "transparent", pathColor: "#555555" };
  }
}

export function extractFilePath(toolInput: string): string {
  try {
    const parsed = JSON.parse(toolInput);
    // File tools: Read, Write, Edit
    if (parsed.file_path) {
      const parts = parsed.file_path.split(/[\\/]/);
      // Show last 2 path segments for better context
      return parts.length > 1 ? parts.slice(-2).join("/") : parts.pop() ?? "";
    }
    // Bash tool
    if (parsed.command) {
      const cmd = parsed.command.trim();
      // Show just the main command, not long args
      return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
    }
    // Grep / Glob
    if (parsed.pattern) {
      const pat = parsed.pattern;
      return pat.length > 30 ? pat.slice(0, 27) + "..." : pat;
    }
    // Task tool — show description
    if (parsed.description) return parsed.description.slice(0, 30);
    // WebFetch
    if (parsed.url) {
      try {
        return new URL(parsed.url).hostname;
      } catch {
        return parsed.url.slice(0, 30);
      }
    }
    return "";
  } catch {
    return "";
  }
}

function extractAgentTarget(toolInput: string): string {
  try {
    const parsed = JSON.parse(toolInput);
    // Task tool uses "name" for the agent; SendMessage uses "recipient"
    return parsed.name ?? parsed.recipient ?? parsed.target_agent_id ?? "";
  } catch {
    return "";
  }
}

function extractTaskDescription(toolInput: string): string {
  try {
    const parsed = JSON.parse(toolInput);
    // Task tool has "description" (short) and "prompt" (long)
    const desc = parsed.description ?? "";
    if (desc) return desc.slice(0, 80);
    // Fallback to first line of prompt
    const prompt = parsed.prompt ?? parsed.content ?? "";
    if (prompt) {
      const firstLine = prompt.split("\n")[0].trim();
      return firstLine.slice(0, 80);
    }
    return "";
  } catch {
    return "";
  }
}

interface SendMessageInfo {
  readonly recipient: string;
  readonly content: string;
  readonly summary: string;
  readonly msgType: string;
}

export function extractSendMessageInfo(toolInput: string): SendMessageInfo {
  try {
    const parsed = JSON.parse(toolInput);
    return {
      recipient: parsed.recipient ?? "",
      content: parsed.content ?? "",
      summary: parsed.summary ?? "",
      msgType: parsed.type ?? "message",
    };
  } catch {
    return { recipient: "", content: "", summary: "", msgType: "message" };
  }
}

function getAgentColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("lead") || lower.includes("orchestrat")) return "#A855F7";
  if (lower.includes("review")) return "#F59E0B";
  if (lower.includes("research") || lower.includes("explore")) return "#3B82F6";
  if (lower.includes("test")) return "#EF4444";
  return "#10B981";
}

// ---------------------------------------------------------------------------
// Text cleaning helpers
// ---------------------------------------------------------------------------

/**
 * Clean agent text output for display.
 * - Remove raw JSON objects/arrays that shouldn't be displayed
 * - Remove SDK internal directives
 * - Trim excessively long output
 */
export function cleanAgentText(text: string): string {
  if (!text) return "";

  // Split into lines and filter out JSON blobs and SDK noise
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let inJsonBlock = false;
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip lines that look like standalone JSON objects
    if (!inJsonBlock && (trimmed.startsWith('{"') || trimmed.startsWith("[{"))) {
      // Check if it's a complete single-line JSON
      try {
        JSON.parse(trimmed);
        // It's valid JSON — skip it entirely
        continue;
      } catch {
        // Multi-line JSON starts here
        inJsonBlock = true;
        braceDepth = countBraces(trimmed);
        continue;
      }
    }

    if (inJsonBlock) {
      braceDepth += countBraces(trimmed);
      if (braceDepth <= 0) {
        inJsonBlock = false;
      }
      continue;
    }

    // Skip SDK internal marker lines
    if (trimmed.startsWith("[TEAMS_READY]")) continue;
    if (trimmed.startsWith("[DIRECTED:")) continue;
    if (trimmed.startsWith("## DIRECTIVE:")) continue;

    cleaned.push(line);
  }

  const result = cleaned.join("\n").trim();
  // Limit displayed text length
  if (result.length > 1000) {
    return result.slice(result.length - 1000);
  }
  return result;
}

/** Count net brace depth change in a line ({ +1, } -1). */
function countBraces(line: string): number {
  let depth = 0;
  for (const ch of line) {
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// CardLogEntryRow — compact log entry for card view (chronological)
// ---------------------------------------------------------------------------

const MAX_CARD_LOG_ENTRIES = 10;

function CardUserMessage({ entry }: { readonly entry: AgentLogEntry }) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 6, padding: "5px 10px", borderRadius: 6,
        background: "rgba(var(--theme-accent-rgb),0.063)", borderLeft: "2px solid #A855F7",
      }}
    >
      <span style={{ fontSize: 9, fontWeight: 700, color: "#A855F7", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
        You
      </span>
      <span style={{ fontSize: 10, color: "#CCC", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
        {entry.content}
      </span>
    </div>
  );
}

function CardTextEntry({ entry }: { readonly entry: AgentLogEntry }) {
  const cleaned = cleanAgentText(entry.content);
  if (!cleaned) return null;
  return (
    <div className="agent-card-md" style={{ fontSize: 11, color: "#BBBBBB", lineHeight: 1.5, fontFamily: "Inter, sans-serif" }}>
      <MarkdownRenderer content={cleaned} variant="compact" />
    </div>
  );
}

function CardToolStartEntry({ entry, toolOperations }: { readonly entry: AgentLogEntry; readonly toolOperations: ReadonlyArray<AgentToolOperation> }) {
  const toolName = (entry.metadata?.toolName as string) ?? "Tool";
  const toolInput = (entry.metadata?.toolInput as string) ?? "";
  const toolCallId = (entry.metadata?.toolCallId as string) ?? "";
  const toolInfo = getToolInfo(toolName);
  const filePath = extractFilePath(toolInput);

  // Check actual status from toolOperations
  const toolOp = toolCallId ? toolOperations.find((op) => op.toolCallId === toolCallId) : undefined;
  const isRunning = !toolOp || toolOp.status === "running";
  const isSuccess = toolOp?.status === "success";
  const isError = toolOp?.status === "error";

  // For Task tool, show delegation style
  if (toolName === "Task") {
    const agentTarget = extractAgentTarget(toolInput);
    const taskDesc = extractTaskDescription(toolInput);
    const targetColor = agentTarget ? getAgentColor(agentTarget) : "#3B82F6";
    return (
      <div
        className="flex items-center"
        style={{
          gap: 6, padding: "4px 8px", borderRadius: 5,
          background: isRunning ? targetColor + "0C" : "#141414",
          border: isRunning ? `1px solid ${targetColor}15` : "none",
        }}
      >
        <ArrowRight size={9} style={{ color: targetColor, flexShrink: 0 }} />
        {agentTarget && (
          <span style={{ fontSize: 9, fontWeight: 700, color: targetColor, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
            @{agentTarget}
          </span>
        )}
        <span style={{ fontSize: 9, color: "#999", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {taskDesc}
        </span>
        {isRunning && <Loader2 size={9} className="animate-spin" style={{ color: targetColor, flexShrink: 0 }} />}
        {isSuccess && <Check size={9} style={{ color: "#10B981", flexShrink: 0 }} />}
        {isError && <AlertCircle size={9} style={{ color: "#EF4444", flexShrink: 0 }} />}
      </div>
    );
  }

  // For SendMessage tool, show recipient + message preview
  if (toolName === "SendMessage") {
    const msgInfo = extractSendMessageInfo(toolInput);
    const recipientColor = msgInfo.recipient ? getAgentColor(msgInfo.recipient) : "#8B5CF6";
    const preview = msgInfo.summary || msgInfo.content.slice(0, 80);
    const typeLabel = msgInfo.msgType === "broadcast" ? "all" : (msgInfo.msgType === "shutdown_request" ? "shutdown" : "");
    return (
      <div
        style={{
          padding: "4px 8px", borderRadius: 5,
          background: isRunning ? "#8B5CF60C" : "#141414",
          border: isRunning ? "1px solid #8B5CF615" : "none",
        }}
      >
        <div className="flex items-center" style={{ gap: 5 }}>
          <Send size={9} style={{ color: "#8B5CF6", flexShrink: 0 }} />
          {msgInfo.recipient ? (
            <span style={{ fontSize: 9, fontWeight: 700, color: recipientColor, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
              @{msgInfo.recipient}
            </span>
          ) : typeLabel ? (
            <span style={{ fontSize: 9, fontWeight: 600, color: "#8B5CF6", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
              {typeLabel}
            </span>
          ) : null}
          <div style={{ flex: 1 }} />
          {isRunning && <Loader2 size={9} className="animate-spin" style={{ color: "#8B5CF6", flexShrink: 0 }} />}
          {isSuccess && <Check size={9} style={{ color: "#10B981", flexShrink: 0 }} />}
          {isError && <AlertCircle size={9} style={{ color: "#EF4444", flexShrink: 0 }} />}
        </div>
        {preview && (
          <div style={{
            fontSize: 9, color: "#888", lineHeight: 1.4, marginTop: 2,
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {preview}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex items-center"
      style={{
        gap: 6, padding: "0 8px", height: 24, borderRadius: 4,
        background: isRunning ? toolInfo.activeBg : "#141414",
        border: isRunning ? `1px solid ${toolInfo.activeBorder}` : "none",
      }}
    >
      {isSuccess && <Check size={9} style={{ color: "#10B981", flexShrink: 0 }} />}
      {isError && <AlertCircle size={9} style={{ color: "#EF4444", flexShrink: 0 }} />}
      {isRunning && <Loader2 size={9} className="animate-spin" style={{ color: toolInfo.color, flexShrink: 0 }} />}
      <toolInfo.Icon size={9} style={{ color: isRunning ? toolInfo.color : "#777", flexShrink: 0 }} />
      <span style={{ fontSize: 9, fontWeight: 500, color: isRunning ? toolInfo.color : "#777" }}>{toolName}</span>
      {filePath && (
        <span style={{ fontSize: 8, color: "#555", fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {filePath}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentCard
// ---------------------------------------------------------------------------

export function AgentCard({
  agent,
  style,
  onClick,
  isSelected,
}: {
  readonly agent: AgentState;
  readonly style?: React.CSSProperties;
  readonly onClick?: () => void;
  readonly isSelected?: boolean;
}) {
  const isOrchestrator = agent.role === "orchestrator" || agent.role === "leader";
  const theme = CARD_THEME[agent.role] ?? CARD_THEME.coder;
  const meta = ROLE_META[agent.role];
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const RoleIcon = ROLE_ICON[agent.role] ?? Code;
  const statusLabel = agent.status === "active" ? getActiveLabel(agent.role) : "";
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardHeight = isOrchestrator ? CARD_HEIGHT_ORCHESTRATOR : CARD_HEIGHT;

  // Recent log entries for chronological display — skip tool_result (status shown on tool_start)
  // For orchestrator: only show delegation tools (Task, SendMessage) — hide internal tools
  // that are either orchestrator's own plumbing or leaked subagent operations.
  const ORCHESTRATOR_VISIBLE_TOOLS = new Set(["Task", "SendMessage"]);
  const displayEntries = agent.logEntries
    .filter((e) => {
      if (e.type === "text" || e.type === "user_message") return true;
      if (e.type === "tool_start") {
        if (isOrchestrator) {
          const toolName = (e.metadata?.toolName as string) ?? "";
          return ORCHESTRATOR_VISIBLE_TOOLS.has(toolName);
        }
        return true;
      }
      return false;
    })
    .slice(-MAX_CARD_LOG_ENTRIES);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.logEntries.length]);

  const hasActivity = displayEntries.length > 0;

  return (
    <div
      onClick={onClick}
      style={{
        position: "absolute",
        width: 340,
        height: cardHeight,
        borderRadius: 12,
        border: isSelected
          ? `2px solid ${theme.accent}90`
          : `1.5px solid ${theme.accent}40`,
        background: theme.bg,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        cursor: onClick ? "pointer" : "default",
        boxShadow: isSelected
          ? `0 0 24px 4px ${theme.accent}30`
          : agent.status === "active"
            ? `0 0 20px 2px ${theme.accent}20`
            : `0 0 16px 1px ${theme.accent}10`,
        transform: isSelected ? "scale(1.01)" : "none",
        transition: "box-shadow 0.3s ease, transform 0.15s ease, border 0.15s ease",
        ...style,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center shrink-0"
        style={{ padding: "10px 14px", gap: 10, background: theme.accent + "08", borderBottom: `1px solid ${theme.accent}20` }}
      >
        <div
          className="flex items-center justify-center shrink-0"
          style={{ width: 30, height: 30, borderRadius: 15, background: theme.avatarBg }}
        >
          <RoleIcon size={15} style={{ color: theme.accent }} />
        </div>
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 1 }}>
          <span
            style={{
              fontSize: 13, fontWeight: 700, color: "#E0E0E0",
              fontFamily: "'JetBrains Mono', monospace",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {agent.name}
          </span>
          <span style={{ fontSize: 10, fontWeight: 500, color: theme.accent }}>
            {meta.label}{statusLabel ? ` \u00b7 ${statusLabel}` : ""}
          </span>
        </div>
        <div className="flex items-center shrink-0" style={{ gap: 4, padding: "3px 10px", borderRadius: 10, background: statusCfg.color + "18" }}>
          <div style={{ width: 6, height: 6, borderRadius: 3, background: statusCfg.color, boxShadow: statusCfg.glow ? `0 0 6px ${statusCfg.color}60` : "none" }} />
          <span style={{ fontSize: 9, fontWeight: 600, color: statusCfg.color, fontFamily: "'JetBrains Mono', monospace" }}>
            {statusCfg.label}
          </span>
        </div>
        <GripVertical size={12} style={{ color: "#333333", flexShrink: 0 }} />
      </div>

      {/* Body — chronological log entries */}
      <div
        ref={bodyRef}
        className="agent-card-body nowheel nodrag"
        style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {!hasActivity && (
          <div style={{ fontSize: 11, color: "#555555", fontStyle: "italic" }}>
            {agent.status === "idle" || agent.status === "spawned"
              ? "Waiting for instructions..."
              : agent.status === "active"
                ? "Working..."
                : ""}
          </div>
        )}
        {displayEntries.map((entry, idx) => {
          if (entry.type === "user_message") {
            return <CardUserMessage key={`um-${entry.timestamp}-${idx}`} entry={entry} />;
          }
          if (entry.type === "text") {
            return <CardTextEntry key={`t-${entry.timestamp}-${idx}`} entry={entry} />;
          }
          if (entry.type === "tool_start") {
            return <CardToolStartEntry key={`ts-${entry.timestamp}-${idx}`} entry={entry} toolOperations={agent.toolOperations} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
