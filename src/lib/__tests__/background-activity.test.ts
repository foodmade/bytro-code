import { describe, expect, it } from "vitest";
import { classifyBackgroundActivity } from "@/lib/background-activity";

describe("classifyBackgroundActivity", () => {
  it("tracks a background Bash task by the ID in its result", () => {
    expect(
      classifyBackgroundActivity({
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "gh run watch 123", run_in_background: true }),
        result:
          "Command running in background with ID: bwk77xjcv. Output is being written to: /tmp/x.output",
        success: true,
      }),
    ).toEqual({ kind: "task", taskId: "bwk77xjcv" });
  });

  it("ignores foreground Bash results", () => {
    expect(
      classifyBackgroundActivity({
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "ls" }),
        result: "file.txt",
        success: true,
      }),
    ).toBeNull();
  });

  it("ignores background Bash whose result carries no task ID", () => {
    expect(
      classifyBackgroundActivity({
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "sleep 5", run_in_background: true }),
        result: "unexpected output",
        success: true,
      }),
    ).toBeNull();
  });

  it("tracks a ScheduleWakeup with its clamped delay", () => {
    expect(
      classifyBackgroundActivity({
        toolName: "ScheduleWakeup",
        toolInput: JSON.stringify({ delaySeconds: 1500, reason: "loop" }),
        result: "Next wakeup scheduled for 23:14:00 (in 1554s).",
        success: true,
      }),
    ).toEqual({ kind: "wakeup", delayMs: 1_500_000 });

    expect(
      classifyBackgroundActivity({
        toolName: "ScheduleWakeup",
        toolInput: JSON.stringify({ delaySeconds: 10 }),
        result: "scheduled",
        success: true,
      }),
    ).toEqual({ kind: "wakeup", delayMs: 60_000 });
  });

  it("ignores failed tool results and malformed input", () => {
    expect(
      classifyBackgroundActivity({
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "x", run_in_background: true }),
        result: "Command running in background with ID: abc",
        success: false,
      }),
    ).toBeNull();
    expect(
      classifyBackgroundActivity({
        toolName: "ScheduleWakeup",
        toolInput: "not-json",
        result: "ok",
        success: true,
      }),
    ).toBeNull();
    expect(
      classifyBackgroundActivity({
        toolName: "Read",
        toolInput: "{}",
        result: "running in background with ID: abc",
        success: true,
      }),
    ).toBeNull();
  });
});
