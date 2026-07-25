import { describe, expect, it } from "vitest";
import { summarizeRpcTraceBody } from "../codex-rpc.js";

describe("Codex RPC trace privacy", () => {
  it("stores metadata instead of request or response bodies", () => {
    const summary = summarizeRpcTraceBody({
      id: 7,
      method: "turn/start",
      params: {
        input: "sentinel raw prompt",
        mcpArgs: { Authorization: "Bearer sentinel-token" },
        answers: { question: "sentinel answer" },
      },
    });

    expect(summary).toContain("event=rpc.body");
    expect(summary).toMatch(/len=\d+ sha256=[a-f0-9]{64}$/);
    expect(summary).not.toContain("sentinel raw prompt");
    expect(summary).not.toContain("sentinel-token");
    expect(summary).not.toContain("sentinel answer");
    expect(summary).not.toContain("turn/start");
  });
});
