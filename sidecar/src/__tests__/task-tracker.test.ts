import { describe, expect, it } from "vitest";
import {
  createTaskTrackerState,
  seedTaskFromStart,
  updateTaskTrackerFromLifecycle,
  updateTaskTrackerFromTool,
  toTodoItems,
} from "../task-tracker.js";
import type { TodoItem } from "../protocol.js";

describe("Task tools → TodoItem accumulator", () => {
  it("aggregates TaskCreate and TaskUpdate into todo_updated snapshots", () => {
    const state = createTaskTrackerState();
    let previous: ReadonlyArray<TodoItem> = [];

    const created = updateTaskTrackerFromTool(
      state,
      previous,
      "TaskCreate",
      {
        subject: "Audit SDK usage",
        description: "Find removed V2 session APIs",
        activeForm: "Auditing SDK usage",
      },
      { task: { id: "task-1", subject: "Audit SDK usage" } },
    );

    expect(created?.todos).toEqual([
      {
        content: "Audit SDK usage",
        status: "pending",
        activeForm: "Auditing SDK usage",
      },
    ]);
    expect(created?.diff).toContainEqual({
      content: "Audit SDK usage",
      changeType: "added",
      newStatus: "pending",
    });

    previous = created?.todos ?? [];
    const updated = updateTaskTrackerFromTool(
      state,
      previous,
      "TaskUpdate",
      { taskId: "task-1", status: "completed" },
      {
        success: true,
        taskId: "task-1",
        updatedFields: ["status"],
        statusChange: { from: "in_progress", to: "completed" },
      },
    );

    expect(updated?.todos[0]?.status).toBe("completed");
    expect(updated?.diff).toContainEqual({
      content: "Audit SDK usage",
      changeType: "status_changed",
      oldStatus: "pending",
      newStatus: "completed",
    });
  });

  it("reconciles TaskList as a full snapshot", () => {
    const state = createTaskTrackerState();
    let previous: ReadonlyArray<TodoItem> = [];

    const first = updateTaskTrackerFromTool(
      state,
      previous,
      "TaskList",
      {},
      JSON.stringify({
        tasks: [
          { id: "a", subject: "One", status: "completed", blockedBy: [] },
          { id: "b", subject: "Two", status: "in_progress", blockedBy: [] },
        ],
      }),
    );
    previous = first?.todos ?? [];

    const second = updateTaskTrackerFromTool(
      state,
      previous,
      "TaskList",
      {},
      { tasks: [{ id: "b", subject: "Two", status: "completed", blockedBy: [] }] },
    );

    expect(toTodoItems(state)).toEqual([
      { content: "Two", status: "completed", activeForm: "Two" },
    ]);
    expect(second?.diff).toContainEqual({
      content: "One",
      changeType: "removed",
      oldStatus: "completed",
    });
    expect(second?.diff).toContainEqual({
      content: "Two",
      changeType: "status_changed",
      oldStatus: "in_progress",
      newStatus: "completed",
    });
  });

  it("handles TaskGet content blocks from hook responses", () => {
    const state = createTaskTrackerState();

    const updated = updateTaskTrackerFromTool(
      state,
      [],
      "TaskGet",
      { taskId: "task-2" },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              task: {
                id: "task-2",
                subject: "Render Task tools",
                description: "Show new task tools in the UI",
                status: "in_progress",
                blocks: [],
                blockedBy: [],
              },
            }),
          },
        ],
      },
    );

    expect(updated?.todos).toEqual([
      {
        content: "Render Task tools",
        status: "in_progress",
        activeForm: "Render Task tools",
      },
    ]);
  });

  it("tracks TaskCreated, task_updated, and TaskCompleted lifecycle events", () => {
    const state = createTaskTrackerState();
    const created = updateTaskTrackerFromLifecycle(
      state,
      [],
      "created",
      {
        task_id: "task-3",
        task_subject: "Verify lifecycle hooks",
        task_description: "Use SDK task lifecycle events as a stable task source",
      },
    );

    expect(created?.todos).toEqual([
      {
        content: "Verify lifecycle hooks",
        status: "pending",
        activeForm: "Verify lifecycle hooks",
      },
    ]);

    const running = updateTaskTrackerFromLifecycle(
      state,
      created?.todos ?? [],
      "updated",
      {
        task_id: "task-3",
        patch: { status: "running" },
      },
    );
    expect(running?.todos[0]?.status).toBe("in_progress");

    const completed = updateTaskTrackerFromLifecycle(
      state,
      running?.todos ?? [],
      "completed",
      {
        task_id: "task-3",
        task_subject: "Verify lifecycle hooks",
      },
    );
    expect(completed?.todos[0]?.status).toBe("completed");
    expect(completed?.diff).toContainEqual({
      content: "Verify lifecycle hooks",
      changeType: "status_changed",
      oldStatus: "in_progress",
      newStatus: "completed",
    });
  });

  it("handles task_updated before TaskCreated and continues diffing from the latest snapshot", () => {
    const state = createTaskTrackerState();

    const fromSystem = updateTaskTrackerFromLifecycle(
      state,
      [],
      "updated",
      {
        task_id: "task-4",
        patch: {
          description: "Wait for a slow MCP server",
          status: "running",
        },
      },
    );

    expect(fromSystem?.todos).toEqual([
      {
        content: "Wait for a slow MCP server",
        status: "in_progress",
        activeForm: "Wait for a slow MCP server",
      },
    ]);
    expect(fromSystem?.diff).toContainEqual({
      content: "Wait for a slow MCP server",
      changeType: "added",
      newStatus: "in_progress",
    });

    const fromTool = updateTaskTrackerFromTool(
      state,
      fromSystem?.todos ?? [],
      "TaskUpdate",
      { taskId: "task-4", subject: "Verify MCP readiness", status: "completed" },
      {
        success: true,
        taskId: "task-4",
        updatedFields: ["subject", "status"],
        statusChange: { from: "in_progress", to: "completed" },
      },
    );

    expect(fromTool?.todos).toEqual([
      {
        content: "Verify MCP readiness",
        status: "completed",
        activeForm: "Wait for a slow MCP server",
      },
    ]);
    expect(fromTool?.diff).toEqual(
      expect.arrayContaining([
        {
          content: "Wait for a slow MCP server",
          changeType: "removed",
          oldStatus: "in_progress",
        },
        {
          content: "Verify MCP readiness",
          changeType: "added",
          newStatus: "completed",
        },
      ]),
    );
    expect(fromTool?.diff).toHaveLength(2);
    expect(fromTool?.diff).not.toContainEqual({
      content: "Wait for a slow MCP server",
      changeType: "added",
      newStatus: "in_progress",
    });
  });

  it("keeps an existing TaskCreated subject when task_updated only patches description", () => {
    const state = createTaskTrackerState();
    const created = updateTaskTrackerFromLifecycle(
      state,
      [],
      "created",
      {
        task_id: "task-5",
        task_subject: "Review MCP startup",
        task_description: "Initial description",
      },
    );

    const updated = updateTaskTrackerFromLifecycle(
      state,
      created?.todos ?? [],
      "updated",
      {
        task_id: "task-5",
        patch: {
          description: "Slow server is still connecting",
          status: "running",
        },
      },
    );

    expect(updated?.todos).toEqual([
      {
        content: "Review MCP startup",
        status: "in_progress",
        activeForm: "Review MCP startup",
      },
    ]);
    expect(updated?.diff).toContainEqual({
      content: "Review MCP startup",
      changeType: "status_changed",
      oldStatus: "pending",
      newStatus: "in_progress",
    });
  });

  it("seeds the subject from task_started so a status-only task_updated keeps a real title", () => {
    const state = createTaskTrackerState();
    // SDK 0.3.170 emits task_started (with a required description) before any
    // task_updated patch. Workflow tasks then get a task_updated whose patch
    // only flips status — without seeding, the subject would fall back to the
    // raw task_id ("bjxyjr6n5").
    seedTaskFromStart(state, "bjxyjr6n5", "Extract fast command definition with call handler");

    const updated = updateTaskTrackerFromLifecycle(
      state,
      [],
      "updated",
      {
        task_id: "bjxyjr6n5",
        patch: { status: "completed" },
      },
    );

    expect(updated?.todos).toEqual([
      {
        content: "Extract fast command definition with call handler",
        status: "completed",
        activeForm: "Extract fast command definition with call handler",
      },
    ]);
  });

  it("seedTaskFromStart never clobbers a subject already captured from a tool", () => {
    const state = createTaskTrackerState();
    updateTaskTrackerFromTool(
      state,
      [],
      "TaskCreate",
      { subject: "Real subject" },
      { task: { id: "task-9", subject: "Real subject" } },
    );

    seedTaskFromStart(state, "task-9", "task_started description should not win");

    expect(toTodoItems(state)).toEqual([
      { content: "Real subject", status: "pending", activeForm: "Real subject" },
    ]);
  });
});
