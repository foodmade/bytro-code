import type { McpServerInfo } from "@/stores/chat-store";

export type McpAggregateStatus = "none" | "ready" | "pending" | "failed" | "skipped";

export interface McpStatusCounts {
  readonly ready: number;
  readonly pending: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface McpStatusSummary {
  readonly status: McpAggregateStatus;
  readonly title: string;
  readonly ariaLabel: string;
  readonly counts: McpStatusCounts;
}

function normalizeStatus(status: string): Exclude<McpAggregateStatus, "none"> {
  const normalized = status.trim().toLowerCase();
  if (["failed", "failure", "error", "errored", "unavailable"].includes(normalized)) {
    return "failed";
  }
  if (["pending", "connecting", "starting", "initializing", "loading"].includes(normalized)) {
    return "pending";
  }
  if (["skipped", "disabled", "disconnected", "not_connected"].includes(normalized)) {
    return "skipped";
  }
  if (["ready", "connected", "success", "ok"].includes(normalized)) {
    return "ready";
  }
  return "pending";
}

function plural(count: number, label: string): string {
  return `${count} ${label}`;
}

export function getMcpStatusSummary(
  servers: ReadonlyArray<McpServerInfo>,
): McpStatusSummary {
  if (servers.length === 0) {
    return {
      status: "none",
      title: "MCP: no servers",
      ariaLabel: "MCP: no servers",
      counts: { ready: 0, pending: 0, failed: 0, skipped: 0 },
    };
  }

  const counts = servers.reduce<McpStatusCounts>(
    (acc, server) => {
      const status = normalizeStatus(server.status);
      return { ...acc, [status]: acc[status] + 1 };
    },
    { ready: 0, pending: 0, failed: 0, skipped: 0 },
  );

  const status: McpAggregateStatus =
    counts.failed > 0
      ? "failed"
      : counts.pending > 0
        ? "pending"
        : counts.ready > 0
          ? "ready"
          : "skipped";

  const summaryParts = [
    counts.ready > 0 ? plural(counts.ready, "ready") : null,
    counts.pending > 0 ? plural(counts.pending, "pending") : null,
    counts.failed > 0 ? plural(counts.failed, "failed") : null,
    counts.skipped > 0 ? plural(counts.skipped, "skipped") : null,
  ].filter(Boolean);
  const serverDetails = servers
    .slice(0, 5)
    .map((server) => `${server.name}: ${server.status}`);
  if (servers.length > serverDetails.length) {
    serverDetails.push(`+${servers.length - serverDetails.length} more`);
  }

  return {
    status,
    title: `MCP: ${summaryParts.join(", ")}\n${serverDetails.join("\n")}`,
    ariaLabel: `MCP: ${summaryParts.join(", ")}`,
    counts,
  };
}
