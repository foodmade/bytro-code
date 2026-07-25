import { describe, it, expect } from "vitest";
import {
  buildSegments,
  extractTaskNotices,
  findStableStreamingMarkdownBoundary,
  getVisibleMessageContentLength,
  normalizeMessageContent,
} from "../chat-message-segments";
import type { ToolCall, ThinkingEntry } from "@/stores/chat-store";

function makeTool(id: string, offset?: number): ToolCall {
  return {
    id,
    toolName: `tool_${id}`,
    toolInput: "{}",
    status: "success",
    textOffset: offset,
  };
}

describe("buildSegments", () => {
  it("returns a single text segment when no tool calls", () => {
    const result = buildSegments("Hello world");
    expect(result).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  it("returns empty array for empty content and no tools", () => {
    expect(buildSegments("")).toEqual([]);
    expect(buildSegments("", [])).toEqual([]);
  });

  it("returns text-first then tools when tools have no offsets", () => {
    const tools = [makeTool("1"), makeTool("2")];
    const result = buildSegments("Some text", tools);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: "text", text: "Some text" });
    expect(result[1]).toEqual({ kind: "tools", calls: tools });
  });

  it("returns only tools when content is empty but tools exist", () => {
    const tools = [makeTool("1")];
    const result = buildSegments("", tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "tools", calls: tools });
  });

  it("interleaves text and tools when offsets are provided", () => {
    const content = "Hello, I will search for that. Here are the results.";
    const tools = [makeTool("1", 30)];
    const result = buildSegments(content, tools);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "text", text: "Hello, I will search for that." });
    expect(result[1]).toEqual({ kind: "tools", calls: tools });
    expect(result[2]).toEqual({ kind: "text", text: " Here are the results." });
  });

  it("groups consecutive tool calls at the same offset", () => {
    const tools = [makeTool("1", 5), makeTool("2", 5)];
    const content = "Hello world";
    const result = buildSegments(content, tools);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "text", text: "Hello" });
    expect(result[1]).toEqual({ kind: "tools", calls: tools });
    expect(result[2]).toEqual({ kind: "text", text: " world" });
  });

  it("merges adjacent tools segments when only whitespace sits between offsets", () => {
    const tool1 = makeTool("1", 5);
    const tool2 = makeTool("2", 6);
    const content = "Hello world";
    const result = buildSegments(content, [tool1, tool2]);

    // content[5] is a space — invisible between the two tool groups, so the
    // chain renders as one tools segment instead of fragmenting per offset.
    expect(result).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "tools", calls: [tool1, tool2] },
      { kind: "text", text: "world" },
    ]);
  });

  it("sorts tool calls by offset", () => {
    const tool1 = makeTool("1", 10);
    const tool2 = makeTool("2", 5);
    const content = "AAAA BBBBB CCCC";
    const result = buildSegments(content, [tool1, tool2]);

    // tool2 at offset 5 should come first
    expect(result[0]).toEqual({ kind: "text", text: "AAAA " });
    expect(result[1].kind).toBe("tools");
    if (result[1].kind === "tools") {
      expect(result[1].calls[0].id).toBe("2");
    }
  });

  it("handles tools at offset 0 (start of content)", () => {
    const tools = [makeTool("1", 0)];
    const content = "After tool text";
    const result = buildSegments(content, tools);

    expect(result[0]).toEqual({ kind: "tools", calls: tools });
    expect(result[1]).toEqual({ kind: "text", text: "After tool text" });
  });

  it("interleaves thinking blocks into content segments", () => {
    const thinkingBlocks: ThinkingEntry[] = [
      { text: "summary text", textOffset: 0, complete: true, kind: "summary" },
      { text: "raw text", textOffset: 12, complete: true, kind: "raw" },
    ];

    const normalized = normalizeMessageContent("Final answer", thinkingBlocks);
    const result = buildSegments(normalized.content, [], normalized.thinkingBlocks);

    expect(result).toEqual([
      { kind: "thinking", entry: thinkingBlocks[0], isLastBlock: false },
      { kind: "text", text: "Final answer" },
      { kind: "thinking", entry: thinkingBlocks[1], isLastBlock: true },
    ]);
  });

  it("extracts inline think tags and re-inserts them at the original text position", () => {
    const normalized = normalizeMessageContent(
      "Answer intro<think>reasoning line 1\nreasoning line 2</think>Answer outro",
    );

    expect(normalized.content).toBe("Answer introAnswer outro");
    expect(normalized.thinkingBlocks).toEqual([
      {
        text: "reasoning line 1\nreasoning line 2",
        textOffset: "Answer intro".length,
        complete: true,
      },
    ]);

    const result = buildSegments(normalized.content, [], normalized.thinkingBlocks, normalized.mapOffset);
    expect(result).toEqual([
      { kind: "text", text: "Answer intro" },
      {
        kind: "thinking",
        entry: normalized.thinkingBlocks[0],
        isLastBlock: true,
      },
      { kind: "text", text: "Answer outro" },
    ]);
  });

  it("remaps tool offsets after removing inline think tags", () => {
    const content = "Hello<think>hidden</think> world";
    const normalized = normalizeMessageContent(content);
    const tools = [makeTool("1", content.length)];
    const result = buildSegments(normalized.content, tools, normalized.thinkingBlocks, normalized.mapOffset);

    expect(normalized.content).toBe("Hello world");
    expect(result).toEqual([
      { kind: "text", text: "Hello" },
      {
        kind: "thinking",
        entry: normalized.thinkingBlocks[0],
        isLastBlock: true,
      },
      { kind: "text", text: " world" },
      { kind: "tools", calls: tools },
    ]);
  });

  it("keeps thinking before tools at the same offset", () => {
    const thinkingBlocks: ThinkingEntry[] = [
      { text: "reason first", textOffset: 5, complete: true, kind: "raw" },
    ];
    const tools = [makeTool("1", 5)];

    const result = buildSegments("Hello world", tools, thinkingBlocks);

    expect(result).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "thinking", entry: thinkingBlocks[0], isLastBlock: true },
      { kind: "tools", calls: tools },
      { kind: "text", text: " world" },
    ]);
  });

  it("defers positioned thinking blocks beyond the visible text length", () => {
    const thinkingBlocks: ThinkingEntry[] = [
      { text: "later reasoning", textOffset: 8, complete: true, kind: "raw" },
    ];

    const result = buildSegments("Hello world", [], thinkingBlocks, undefined, 5);

    expect(result).toEqual([
      { kind: "text", text: "Hello" },
    ]);
  });

  it("defers tool calls beyond the visible text length", () => {
    const tool = makeTool("future", 8);
    const result = buildSegments("Hello world", [tool], [], undefined, 5);

    expect(result).toEqual([
      { kind: "text", text: "Hello" },
    ]);
  });

  it("renders positioned items once their offset is visible", () => {
    const tool = makeTool("now", 5);
    const result = buildSegments("Hello world", [tool], [], undefined, 5);

    expect(result).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "tools", calls: [tool] },
    ]);
  });

  it("defers unpositioned trailing tools until the full text is visible", () => {
    const tool = makeTool("tail");
    const partial = buildSegments("Hello world", [tool], [], undefined, 5);
    const full = buildSegments("Hello world", [tool], [], undefined, 11);

    expect(partial).toEqual([
      { kind: "text", text: "Hello" },
    ]);
    expect(full).toEqual([
      { kind: "text", text: "Hello world" },
      { kind: "tools", calls: [tool] },
    ]);
  });
});

