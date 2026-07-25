import { useEffect, useRef, useState } from "react";
import { useTeamsStore, ROLE_META } from "@/stores";
import type { AgentLogEntry, AgentRole } from "@/stores";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { CARD_THEME, ROLE_ICON, STATUS_CONFIG, getToolInfo, extractFilePath, extractSendMessageInfo, getActiveLabel, cleanAgentText } from "./AgentCard";
import {
  X, Loader2, Check, AlertCircle, ChevronDown, ChevronRight,
  Code, Info, Send,
} from "lucide-react";

// ---------------------------------------------------------------------------
// LogEntryRow — renders a single log entry by type
// ---------------------------------------------------------------------------

function LogEntryText({ entry }: { readonly entry: AgentLogEntry }) {
  const cleaned = cleanAgentText(entry.content);
  if (!cleaned) return null;

  return (
    <div style={{ fontSize: 12, color: "#CCCCCC", lineHeight: 1.7, fontFamily: "Inter, sans-serif" }}>
      <MarkdownRenderer content={cleaned} variant="compact" />
    </div>
  );
}
function LogEntryToolStart({ entry, toolOperations }: { readonly entry: AgentLogEntry; readonly toolOperations?: ReadonlyArray<import("@/stores").AgentToolOperation> }) {
  const toolName = (entry.metadata?.toolName as string) ?? "Tool";
  const toolInput = (entry.metadata?.toolInput as string) ?? "";
  const toolCallId = (entry.metadata?.toolCallId as string) ?? "";
  const toolInfo = getToolInfo(toolName);
  const filePath = extractFilePath(toolInput);

  // Check if this tool has completed by looking up its operation status
  const toolOp = toolCallId && toolOperations
    ? toolOperations.find((op) => op.toolCallId === toolCallId)
    : undefined;
  const isCompleted = toolOp?.status === "success";
  const isError = toolOp?.status === "error";
  const isRunning = !isCompleted && !isError;

  // SendMessage — show recipient, message type, and content preview
  if (toolName === "SendMessage") {
    const msgInfo = extractSendMessageInfo(toolInput);
    const statusColor = isRunning ? "#8B5CF6" : (isError ? "#EF4444" : "#10B981");
    const typeLabel = msgInfo.msgType === "broadcast" ? "broadcast"
      : msgInfo.msgType === "shutdown_request" ? "shutdown"
      : "";
    const preview = msgInfo.summary || msgInfo.content.slice(0, 120);
    return (
      <div style={{ borderRadius: 6, overflow: "hidden" }}>
        <div
          className="flex items-center"
          style={{
            gap: 8, padding: "6px 10px", minHeight: 30,
            background: isRunning ? "#130F20" : (isError ? "#EF444408" : "#10B98108"),
            border: isRunning ? "1px solid #8B5CF620" : "none",
          }}
        >
          {isRunning && <Loader2 size={11} className="animate-spin" style={{ color: statusColor, flexShrink: 0 }} />}
          {isCompleted && <Check size={11} style={{ color: "#10B981", flexShrink: 0 }} />}
          {isError && <AlertCircle size={11} style={{ color: "#EF4444", flexShrink: 0 }} />}
          <Send size={12} style={{ color: statusColor, flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 500, color: statusColor }}>SendMessage</span>
          {msgInfo.recipient && (
            <span style={{ fontSize: 10, fontWeight: 600, color: "#8B5CF6", fontFamily: "'JetBrains Mono', monospace" }}>
              @{msgInfo.recipient}
            </span>
          )}
          {typeLabel && (
            <span style={{ fontSize: 9, color: "#666", padding: "1px 4px", borderRadius: 3, background: "#8B5CF615" }}>
              {typeLabel}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 8, color: "#555555", fontFamily: "'JetBrains Mono', monospace" }}>
            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        {preview && (
          <div style={{
            padding: "4px 10px 6px", fontSize: 11, color: "#999", lineHeight: 1.5,
            background: isRunning ? "#0D0B18" : "#0A0A0F",
            overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
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
        gap: 8, padding: "6px 10px", height: 30, borderRadius: 6,
        background: isRunning ? toolInfo.activeBg : (isError ? "#EF444408" : "#10B98108"),
        border: isRunning ? `1px solid ${toolInfo.activeBorder}` : "none",
      }}
    >
      {isRunning && <Loader2 size={11} className="animate-spin" style={{ color: toolInfo.color, flexShrink: 0 }} />}
      {isCompleted && <Check size={11} style={{ color: "#10B981", flexShrink: 0 }} />}
      {isError && <AlertCircle size={11} style={{ color: "#EF4444", flexShrink: 0 }} />}
      <toolInfo.Icon size={12} style={{ color: isRunning ? toolInfo.color : (isError ? "#EF4444" : "#10B981"), flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 500, color: isRunning ? toolInfo.color : (isError ? "#EF4444" : "#10B981") }}>{toolName}</span>
      {filePath && (
        <span style={{ fontSize: 10, color: isRunning ? toolInfo.pathColor : "#666666", fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {filePath}
        </span>
      )}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 8, color: "#555555", fontFamily: "'JetBrains Mono', monospace" }}>
        {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </div>
  );
}

function LogEntryToolResult({ entry }: { readonly entry: AgentLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const success = entry.metadata?.success !== false;
  const toolName = (entry.metadata?.toolName as string) ?? "";
  const result = entry.content;

  // SendMessage — compact delivery status instead of collapsible JSON
  if (toolName === "SendMessage") {
    let statusMsg = "";
    try {
      const parsed = JSON.parse(result.trim());
      if (success) {
        statusMsg = parsed.message ?? "delivered";
      } else {
        statusMsg = parsed.error ?? parsed.message ?? "failed";
      }
    } catch {
      statusMsg = success ? "delivered" : (result.trim().slice(0, 40) || "failed");
    }
    return (
      <div
        className="flex items-center"
        style={{
          gap: 6, padding: "4px 10px", borderRadius: 6,
          background: success ? "#10B98108" : "#EF444408",
        }}
      >
        <Send size={11} style={{ color: success ? "#10B981" : "#EF4444", flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 500, color: success ? "#10B981" : "#EF4444" }}>
          {statusMsg}
        </span>
      </div>
    );
  }

  // Derive a short preview for the collapsed state
  const preview = deriveResultPreview(toolName, result);

  return (
    <div style={{ borderRadius: 6, overflow: "hidden" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center"
        style={{
          width: "100%", gap: 8, padding: "6px 10px",
          minHeight: 30,
          background: success ? "#10B98108" : "#EF444408",
          border: "none", cursor: "pointer", textAlign: "left",
        }}
      >
        {success
          ? <Check size={11} style={{ color: "#10B981", flexShrink: 0 }} />
          : <AlertCircle size={11} style={{ color: "#EF4444", flexShrink: 0 }} />}
        <span style={{ fontSize: 11, fontWeight: 500, color: success ? "#10B981" : "#EF4444", flexShrink: 0 }}>
          {toolName || "Result"}
        </span>
        {preview && (
          <span style={{ fontSize: 10, color: "#666666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {preview}
          </span>
        )}
        <div style={{ flex: preview ? 0 : 1 }} />
        {expanded
          ? <ChevronDown size={11} style={{ color: "#555555", flexShrink: 0 }} />
          : <ChevronRight size={11} style={{ color: "#555555", flexShrink: 0 }} />}
      </button>
      {expanded && result && (
        <div
          style={{
            padding: "8px 12px", fontSize: 11, color: "#999999",
            fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.5,
            background: "#0A0A0F", maxHeight: 200, overflowY: "auto",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}
        >
          {formatResultContent(result)}
        </div>
      )}
    </div>
  );
}

/** Derive a short preview string for tool results. */
function deriveResultPreview(toolName: string, result: string): string {
  if (!result) return "";
  const trimmed = result.trim();

  // For Read/Grep/Glob — show line count or match summary
  if (toolName === "Read") {
    const lineCount = trimmed.split("\n").length;
    return `${lineCount} lines`;
  }
  if (toolName === "Grep") {
    const matchCount = trimmed.split("\n").filter((l) => l.trim()).length;
    return `${matchCount} matches`;
  }
  if (toolName === "Bash") {
    const firstLine = trimmed.split("\n")[0];
    return firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
  }
  if (toolName === "Edit" || toolName === "Write") {
    return "saved";
  }
  if (toolName === "SendMessage") {
    // Parse the result to show delivery status
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.success) return "delivered";
      if (parsed.error) return parsed.error.slice(0, 40);
    } catch {
      // Not JSON — show first line
    }
    return trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed;
  }
  if (toolName === "Task") {
    // Extract meaningful text from task result
    if (trimmed.length > 60) {
      const last = trimmed.split("\n").filter((l) => l.trim()).pop() ?? "";
      return last.length > 50 ? last.slice(0, 47) + "..." : last;
    }
    return trimmed.length > 50 ? trimmed.slice(0, 47) + "..." : trimmed;
  }

  return trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed;
}

/** Format the expanded result content — pretty-print JSON if applicable. */
function formatResultContent(result: string): string {
  const trimmed = result.trim();
  // Try to pretty-print JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2).slice(0, 3000);
    } catch {
      // Not valid JSON, show as-is
    }
  }
  return trimmed.slice(0, 3000);
}

function LogEntryThinking({ entry }: { readonly entry: AgentLogEntry }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ borderRadius: 6 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center"
        style={{
          width: "100%", gap: 6, padding: "4px 10px",
          background: "transparent", border: "none", cursor: "pointer", textAlign: "left",
        }}
      >
        <Info size={10} style={{ color: "#555555", flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontStyle: "italic", color: "#555555" }}>
          Thinking...
        </span>
        {expanded
          ? <ChevronDown size={10} style={{ color: "#444444" }} />
          : <ChevronRight size={10} style={{ color: "#444444" }} />}
      </button>
      {expanded && (
        <div
          style={{
            padding: "6px 12px", fontSize: 11, color: "#666666",
            fontStyle: "italic", lineHeight: 1.5, maxHeight: 150, overflowY: "auto",
          }}
        >
          {entry.content}
        </div>
      )}
    </div>
  );
}

function LogEntryStatusChange({ entry }: { readonly entry: AgentLogEntry }) {
  return (
    <div className="flex items-center" style={{ gap: 6, padding: "2px 0" }}>
      <div style={{ width: 4, height: 4, borderRadius: 2, background: "#444444" }} />
      <span style={{ fontSize: 9, color: "#555555", fontFamily: "Inter, sans-serif" }}>
        {entry.content}
      </span>
      <span style={{ fontSize: 8, color: "#444444", fontFamily: "'JetBrains Mono', monospace" }}>
        {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

function LogEntryUserMessage({ entry }: { readonly entry: AgentLogEntry }) {
  return (
    <div
      style={{
        padding: "8px 12px", borderRadius: 8,
        background: "rgba(var(--theme-accent-rgb),0.063)", borderLeft: "3px solid #A855F7",
      }}
    >
      <div className="flex items-center" style={{ gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "#A855F7", fontFamily: "'JetBrains Mono', monospace" }}>You</span>
        <span style={{ fontSize: 8, color: "#555555", fontFamily: "'JetBrains Mono', monospace" }}>
          {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#DDDDDD", lineHeight: 1.6, fontFamily: "Inter, sans-serif" }}>
        {entry.content}
      </div>
    </div>
  );
}

function LogEntryRow({ entry, toolOperations }: { readonly entry: AgentLogEntry; readonly toolOperations?: ReadonlyArray<import("@/stores").AgentToolOperation> }) {
  switch (entry.type) {
    case "text":
      return <LogEntryText entry={entry} />;
    case "tool_start":
      return <LogEntryToolStart entry={entry} toolOperations={toolOperations} />;
    case "tool_result":
      return <LogEntryToolResult entry={entry} />;
    case "thinking":
      return <LogEntryThinking entry={entry} />;
    case "status_change":
      return <LogEntryStatusChange entry={entry} />;
    case "user_message":
      return <LogEntryUserMessage entry={entry} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Tool grouping — collapse consecutive tool entries to reduce scrolling
// ---------------------------------------------------------------------------

interface LogGroup {
  readonly type: "single" | "tool_group";
  readonly entries: ReadonlyArray<AgentLogEntry>;
}

/** Group consecutive tool_start/tool_result log entries together.
 *  Groups with 3+ entries (i.e. 2+ tool operations) are collapsible. */
function groupLogEntries(entries: ReadonlyArray<AgentLogEntry>): ReadonlyArray<LogGroup> {
  const groups: LogGroup[] = [];
  let toolBuffer: AgentLogEntry[] = [];

  const flushToolBuffer = () => {
    if (toolBuffer.length === 0) return;
    // If ≤ 2 tool entries (1 operation = start+result), show inline
    if (toolBuffer.length <= 2) {
      for (const e of toolBuffer) {
        groups.push({ type: "single", entries: [e] });
      }
    } else {
      groups.push({ type: "tool_group", entries: [...toolBuffer] });
    }
    toolBuffer = [];
  };

  for (const entry of entries) {
    if (entry.type === "tool_start" || entry.type === "tool_result") {
      toolBuffer.push(entry);
    } else {
      flushToolBuffer();
      groups.push({ type: "single", entries: [entry] });
    }
  }
  flushToolBuffer();
  return groups;
}

/** Summarize a group of tool entries. Returns e.g. "5 operations (3 Read, 1 Edit, 1 Bash)" */
function summarizeToolGroup(entries: ReadonlyArray<AgentLogEntry>): { opCount: number; summary: string; allDone: boolean; hasError: boolean } {
  const counts = new Map<string, number>();
  let opCount = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const e of entries) {
    if (e.type === "tool_start") {
      const name = (e.metadata?.toolName as string) ?? "Tool";
      counts.set(name, (counts.get(name) ?? 0) + 1);
      opCount++;
    }
    if (e.type === "tool_result") {
      if (e.metadata?.success === false) errorCount++;
      else successCount++;
    }
  }

  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");

  return {
    opCount,
    summary: parts,
    allDone: (successCount + errorCount) >= opCount,
    hasError: errorCount > 0,
  };
}

function ToolGroupBlock({
  entries,
  toolOperations,
}: {
  readonly entries: ReadonlyArray<AgentLogEntry>;
  readonly toolOperations?: ReadonlyArray<import("@/stores").AgentToolOperation>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { opCount, summary, allDone, hasError } = summarizeToolGroup(entries);
  // Auto-expand if the last entry is still running (i.e. the group is in-progress)
  const lastIsStart = entries.length > 0 && entries[entries.length - 1].type === "tool_start";

  return (
    <div style={{ borderRadius: 6, overflow: "hidden" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center"
        style={{
          width: "100%", gap: 8, padding: "6px 10px",
          minHeight: 30, borderRadius: 6,
          background: allDone
            ? (hasError ? "#EF444408" : "#10B98108")
            : "#F59E0B08",
          border: allDone ? "none" : "1px solid #F59E0B15",
          cursor: "pointer", textAlign: "left",
        }}
      >
        {allDone && !hasError && <Check size={11} style={{ color: "#10B981", flexShrink: 0 }} />}
        {allDone && hasError && <AlertCircle size={11} style={{ color: "#EF4444", flexShrink: 0 }} />}
        {!allDone && <Loader2 size={11} className="animate-spin" style={{ color: "#F59E0B", flexShrink: 0 }} />}
        <span style={{
          fontSize: 11, fontWeight: 600, flexShrink: 0,
          color: allDone ? (hasError ? "#EF4444" : "#10B981") : "#F59E0B",
        }}>
          {opCount} operations
        </span>
        <span style={{ fontSize: 10, color: "#666666", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
          {summary}
        </span>
        {expanded
          ? <ChevronDown size={11} style={{ color: "#555555", flexShrink: 0 }} />
          : <ChevronRight size={11} style={{ color: "#555555", flexShrink: 0 }} />}
      </button>
      {(expanded || lastIsStart) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "4px 0 0 0" }}>
          {entries.map((entry, idx) => (
            <LogEntryRow
              key={`${entry.type}-${entry.timestamp}-${idx}`}
              entry={entry}
              toolOperations={toolOperations}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentDetailPanel
// ---------------------------------------------------------------------------

export function AgentDetailPanel({
  agentName,
  onClose,
}: {
  readonly agentName: string;
  readonly onClose: () => void;
}) {
  const agent = useTeamsStore((s) => s.session?.agentStates[agentName]);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent?.logEntries.length, agent?.textDelta]);

  if (!agent) {
    return (
      <div className="flex items-center justify-center" style={{ flex: 1, color: "#555555", fontSize: 12 }}>
        Agent not found
      </div>
    );
  }

  const role = agent.role as AgentRole;
  const theme = CARD_THEME[role] ?? CARD_THEME.coder;
  const meta = ROLE_META[role];
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const RoleIcon = ROLE_ICON[role] ?? Code;
  const statusLabel = agent.status === "active" ? getActiveLabel(role) : statusCfg.label;

  return (
    <div
      className="flex flex-col"
      style={{
        width: 380, height: "100%", background: "#111118",
        borderLeft: "1px solid #1E1E2E", overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center shrink-0"
        style={{
          height: 56, padding: "0 16px", gap: 10,
          borderBottom: `1px solid ${theme.accent}20`,
          background: theme.accent + "06",
        }}
      >
        <div
          className="flex items-center justify-center shrink-0"
          style={{ width: 32, height: 32, borderRadius: 16, background: theme.avatarBg }}
        >
          <RoleIcon size={16} style={{ color: theme.accent }} />
        </div>
        <div className="flex flex-col flex-1 min-w-0" style={{ gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#E0E0E0", fontFamily: "'JetBrains Mono', monospace" }}>
            {agent.name}
          </span>
          <div className="flex items-center" style={{ gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 500, color: theme.accent }}>{meta.label}</span>
            <div className="flex items-center" style={{ gap: 3, padding: "1px 6px", borderRadius: 8, background: statusCfg.color + "18" }}>
              <div style={{ width: 5, height: 5, borderRadius: 3, background: statusCfg.color, boxShadow: statusCfg.glow ? `0 0 4px ${statusCfg.color}60` : "none" }} />
              <span style={{ fontSize: 8, fontWeight: 600, color: statusCfg.color, fontFamily: "'JetBrains Mono', monospace" }}>
                {statusLabel}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex items-center justify-center shrink-0"
          style={{ width: 28, height: 28, borderRadius: 6, background: "transparent", border: "none", cursor: "pointer" }}
        >
          <X size={14} style={{ color: "#777777" }} />
        </button>
      </div>

      {/* Log body — scrollable */}
      <div
        ref={logRef}
        className="agent-card-body"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}
      >
        {agent.logEntries.length === 0 && (
          <div style={{ fontSize: 11, color: "#555555", fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>
            No activity yet
          </div>
        )}
        {groupLogEntries(agent.logEntries).map((group, gIdx) =>
          group.type === "tool_group" ? (
            <ToolGroupBlock
              key={`tg-${group.entries[0].timestamp}-${gIdx}`}
              entries={group.entries}
              toolOperations={agent.toolOperations}
            />
          ) : (
            <LogEntryRow
              key={`${group.entries[0].type}-${group.entries[0].timestamp}-${gIdx}`}
              entry={group.entries[0]}
              toolOperations={agent.toolOperations}
            />
          ),
        )}
      </div>

    </div>
  );
}
