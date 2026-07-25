import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import {
  countTextLines,
  findPendingConfirmation,
  getFileConfirmationPreview,
} from "./tool-confirmation-utils";

describe("findPendingConfirmation", () => {
  it("returns the newest pending confirmation across messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "older",
        role: "codex",
        content: "",
        timestamp: 1,
        toolCalls: [
          {
            id: "old-pending",
            toolName: "Bash",
            toolInput: "{}",
            status: "pending_confirmation",
            confirmId: "confirm-old",
          },
        ],
      },
      {
        id: "newer",
        role: "codex",
        content: "",
        timestamp: 2,
        toolCalls: [
          {
            id: "new-pending",
            toolName: "Write",
            toolInput: "{}",
            status: "pending_confirmation",
            confirmId: "confirm-new",
          },
        ],
      },
    ];

    expect(findPendingConfirmation(messages)?.id).toBe("new-pending");
  });

  it("ignores pending calls without a confirmation id", () => {
    const messages: ChatMessage[] = [
      {
        id: "message",
        role: "codex",
        content: "",
        timestamp: 1,
        toolCalls: [
          {
            id: "missing-confirm-id",
            toolName: "Bash",
            toolInput: "{}",
            status: "pending_confirmation",
          },
        ],
      },
    ];

    expect(findPendingConfirmation(messages)).toBeNull();
  });
});

describe("getFileConfirmationPreview", () => {
  it("summarizes Write tools as created files", () => {
    const preview = getFileConfirmationPreview("Write", JSON.stringify({
      file_path: "src/components/Demo.tsx",
      content: "export function Demo() {\n  return null;\n}\n",
    }));

    expect(preview).toMatchObject({
      kind: "created",
      filePath: "src/components/Demo.tsx",
      fileName: "Demo.tsx",
      extension: "tsx",
      added: 4,
      removed: 0,
    });
    expect(preview?.newText).toContain("export function Demo");
  });

  it("summarizes replace tools as edited files", () => {
    const preview = getFileConfirmationPreview("replace", JSON.stringify({
      path: "src/App.css",
      old_string: ".old {\n  color: red;\n}",
      new_string: ".new {\n  color: green;\n}",
    }));

    expect(preview).toMatchObject({
      kind: "edited",
      filePath: "src/App.css",
      fileName: "App.css",
      extension: "css",
      added: 3,
      removed: 3,
    });
    expect(preview?.oldText).toContain(".old");
    expect(preview?.newText).toContain(".new");
  });

  it("summarizes delete tools as deleted files", () => {
    const preview = getFileConfirmationPreview("delete_file", JSON.stringify({
      path: "src/legacy/unused.ts",
    }));

    expect(preview).toMatchObject({
      kind: "deleted",
      filePath: "src/legacy/unused.ts",
      fileName: "unused.ts",
      extension: "ts",
      added: 0,
      removed: 0,
    });
  });

  it("returns null for non-file tools or invalid input", () => {
    expect(getFileConfirmationPreview("Bash", JSON.stringify({ command: "npm test" }))).toBeNull();
    expect(getFileConfirmationPreview("Write", "{not-json")).toBeNull();
  });
});

describe("countTextLines", () => {
  it("handles empty text and Windows newlines", () => {
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("a\r\nb\rc")).toBe(3);
  });
});