describe("task notices", () => {
  const noticeA = "<task-notification>\nCompletion notification received. Agent `angle-a` has completed. Output is available at /tmp/a.output\n</task-notification>";
  const noticeB = "<task-notification>\nCompletion notification received. Agent `angle-b` has completed.\n</task-notification>";

  it("extracts notices with agent names and ranges", () => {
    const content = `Waiting...\n\n${noticeA}\n\n${noticeB}\n\nDone.`;
    const notices = extractTaskNotices(content);

    expect(notices).toHaveLength(2);
    expect(notices[0].agentName).toBe("angle-a");
    expect(notices[1].agentName).toBe("angle-b");
    expect(content.slice(notices[0].start, notices[0].end)).toBe(noticeA);
  });

  it("treats an unterminated notification as extending to the end", () => {
    const content = "Text before <task-notification>\nCompletion notification received. Agent `x` has completed";
    const notices = extractTaskNotices(content);

    expect(notices).toHaveLength(1);
    expect(notices[0].end).toBe(content.length);
    expect(notices[0].agentName).toBe("x");
  });

  it("ignores task-notification patterns inside fenced code blocks", () => {
    // The model may quote the tag in code (e.g. the extraction regex itself);
    // that must render as a normal code block, not be swallowed into a chip.
    const content = [
      "The regex is:",
      "```typescript",
      "const TASK_NOTIFICATION_RE = /<task-notification>([\\s\\S]*?)(?:<\\/task-notification>|$)/g;",
      "```",
      "And that is all.",
    ].join("\n");

    expect(extractTaskNotices(content)).toHaveLength(0);
    expect(buildSegments(content)).toEqual([{ kind: "text", text: content }]);
  });

  it("ignores tags whose body is not a harness notice", () => {
    const content = "Example: <task-notification>anything else here</task-notification> end.";

    expect(extractTaskNotices(content)).toHaveLength(0);
    expect(buildSegments(content)).toEqual([{ kind: "text", text: content }]);
  });

  it("still extracts a real notice that follows a closed code block", () => {
    const content = [
      "```ts",
      "const x = 1;",
      "```",
      "<task-notification>",
      "Completion notification received. Agent `real-agent` has completed.",
      "</task-notification>",
    ].join("\n");

    const notices = extractTaskNotices(content);
    expect(notices).toHaveLength(1);
    expect(notices[0].agentName).toBe("real-agent");
  });

  it("replaces raw notification text with a notices segment", () => {
    const content = `Waiting...\n\n${noticeA}\n\n${noticeB}\n\nDone.`;
    const result = buildSegments(content);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ kind: "text", text: "Waiting...\n\n" });
    expect(result[1].kind).toBe("notices");
    if (result[1].kind === "notices") {
      // Adjacent notices merge into one chip group.
      expect(result[1].notices.map((n) => n.agentName)).toEqual(["angle-a", "angle-b"]);
    }
    expect(result[2]).toEqual({ kind: "text", text: "\n\nDone." });
  });

  it("keeps offset-free trailing tools after notice cutting", () => {
    const content = `Intro ${noticeA} outro`;
    const tools = [makeTool("t1")];
    const result = buildSegments(content, tools);

    expect(result.map((seg) => seg.kind)).toEqual(["text", "notices", "text", "tools"]);
  });
});

