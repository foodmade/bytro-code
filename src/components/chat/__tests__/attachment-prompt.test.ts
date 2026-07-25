import { describe, expect, it } from "vitest";
import { buildAttachedFilesPromptParts } from "@/components/chat/attachment-prompt";

describe("buildAttachedFilesPromptParts", () => {
  it("uses only a file-ref marker for dropped files with absolute paths", () => {
    const parts = buildAttachedFilesPromptParts([
      {
        name: "design.md",
        path: "/Users/tester/project/design.md",
      },
    ]);

    expect(parts.promptPrefix).toBe('<file-ref path="/Users/tester/project/design.md" kind="file"/>');
    expect(parts.displayPrefix).toBe('<file-ref path="/Users/tester/project/design.md" kind="file"/>');
  });

  it("keeps file picker attachments inline when no path is available", () => {
    const parts = buildAttachedFilesPromptParts([
      {
        name: "design.md",
        content: "Build this page",
      },
    ]);

    expect(parts.promptPrefix).toBe('<file path="design.md">\nBuild this page\n</file>');
    expect(parts.displayPrefix).toBe('<file-ref path="design.md" kind="file"/>');
  });

  it("marks pasted text attachments so sent messages can render them distinctly", () => {
    const parts = buildAttachedFilesPromptParts([
      {
        name: "pasted-text-1.txt",
        content: "import { memo } from \"react\";",
        source: "pasted-text",
      },
    ]);

    expect(parts.promptPrefix).toBe('<file path="pasted-text-1.txt" source="pasted-text">\nimport { memo } from "react";\n</file>');
    expect(parts.displayPrefix).toBe('<file-ref path="pasted-text-1.txt" kind="file" source="pasted-text"/>');
  });
});
