import { describe, expect, it } from "vitest";
import type { McpServerInfo } from "@/stores/chat-store";
import { getMcpStatusSummary } from "../mcp-status-summary";

describe("getMcpStatusSummary", () => {
  it("treats MCP pending states as non-error startup states", () => {
    const servers: ReadonlyArray<McpServerInfo> = [
      { name: "slow-docs", status: "pending" },
      { name: "design", status: "connecting" },
    ];

    const summary = getMcpStatusSummary(servers);

    expect(summary.status).toBe("pending");
    expect(summary.counts.pending).toBe(2);
    expect(summary.counts.failed).toBe(0);
    expect(summary.ariaLabel).toBe("MCP: 2 pending");
    expect(summary.title).toContain("slow-docs: pending");
  });

  it("prioritizes failed servers while preserving skipped and ready counts", () => {
    const servers: ReadonlyArray<McpServerInfo> = [
      { name: "filesystem", status: "ready" },
      { name: "optional", status: "skipped" },
      { name: "broken", status: "failed" },
    ];

    const summary = getMcpStatusSummary(servers);

    expect(summary.status).toBe("failed");
    expect(summary.counts).toEqual({
      ready: 1,
      pending: 0,
      failed: 1,
      skipped: 1,
    });
    expect(summary.ariaLabel).toBe("MCP: 1 ready, 1 failed, 1 skipped");
  });
});
