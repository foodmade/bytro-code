import { describe, expect, it } from "vitest";
import { parseUserContent } from "@/components/chat/message-config";

describe("message-config", () => {
  it("parses full file blocks as attachment segments without leaking contents into text", () => {
    const parsed = parseUserContent('Please use <file path="/tmp/demo.ts">\nconst secret = 1;\n</file> now');

    expect(parsed.text).toBe("Please use now");
    expect(parsed.attachments).toEqual([
      {
        kind: "file",
        path: "/tmp/demo.ts",
        content: "const secret = 1;",
      },
    ]);
    expect(parsed.segments.map((segment) => segment.type)).toEqual(["text", "attachment", "text"]);
  });

  it("preserves pasted text attachment source from full blocks and file refs", () => {
    const full = parseUserContent('<file path="pasted-text-1.txt" source="pasted-text">\nhello\n</file>');
    expect(full.attachments[0]).toEqual({
      kind: "file",
      path: "pasted-text-1.txt",
      content: "hello",
      source: "pasted-text",
    });

    const ref = parseUserContent('<file-ref path="pasted-text-1.txt" kind="file" source="pasted-text"/> done');
    expect(ref.attachments[0]).toEqual({
      kind: "file",
      path: "pasted-text-1.txt",
      content: "",
      source: "pasted-text",
    });
    expect(ref.text).toBe("done");
  });
});
