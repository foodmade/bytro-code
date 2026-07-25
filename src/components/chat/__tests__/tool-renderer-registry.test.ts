import { describe, expect, it } from "vitest";
import { formatInput, getMeta } from "../tool-renderers/tool-renderer-registry";

describe("tool renderer read input formatting", () => {
  it("shows inclusive line ranges for Read tool inputs", () => {
    const formatted = formatInput(
      "Read",
      JSON.stringify({
        file_path: "bytro/src/components/chat/tool-renderers/tool-renderer-registry.ts",
        offset: 10,
        limit: 11,
      }),
    );

    expect(formatted.display).toBe("tool-renderer-registry.ts:10-20");
    expect(formatted.tooltip).toBe("bytro/src/components/chat/tool-renderers/tool-renderer-registry.ts");
  });

  it("uses MCP metadata for normalized MCP tool names", () => {
    const meta = getMeta("mcp__docs__get_current_page");

    expect(meta.label).toBe("docs:get_current_page");
    expect(meta.accentColor).toBe("#06B6D4");
  });

  it("formats empty MCP tool args without noisy fallback text", () => {
    const formatted = formatInput(
      "mcp__docs__get_current_page",
      JSON.stringify({}),
    );

    expect(formatted.display).toBe("");
    expect(formatted.tooltip).toBe("{}");
  });

  it("has metadata and compact summaries for Claude Task tools", () => {
    expect(getMeta("TaskCreate").label).toBe("chat.tools.labels.createTask");
    expect(getMeta("TaskUpdate").label).toBe("chat.tools.labels.updateTask");
    expect(getMeta("TaskGet").label).toBe("chat.tools.labels.getTask");
    expect(getMeta("TaskList").label).toBe("chat.tools.labels.listTasks");

    const createSummary = formatInput("TaskCreate", JSON.stringify({
      subject: "Audit Claude SDK migration",
      description: "Check 0.3.158 compatibility",
    }));
    expect(createSummary.display).toBe("Audit Claude SDK migration");

    const updateSummary = formatInput("TaskUpdate", JSON.stringify({
      taskId: "task-1234567890abcdef",
      status: "completed",
    }));
    expect(updateSummary.display).toBe("task-1234567 → completed");
  });

  it("has metadata for new high-impact Claude tools", () => {
    const highImpactTools = [
      ["Workflow", { name: "release" }, "release"],
      ["CronCreate", { cron: "0 9 * * *", prompt: "Daily report" }, "0 9 * * *"],
      ["CronDelete", { id: "cron-1" }, "cron-1"],
      ["CronList", {}, ""],
      ["ScheduleWakeup", { delaySeconds: 60, reason: "resume" }, "60s · resume"],
      ["Monitor", { description: "watch CI" }, "watch CI"],
      ["PushNotification", { message: "Done" }, "Done"],
      ["REPL", { code: "1 + 1" }, "1 + 1"],
      ["RemoteTrigger", { action: "deploy" }, "deploy"],
    ] as const;

    for (const [toolName, input, expectedDisplay] of highImpactTools) {
      expect(getMeta(toolName).label).toMatch(/^chat\.tools\.labels\./);
      const formatted = formatInput(toolName, JSON.stringify(input));
      expect(formatted.display).toBe(expectedDisplay);
    }
  });
});
