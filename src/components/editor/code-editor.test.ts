import { describe, expect, it } from "vitest";
import { isLoadedFileStateForPath, type FileState } from "./code-editor-state";

function fileState(path: string): FileState {
  return {
    path,
    content: `content for ${path}`,
    isDirty: false,
    isLargeFile: false,
  };
}

describe("isLoadedFileStateForPath", () => {
  it("accepts file state only when it belongs to the active file path", () => {
    expect(isLoadedFileStateForPath(fileState("/tmp/a.ts"), "/tmp/a.ts")).toBe(true);
    expect(isLoadedFileStateForPath(fileState("/tmp/a.ts"), "/tmp/b.ts")).toBe(false);
  });

  it("rejects missing paths and empty file state", () => {
    expect(isLoadedFileStateForPath(null, "/tmp/a.ts")).toBe(false);
    expect(isLoadedFileStateForPath(fileState("/tmp/a.ts"), null)).toBe(false);
  });
});
