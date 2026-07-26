import type { TodoDiffEntry, TodoItem } from "./protocol.js";
import { computeTodoDiff } from "./shared.js";

export type TaskTrackerState = Map<string, TaskTrackerEntry>;

export interface TaskTrackerEntry {
  readonly id: string;
  readonly subject: string;
  readonly description?: string;
  readonly status: string;
  readonly activeForm?: string;
}

export interface TaskTrackerUpdate {
  readonly todos: ReadonlyArray<TodoItem>;
  readonly diff: ReadonlyArray<TodoDiffEntry>;
}

export interface TaskLifecycleInput {
  readonly task_id?: unknown;
  readonly task_subject?: unknown;
  readonly task_description?: unknown;
  readonly status?: unknown;
  readonly patch?: unknown;
}

const TASK_TOOL_NAMES = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
]);

function isTaskTrackerTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.has(toolName);
}

export function createTaskTrackerState(): TaskTrackerState {
  return new Map();
}

export function updateTaskTrackerFromTool(
  state: TaskTrackerState,
  previousTodos: ReadonlyArray<TodoItem>,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  toolResponse: unknown,
): TaskTrackerUpdate | null {
  if (!isTaskTrackerTool(toolName)) return null;

  const before = toTodoItems(state);
  const response = coerceObject(toolResponse);
  let changed = false;

  switch (toolName) {
    case "TaskCreate":
      changed = applyTaskCreate(state, toolInput, response);
      break;
    case "TaskUpdate":
      changed = applyTaskUpdate(state, toolInput, response);
      break;
    case "TaskGet":
      changed = applyTaskGet(state, response);
      break;
    case "TaskList":
      changed = applyTaskList(state, response);
      break;
  }

  const todos = toTodoItems(state);
  const diff = computeTodoDiff(
    previousTodos.length > 0 ? previousTodos : before,
    todos,
  );
  if (!changed || diff.every((entry) => entry.changeType === "unchanged")) {
    return null;
  }
  return { todos, diff };
}

export function updateTaskTrackerFromLifecycle(
  state: TaskTrackerState,
  previousTodos: ReadonlyArray<TodoItem>,
  lifecycle: "created" | "completed" | "updated",
  input: TaskLifecycleInput,
): TaskTrackerUpdate | null {
  const before = toTodoItems(state);
  const id = stringValue(input.task_id);
  if (!id) return null;

  const existing = state.get(id);
  const patch = isRecord(input.patch) ? input.patch : {};
  const rawStatus = stringValue(input.status) || stringAt(patch, "status");
  const patchDescription = stringAt(patch, "description");
  const status = lifecycle === "completed"
    ? "completed"
    : normalizeLifecycleStatus(rawStatus) || existing?.status || "pending";
  const subject = stringValue(input.task_subject)
    || stringAt(patch, "subject")
    || existing?.subject
    || patchDescription
    || id;
  const description = stringValue(input.task_description)
    || patchDescription
    || existing?.description;

  state.set(id, {
    id,
    subject,
    description,
    status,
    activeForm: existing?.activeForm || subject || description || id,
  });

  const todos = toTodoItems(state);
  const diff = computeTodoDiff(
    previousTodos.length > 0 ? previousTodos : before,
    todos,
  );
  if (diff.every((entry) => entry.changeType === "unchanged")) {
    return null;
  }
  return { todos, diff };
}

/**
 * Seed a task's subject from a `task_started` system message.
 *
 * SDK 0.3.170 emits `task_started` with a REQUIRED human-readable `description`
 * before any `task_updated` patch arrives. A later `task_updated` patch usually
 * carries only `status` (no description), so if the task wasn't seeded here the
 * subject would fall back to the raw task_id (e.g. "bjxyjr6n5") when
 * `updateTaskTrackerFromLifecycle` finally registers it.
 *
 * This mutates state in place but does NOT compute a diff or trigger a
 * `todo_updated` emit — it never changes WHICH tasks appear in the panel (that
 * stays driven by task_updated / TaskCreated). It only ensures the title is
 * correct for the tasks that do appear.
 */
export function seedTaskFromStart(
  state: TaskTrackerState,
  taskId: string,
  description: string,
): void {
  if (!taskId || !description) return;
  const existing = state.get(taskId);
  // Don't clobber a real subject already captured (TaskCreate tool / earlier
  // task_started). Only fill in when the task is new or still showing the id.
  if (existing?.subject && existing.subject !== taskId) return;
  state.set(taskId, {
    id: taskId,
    subject: description,
    description: existing?.description ?? description,
    status: existing?.status ?? "pending",
    activeForm: existing?.activeForm ?? description,
  });
}

export function toTodoItems(state: TaskTrackerState): ReadonlyArray<TodoItem> {
  return [...state.values()].map((task) => ({
    content: task.subject || task.description || task.id,
    status: toTodoStatus(task.status),
    activeForm: task.activeForm || task.subject || task.description || task.id,
  }));
}