describe("getVisibleMessageContentLength", () => {
  it("uses direct source length for ordinary streaming text", () => {
    const content = "Hello world";
    const normalized = normalizeMessageContent(content);

    expect(getVisibleMessageContentLength({
      sourceContent: content,
      visibleSourceContent: "Hello",
      normalized,
      isRevealActive: true,
    })).toBe(5);
  });

  it("maps visible source offsets through removed inline thinking ranges", () => {
    const content = "Hello<think>hidden reasoning</think> world";
    const normalized = normalizeMessageContent(content);

    expect(normalized.content).toBe("Hello world");
    expect(getVisibleMessageContentLength({
      sourceContent: content,
      visibleSourceContent: "Hello<think>hidden",
      normalized,
      isRevealActive: true,
    })).toBe(5);
  });

  it("falls back to partial normalization for JSON content-block messages", () => {
    const content = JSON.stringify([{ type: "text", text: "Resolved answer" }]);
    const normalized = normalizeMessageContent(content);

    expect(normalized.content).toBe("Resolved answer");
    expect(normalized.canMapSourceOffsets).toBe(false);
    expect(getVisibleMessageContentLength({
      sourceContent: content,
      visibleSourceContent: content.slice(0, 8),
      normalized,
      isRevealActive: true,
    })).toBe(8);
  });
});

describe("findStableStreamingMarkdownBoundary", () => {
  it("keeps short streaming markdown as a single live segment", () => {
    expect(findStableStreamingMarkdownBoundary("Short paragraph.\n\nStill growing")).toBe(0);
  });

  it("splits long streaming markdown at a safe paragraph boundary while keeping a live tail", () => {
    const first = `${"First paragraph sentence. ".repeat(15)}\n\n`;
    const second = `${"Second paragraph sentence. ".repeat(15)}\n\n`;
    const liveTail = "Current paragraph is still being streamed.";
    const text = `${first}${second}${liveTail}`;

    expect(findStableStreamingMarkdownBoundary(text)).toBe(first.length);
  });

  it("can split before an unfinished fenced code block without splitting inside it", () => {
    const intro = `${"Intro paragraph sentence. ".repeat(15)}\n\n`;
    const code = "```tsx\n" + "const value = 1;\n".repeat(30);

    expect(findStableStreamingMarkdownBoundary(`${intro}${code}`)).toBe(intro.length);
  });

  it("treats an indented (list-nested) fence as unbalanced so the split stays before it", () => {
    const intro = `${"Intro paragraph sentence. ".repeat(15)}\n\n`;
    // Indented fence (e.g. inside a list item) with blank lines in its body.
    // Without indent-tolerant fence detection the boundary would slip into the
    // still-open code block at one of those blank lines.
    const code = "  ```ts\n" + "const a = 1;\n\nconst b = 2;\n".repeat(20);

    expect(findStableStreamingMarkdownBoundary(`${intro}${code}`)).toBe(intro.length);
  });
});
