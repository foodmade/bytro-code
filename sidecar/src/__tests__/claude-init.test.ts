import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleClaudeInit } from "../claude-handler.js";
import type { InitSessionCommand } from "../protocol.js";

describe("Claude community initialization", () => {
  it("matches the formal prewarm flow and emits system_init before done", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bytro-claude-init-"));
    const fakeClaudePath = join(tempDir, "claude");
    writeFileSync(
      fakeClaudePath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  type: 'system',",
        "  subtype: 'init',",
        "  tools: ['Read', 'Write'],",
        "  mcp_servers: [{ name: 'local', status: 'connected' }],",
        "  model: 'claude-test',",
        "  fast_mode_state: 'off',",
        "  slash_commands: ['help', 'compact']",
        "}) + '\\n');",
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    chmodSync(fakeClaudePath, 0o700);

    const emit = vi.fn();
    const controllers = new Map<string, AbortController>();
    const cmd = {
      cmd: "init_session",
      id: "init-1",
      agent: "claude",
      cwd: "/tmp",
      platform: "claude",
      model: "claude-test",
      apiKey: "sentinel-provider-key",
    } as unknown as InitSessionCommand;
    const previousCliPath = process.env.CLAUDE_CLI_PATH;
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CLI_PATH = fakeClaudePath;

    try {
      await handleClaudeInit(cmd, emit, controllers);

      expect(emit.mock.calls).toEqual([
        [
          {
            evt: "system_init",
            id: "init-1",
            tools: ["Read", "Write"],
            mcpServers: [{ name: "local", status: "connected" }],
            model: "claude-test",
            fastModeState: "off",
            slashCommands: [
              { name: "help", description: "" },
              { name: "compact", description: "" },
            ],
          },
        ],
        [{ evt: "done", id: "init-1" }],
      ]);
      expect(controllers.has("init-1")).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBe(previousApiKey);
    } finally {
      if (previousCliPath === undefined) {
        delete process.env.CLAUDE_CLI_PATH;
      } else {
        process.env.CLAUDE_CLI_PATH = previousCliPath;
      }
      if (previousApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousApiKey;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
