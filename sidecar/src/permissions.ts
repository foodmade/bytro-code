// ---------------------------------------------------------------------------
// Permission mode intent shared with the local Claude CLI adapter
// ---------------------------------------------------------------------------

import type { CanUseTool, PermissionMode } from "./claude-cli-adapter.js";
import { randomUUID } from "node:crypto";
import type { AskUserQuestionItem } from "./protocol.js";

export interface PermissionConfig {
  readonly permissionMode: PermissionMode;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly canUseTool?: CanUseTool;
}

/**
 * Pending permission requests awaiting Rust-side confirmation.
 * Key: confirmId, Value: { resolve function }
 */
export const pendingConfirmations = new Map<
  string,
  { resolve: (approved: boolean) => void }
>();

/**
 * Pending AskUserQuestion requests awaiting user answers from the frontend.
 * Key: confirmId, Value: { resolve function }
 */
export const pendingAskUserQuestions = new Map<
  string,
  { resolve: (answers: Record<string, string>) => void }
>();

function nextConfirmId(): string {
  return `cfm-${randomUUID()}`;
}

/**
 * Build the permission intent from the protocol mode string.
 *
 * The callback shape is retained for handler compatibility and direct tests.
 * The community CLI adapter cannot bridge an in-process approval callback into
 * Claude's stdio protocol, so it safely maps headless `default` to `dontAsk`.
 * Only an explicit `bypassPermissions` selection enables dangerous bypass.
 *
 * @param mode - protocol permission mode string
 * @param requestId - current request ID for emitting permission_request events
 * @param emitFn - function to send events to Rust via stdout
 */
export function buildPermissionConfig(
  mode: string,
  requestId: string,
  emitFn: (evt: object) => void,
): PermissionConfig {
  const sdkMode = toSdkMode(mode);

  // Compatibility callback for consumers capable of interactive approval.
  const interactiveCanUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === "AskUserQuestion") {
      return requestAskUserQuestion(requestId, options.toolUseID, input, emitFn);
    }
    if (toolName === "ExitPlanMode") {
      return requestExitPlanMode(requestId, options.toolUseID, input, emitFn);
    }
    if (shouldRequestConfirmation(toolName)) {
      return requestUserConfirmation(
        requestId, options.toolUseID, toolName, input, emitFn,
      );
    }
    return { behavior: "allow", updatedInput: input };
  };

  const defaultCanUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === "AskUserQuestion") {
      return requestAskUserQuestion(requestId, options.toolUseID, input, emitFn);
    }
    if (toolName === "ExitPlanMode") {
      return requestExitPlanMode(requestId, options.toolUseID, input, emitFn);
    }
    if (LOW_RISK_TASK_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    // In default mode, prompt user for every other tool as well.
    return requestUserConfirmation(
      requestId, options.toolUseID, toolName, input, emitFn,
    );
  };

  switch (sdkMode) {
    case "bypassPermissions":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool: interactiveCanUseTool,
      };

    case "plan":
      return {
        permissionMode: "plan",
        canUseTool: interactiveCanUseTool,
      };

    case "acceptEdits":
      return {
        permissionMode: "acceptEdits",
        canUseTool: interactiveCanUseTool,
      };

    default:
      // "default" mode: route all tool permission requests through our UI.
      return {
        permissionMode: "default",
        canUseTool: defaultCanUseTool,
      };
  }
}

/** Normalise legacy or unknown mode strings to a safe CLI permission mode. */
function toSdkMode(mode: string): PermissionMode {
  switch (mode) {
    case "bypassPermissions":
      return "bypassPermissions";
    case "auto": // legacy: never imply dangerous bypass
      return "default";
    case "plan":
    case "planning": // legacy
    case "deep": // deep = plan + brainstorming
      return "plan";
    case "acceptEdits":
    case "agent": // legacy
      return "acceptEdits";
    case "default":
    default:
      return "default";
  }
}

const CONFIRMATION_TIMEOUT_MS = 120_000; // 2 minutes

const LOW_RISK_TASK_TOOLS = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
]);

const HIGH_IMPACT_TOOLS = new Set([
  "Workflow",
  "CronCreate",
  "CronDelete",
  "ScheduleWakeup",
  "PushNotification",
  "Monitor",
  "REPL",
  "RemoteTrigger",
]);

function shouldRequestConfirmation(toolName: string): boolean {
  return HIGH_IMPACT_TOOLS.has(toolName);
}

/**
 * Emit a permission_request event and wait for the Rust side to respond
 * via a permission_response command on stdin. Times out after 120 seconds.
 */
async function requestUserConfirmation(
  requestId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  emitFn: (evt: object) => void,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const confirmId = nextConfirmId();

  emitFn({
    evt: "permission_request",
    id: requestId,
    confirmId,
    toolCallId: toolUseId,
    toolName,
    toolInput: JSON.stringify(input),
  });

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(confirmId);
      resolve(false);
    }, CONFIRMATION_TIMEOUT_MS);

    pendingConfirmations.set(confirmId, {
      resolve: (value: boolean) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });

  if (approved) {
    return { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: "User denied tool execution" };
}

const ASK_USER_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Emit an ask_user_question event and wait for the frontend to collect
 * user answers. Returns the updatedInput with answers populated.
 */
async function requestAskUserQuestion(
  requestId: string,
  toolUseId: string,
  input: Record<string, unknown>,
  emitFn: (evt: object) => void,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const confirmId = nextConfirmId();

  // Extract and normalize questions from the tool input — ensure every field
  // has a value so the Rust deserializer never fails on missing keys.
  const rawQuestions = (input.questions ?? []) as ReadonlyArray<Record<string, unknown>>;
  const questions: ReadonlyArray<AskUserQuestionItem> = rawQuestions.map((q) => ({
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : "",
    options: Array.isArray(q.options)
      ? (q.options as ReadonlyArray<Record<string, unknown>>).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : "",
        }))
      : [],
    multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
  }));

  emitFn({
    evt: "ask_user_question",
    id: requestId,
    confirmId,
    toolCallId: toolUseId,
    questions,
  });

  const answers = await new Promise<Record<string, string> | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingAskUserQuestions.delete(confirmId);
      resolve(null); // timeout → deny
    }, ASK_USER_TIMEOUT_MS);

    pendingAskUserQuestions.set(confirmId, {
      resolve: (value: Record<string, string>) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });

  if (answers !== null) {
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  return { behavior: "deny", message: "AskUserQuestion timed out" };
}

const EXIT_PLAN_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Emit a permission_request event for ExitPlanMode and wait for the frontend to confirm.
 * The user sees the plan and decides whether to proceed with implementation.
 * Uses the same event format as requestUserConfirmation so Rust can parse it correctly.
 */
async function requestExitPlanMode(
  requestId: string,
  toolUseId: string,
  input: Record<string, unknown>,
  emitFn: (evt: object) => void,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> {
  const confirmId = nextConfirmId();

  emitFn({
    evt: "permission_request",
    id: requestId,
    confirmId,
    toolCallId: toolUseId,
    toolName: "ExitPlanMode",
    toolInput: JSON.stringify(input),
  });

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(confirmId);
      resolve(false);
    }, EXIT_PLAN_TIMEOUT_MS);

    pendingConfirmations.set(confirmId, {
      resolve: (value: boolean) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
  });

  if (approved) {
    return { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: "User rejected plan mode exit" };
}
