import { afterEach, describe, expect, it } from "vitest";
import { buildPermissionConfig, pendingAskUserQuestions, pendingConfirmations } from "../permissions.js";

const LOW_RISK_TASK_TOOLS = [
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
] as const;

const HIGH_IMPACT_TOOLS = [
  "Workflow",
  "CronCreate",
  "CronDelete",
  "ScheduleWakeup",
  "PushNotification",
  "Monitor",
  "REPL",
  "RemoteTrigger",
] as const;

afterEach(() => {
  pendingConfirmations.clear();
  pendingAskUserQuestions.clear();
});

describe("Claude tool permission policy", () => {
  it("allows all low-risk Task tracker tools in default mode", async () => {
    for (const toolName of LOW_RISK_TASK_TOOLS) {
      const emitted: object[] = [];
      const config = buildPermissionConfig("default", "req-1", (evt) => emitted.push(evt));
      const result = await config.canUseTool?.(
        toolName,
        { subject: "Plan", description: "Plan work", taskId: "task-1" },
        { toolUseID: `tu-${toolName}`, signal: new AbortController().signal },
      );

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: { subject: "Plan", description: "Plan work", taskId: "task-1" },
      });
      expect(emitted).toEqual([]);
    }
  });

  it("requests confirmation for every high-impact tool in default, plan, and acceptEdits modes", async () => {
    for (const mode of ["default", "plan", "acceptEdits"]) {
      for (const toolName of HIGH_IMPACT_TOOLS) {
        const emitted: Array<Record<string, unknown>> = [];
        const config = buildPermissionConfig(mode, `req-${mode}`, (evt) => {
          emitted.push(evt as Record<string, unknown>);
        });

        const pending = config.canUseTool?.(
          toolName,
          { name: "release" },
          { toolUseID: `tu-${mode}-${toolName}`, signal: new AbortController().signal },
        );

        await Promise.resolve();

        expect(emitted[0]).toMatchObject({
          evt: "permission_request",
          id: `req-${mode}`,
          toolCallId: `tu-${mode}-${toolName}`,
          toolName,
        });

        const confirmId = emitted[0]?.confirmId as string;
        pendingConfirmations.get(confirmId)?.resolve(true);

        await expect(pending).resolves.toEqual({
          behavior: "allow",
          updatedInput: { name: "release" },
        });
      }
    }
  });

  it("does not enable dangerous bypass unless bypassPermissions mode is selected", () => {
    for (const mode of ["default", "plan", "acceptEdits"]) {
      const config = buildPermissionConfig(mode, "req-safe", () => {});
      expect(config.allowDangerouslySkipPermissions).toBeUndefined();
    }

    const bypassConfig = buildPermissionConfig("bypassPermissions", "req-bypass", () => {});
    expect(bypassConfig.permissionMode).toBe("bypassPermissions");
    expect(bypassConfig.allowDangerouslySkipPermissions).toBe(true);
  });

  it("maps legacy auto mode to safe default rather than dangerous bypass", () => {
    const config = buildPermissionConfig("auto", "req-auto", () => {});
    expect(config.permissionMode).toBe("default");
    expect(config.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("intercepts AskUserQuestion and ExitPlanMode through UI confirmation", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const config = buildPermissionConfig("acceptEdits", "req-ui", (evt) => {
      emitted.push(evt as Record<string, unknown>);
    });

    const askPending = config.canUseTool?.(
      "AskUserQuestion",
      {
        questions: [{
          question: "Continue?",
          header: "Confirm",
          options: [{ label: "Yes", description: "Proceed" }],
        }],
      },
      { toolUseID: "tu-ask", signal: new AbortController().signal },
    );
    await Promise.resolve();
    expect(emitted[0]).toMatchObject({
      evt: "ask_user_question",
      id: "req-ui",
      toolCallId: "tu-ask",
    });
    pendingAskUserQuestions.get(emitted[0]?.confirmId as string)?.resolve({ answer: "Yes" });
    await expect(askPending).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { answer: "Yes" } },
    });

    const exitPending = config.canUseTool?.(
      "ExitPlanMode",
      { plan: "Ship it" },
      { toolUseID: "tu-exit", signal: new AbortController().signal },
    );
    await Promise.resolve();
    expect(emitted[1]).toMatchObject({
      evt: "permission_request",
      id: "req-ui",
      toolCallId: "tu-exit",
      toolName: "ExitPlanMode",
    });
    pendingConfirmations.get(emitted[1]?.confirmId as string)?.resolve(true);
    await expect(exitPending).resolves.toEqual({
      behavior: "allow",
      updatedInput: { plan: "Ship it" },
    });
  });
});
