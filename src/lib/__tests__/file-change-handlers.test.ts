import { describe, expect, it } from "vitest";
import { getCompletedTodoMilestones } from "../stream-handlers/file-change-handlers";
import type { TodoDiffEntry } from "../stream-handlers/types";

describe("getCompletedTodoMilestones", () => {
  it("includes tasks that newly enter completed state", () => {
    const diff: ReadonlyArray<TodoDiffEntry> = [
      {
        content: "created completed from TaskList",
        changeType: "added",
        newStatus: "completed",
      },
      {
        content: "updated completed from TaskUpdate",
        changeType: "status_changed",
        oldStatus: "in_progress",
        newStatus: "completed",
      },
      {
        content: "new pending task",
        changeType: "added",
        newStatus: "pending",
      },
      {
        content: "already completed",
        changeType: "unchanged",
        newStatus: "completed",
      },
    ];

    expect(getCompletedTodoMilestones(diff).map((entry) => entry.content)).toEqual([
      "created completed from TaskList",
      "updated completed from TaskUpdate",
    ]);
  });

  it("handles missing or empty diffs", () => {
    expect(getCompletedTodoMilestones(undefined)).toEqual([]);
    expect(getCompletedTodoMilestones([])).toEqual([]);
  });
});