function applyTaskCreate(
  state: TaskTrackerState,
  input: Record<string, unknown> | undefined,
  response: Record<string, unknown> | null,
): boolean {
  const responseTask = objectAt(response, "task");
  const id = stringAt(responseTask, "id")
    || stringAt(response, "taskId")
    || stringAt(input, "taskId")
    || stringAt(input, "id");
  if (!id) return false;

  const subject = stringAt(input, "subject")
    || stringAt(responseTask, "subject")
    || id;
  const description = stringAt(input, "description")
    || stringAt(responseTask, "description")
    || undefined;
  const activeForm = stringAt(input, "activeForm")
    || stringAt(responseTask, "activeForm")
    || undefined;
  const status = stringAt(input, "status")
    || stringAt(responseTask, "status")
    || "pending";

  state.set(id, { id, subject, description, activeForm, status });
  return true;
}

function applyTaskUpdate(
  state: TaskTrackerState,
  input: Record<string, unknown> | undefined,
  response: Record<string, unknown> | null,
): boolean {
  const id = stringAt(input, "taskId")
    || stringAt(response, "taskId")
    || stringAt(objectAt(response, "task"), "id");
  if (!id) return false;

  const existing = state.get(id);
  const responseTask = objectAt(response, "task");
  const statusChange = objectAt(response, "statusChange");
  const nextStatus = stringAt(input, "status")
    || stringAt(responseTask, "status")
    || stringAt(statusChange, "to")
    || existing?.status
    || "pending";

  if (nextStatus === "deleted") {
    return state.delete(id);
  }

  const subject = stringAt(input, "subject")
    || stringAt(responseTask, "subject")
    || existing?.subject
    || id;
  const description = stringAt(input, "description")
    || stringAt(responseTask, "description")
    || existing?.description;
  const activeForm = stringAt(input, "activeForm")
    || stringAt(responseTask, "activeForm")
    || existing?.activeForm;

  state.set(id, { id, subject, description, activeForm, status: nextStatus });
  return true;
}

function applyTaskGet(
  state: TaskTrackerState,
  response: Record<string, unknown> | null,
): boolean {
  const task = objectAt(response, "task");
  if (!task) return false;
  return upsertTaskFromObject(state, task);
}

function applyTaskList(
  state: TaskTrackerState,
  response: Record<string, unknown> | null,
): boolean {
  const tasks = arrayAt(response, "tasks");
  if (!tasks) return false;

  const next = new Map<string, TaskTrackerEntry>();
  for (const raw of tasks) {
    if (!isRecord(raw)) continue;
    const entry = taskEntryFromObject(raw);
    if (entry) next.set(entry.id, entry);
  }

  state.clear();
  for (const [id, entry] of next) {
    state.set(id, entry);
  }
  return true;
}

function upsertTaskFromObject(
  state: TaskTrackerState,
  raw: Record<string, unknown>,
): boolean {
  const entry = taskEntryFromObject(raw, state.get(stringAt(raw, "id")));
  if (!entry) return false;
  state.set(entry.id, entry);
  return true;
}

function taskEntryFromObject(
  raw: Record<string, unknown>,
  existing?: TaskTrackerEntry,
): TaskTrackerEntry | null {
  const id = stringAt(raw, "id") || stringAt(raw, "taskId") || existing?.id;
  if (!id) return null;
  return {
    id,
    subject: stringAt(raw, "subject") || existing?.subject || id,
    description: stringAt(raw, "description") || existing?.description,
    status: stringAt(raw, "status") || existing?.status || "pending",
    activeForm: stringAt(raw, "activeForm") || existing?.activeForm,
  };
}

function toTodoStatus(status: string): TodoItem["status"] {
  switch (status) {
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "in_progress":
    case "running":
    case "active":
      return "in_progress";
    case "pending":
    default:
      return "pending";
  }
}

function normalizeLifecycleStatus(status: string): string {
  switch (status) {
    case "running":
      return "in_progress";
    case "failed":
    case "killed":
    case "paused":
      return "pending";
    default:
      return status;
  }
}

function coerceObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    const content = value.content;
    const parsedContent = coerceObject(content);
    if (parsedContent) return parsedContent;

    const result = value.result;
    const parsedResult = coerceObject(result);
    if (parsedResult) return parsedResult;

    const text = value.text;
    const parsedText = coerceObject(text);
    if (parsedText) return parsedText;

    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = coerceObject(item);
      if (parsed) return parsed;
    }
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return coerceObject(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  return null;
}

function objectAt(
  obj: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = obj?.[key];
  return isRecord(value) ? value : null;
}

function arrayAt(
  obj: Record<string, unknown> | null | undefined,
  key: string,
): ReadonlyArray<unknown> | null {
  const value = obj?.[key];
  return Array.isArray(value) ? value : null;
}

function stringAt(
  obj: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = obj?.[key];
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
