import { describe, expect, it, vi } from "vitest";
import { handleClaudeInit } from "../claude-handler.js";
import type { InitSessionCommand } from "../protocol.js";

describe("Claude community initialization", () => {
  it("completes without spawning a CLI, model request, or MCP server", async () => {
    const emit = vi.fn();
    const controllers = new Map<string, AbortController>([
      ["init-1", new AbortController()],
    ]);
    const cmd = {
      cmd: "init_session",
      id: "init-1",
      agent: "claude",
      cwd: "/tmp",
      model: "claude-test",
      apiKey: "sentinel-provider-key",
      mcpServers: {
        sentinel: {
          command: "/definitely/missing/should-never-spawn",
        },
      },
    } as unknown as InitSessionCommand;

    await handleClaudeInit(cmd, emit, controllers);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ evt: "done", id: "init-1" });
    expect(controllers.has("init-1")).toBe(false);
  });
});
