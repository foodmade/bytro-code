import { describe, it, expect, vi, afterEach } from "vitest";
import { groupByDate } from "@/lib/conversation-utils";
import type { ConversationSummary } from "@/stores/conversation-store";

function makeConv(id: string, updatedAt: string, isPinned = false): ConversationSummary {
  return {
    id,
    title: `Conv ${id}`,
    model: "claude-opus-4-6",
    updated_at: updatedAt,
    message_count: 1,
    preview: "",
    session_id: null,
    workspace_id: null,
    is_pinned: isPinned,
    is_archived: false,
    parent_conversation_id: null,
  };
}

describe("groupByDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty array for empty input", () => {
    expect(groupByDate([])).toEqual([]);
  });

  it("groups conversations into Today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [makeConv("1", "2026-02-10T12:00:00Z")];
    const groups = groupByDate(convs);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("today");
    expect(groups[0].conversations).toHaveLength(1);
  });

  it("groups conversations into yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [makeConv("1", "2026-02-09T12:00:00Z")];
    const groups = groupByDate(convs);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("yesterday");
  });

  it("groups conversations into lastWeek", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [makeConv("1", "2026-02-06T12:00:00Z")];
    const groups = groupByDate(convs);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("lastWeek");
  });

  it("groups conversations into older", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [makeConv("1", "2026-01-01T12:00:00Z")];
    const groups = groupByDate(convs);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("older");
  });

  it("creates multiple groups when conversations span multiple periods", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [
      makeConv("1", "2026-02-10T12:00:00Z"), // today
      makeConv("2", "2026-02-09T12:00:00Z"), // yesterday
      makeConv("3", "2026-02-06T12:00:00Z"), // last 7 days
      makeConv("4", "2026-01-01T12:00:00Z"), // older
    ];
    const groups = groupByDate(convs);

    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.label)).toEqual(["today", "yesterday", "lastWeek", "older"]);
  });

  it("places pinned conversations in a separate group at the top", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [
      makeConv("1", "2026-02-10T12:00:00Z", true),  // pinned
      makeConv("2", "2026-02-10T14:00:00Z"),          // today
      makeConv("3", "2026-01-01T12:00:00Z", true),   // pinned (older date)
      makeConv("4", "2026-02-09T12:00:00Z"),          // yesterday
    ];
    const groups = groupByDate(convs);

    expect(groups[0].label).toBe("pinned");
    expect(groups[0].conversations).toHaveLength(2);
    expect(groups[0].conversations.map((c) => c.id)).toEqual(["1", "3"]);
    expect(groups[1].label).toBe("today");
    expect(groups[2].label).toBe("yesterday");
  });

  it("omits empty groups", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-10T15:00:00Z"));

    const convs = [
      makeConv("1", "2026-02-10T12:00:00Z"), // today
      makeConv("2", "2026-01-01T12:00:00Z"), // older (skip yesterday + last week)
    ];
    const groups = groupByDate(convs);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("today");
    expect(groups[1].label).toBe("older");
  });
});
