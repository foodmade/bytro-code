import { describe, expect, it } from "vitest";
import {
  extractSingleFileDiff,
  getDiffFilePath,
  parseGitDiffHeader,
  parsePatchPathLine,
  splitDiffWithPaths,
} from "../diff-utils";

describe("diff-utils", () => {
  it("parses quoted git diff headers for added files", () => {
    expect(parseGitDiffHeader('diff --git "a/src/new file.ts" "b/src/new file.ts"')).toEqual({
      a: "src/new file.ts",
      b: "src/new file.ts",
    });
  });

  it("parses quoted patch path lines", () => {
    expect(parsePatchPathLine('+++ "b/src/new file.ts"')).toBe("src/new file.ts");
    expect(parsePatchPathLine("--- /dev/null")).toBe("/dev/null");
  });

  it("resolves file paths for quoted added-file diffs", () => {
    const diff = [
      'diff --git "a/src/new file.ts" "b/src/new file.ts"',
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      '+++ "b/src/new file.ts"',
      "@@ -0,0 +1,2 @@",
      "+export const a = 1;",
      "+export const b = 2;",
    ].join("\n");

    expect(getDiffFilePath(diff)).toBe("src/new file.ts");
    expect(splitDiffWithPaths(diff)).toEqual([{ filePath: "src/new file.ts", diff }]);
    expect(extractSingleFileDiff(diff, "src/new file.ts")).toBe(diff);
  });

  it("falls back to patch lines when diff header is absent", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/src/created.ts",
      "@@ -0,0 +1,1 @@",
      "+export const created = true;",
    ].join("\n");

    expect(getDiffFilePath(diff)).toBe("src/created.ts");
    expect(splitDiffWithPaths(diff)).toEqual([{ filePath: "src/created.ts", diff }]);
    expect(extractSingleFileDiff(diff, "src/created.ts")).toBe(diff);
  });
});
