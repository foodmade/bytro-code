import { describe, it, expect } from "vitest";
import {
  formatConversationPreview,
  formatConversationTitle,
  stripConversationMarkdown,
} from "../conversation-text";

describe("conversation-text", () => {
  it("strips common markdown syntax", () => {
    const input = "## **Doc Summary**\n<file path=\"design.md\">内容\n- item1\n[link](https://example.com)";
    const output = stripConversationMarkdown(input);

    expect(output).toBe("Doc Summary 内容 item1 link");
  });

  it("formats title with fallback", () => {
    expect(formatConversationTitle("### **Hello**")).toBe("Hello");
    expect(formatConversationTitle("   ")).toBe("Untitled conversation");
  });

  it("formats preview and applies max length", () => {
    const preview = formatConversationPreview("**Summary**: `hello` world", 10);
    expect(preview).toBe("Summary: h...");
  });
});
