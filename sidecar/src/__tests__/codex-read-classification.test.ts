import { describe, expect, it } from "vitest";
import { __testing__ } from "../openai-handler.js";

describe("codex read classification", () => {
  it("normalizes Codex MCP tool names into the shared frontend format", () => {
    expect(
      __testing__.normalizeMcpToolName("docs", "get_current_page"),
    ).toBe("mcp__docs__get_current_page");
  });

  it("maps a simple sed read to a single Read tool with inclusive range", () => {
    const descriptor = __testing__.parseReadCommandDescriptor(
      'sed -n "10,20p" bytro/src/components/chat/tool-renderers/tool-renderer-registry.ts',
    );

    expect(descriptor).not.toBeNull();
    expect(JSON.parse(descriptor!.toolInput)).toEqual({
      file_path: "bytro/src/components/chat/tool-renderers/tool-renderer-registry.ts",
      offset: 10,
      limit: 11,
    });
  });

  it("maps an exact nl|sed read to Read", () => {
    const entries = __testing__.getCommandToolEntries(
      'nl -ba bytro/src/components/chat/tool-renderers/tool-renderer-registry.ts | sed -n "10,20p"',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolName).toBe("Read");
    expect(JSON.parse(entries[0]!.toolInput)).toEqual({
      file_path: "bytro/src/components/chat/tool-renderers/tool-renderer-registry.ts",
      offset: 10,
      limit: 11,
    });
  });

  it("marks non-zero Bash output as warning display metadata", () => {
    expect(
      __testing__.getCodexToolResultDisplay("Bash", false, "FAIL src/foo.test.ts > example"),
    ).toEqual({
      status: "warning",
      severity: "warning",
      reason: "non_zero_exit_with_output",
    });
  });

  it("maps cat commands to Read cards", () => {
    const entries = __testing__.getCommandToolEntries(
      'cat bytro/src/stores/chat-store.ts',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolName).toBe("Read");
    expect(JSON.parse(entries[0]!.toolInput)).toEqual({
      file_path: "bytro/src/stores/chat-store.ts",
    });
  });

  it("maps Get-Content commands to Read cards", () => {
    const entries = __testing__.getCommandToolEntries(
      'Get-Content -Path bytro/src/stores/chat-store.ts -TotalCount 20',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.toolName).toBe("Read");
    expect(JSON.parse(entries[0]!.toolInput)).toEqual({
      file_path: "bytro/src/stores/chat-store.ts",
      limit: 20,
    });
  });

  it("steers follow-up messages while a Codex turn is active", async () => {
    const channel = new __testing__.CodexSessionChannel();
    let steeredMessage: unknown = null;
    channel.setTurnActive(true, "turn-1", async (msg) => {
      steeredMessage = msg;
    });

    channel.push("next prompt", undefined, "req-2");

    expect(steeredMessage).toMatchObject({ content: "next prompt", requestId: "req-2" });
  });
});

describe("codex reasoning effort", () => {
  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "openai/gpt-5.6-sol"])(
    "preserves native max effort for %s",
    (modelId) => {
      expect(__testing__.mapReasoningEffort("max", undefined, modelId)).toBe("max");
    },
  );

  it("preserves the existing max fallback for older models", () => {
    expect(__testing__.mapReasoningEffort("max", undefined, "gpt-5.5")).toBe("xhigh");
    expect(__testing__.mapReasoningEffort("max", undefined, "gpt-4o")).toBe("high");
  });
});
