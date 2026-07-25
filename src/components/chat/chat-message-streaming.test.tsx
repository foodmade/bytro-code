import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "./chat-message";
import { findStableStreamingMarkdownBoundary } from "./chat-message-segments";

describe("ChatMessage streaming markdown", () => {
  it("fully renders stable completed code blocks while keeping the live tail segmented", () => {
    const intro = `${"Completed intro paragraph. ".repeat(18)}\n\n`;
    const code = [
      "```tsx",
      "const value = 1;",
      "export function Demo() {",
      "  return value;",
      "}",
      "```",
      "",
      "",
    ].join("\n");
    const stablePrefix = `${intro}${code}`;
    const liveTail = `${"The current paragraph is still streaming. ".repeat(18)}`;
    const content = `${stablePrefix}${liveTail}`;

    expect(findStableStreamingMarkdownBoundary(content)).toBe(stablePrefix.length);

    const html = renderToStaticMarkup(
      <ChatMessage
        role="codex"
        content={content}
        isStreaming
        modelTag="gpt-5.3-codex"
      />,
    );

    expect(html).toContain("streaming-markdown-segment");
    expect(html).toContain("streaming-markdown-tail");
    expect(html).toContain("chat-code-block");
    expect(html).toContain("hljs");
  });
});
