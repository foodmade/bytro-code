import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./git-panel.tsx", import.meta.url)), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("GitPanel network side effects", () => {
  it("does not fetch a remote when the panel mounts", () => {
    const mountEffect = sourceBetween(
      "// Load local data progressively when panel opens",
      "// Auto-refresh when workspace files change",
    );

    expect(mountEffect).not.toContain("fetchRemote");
    expect(mountEffect).not.toContain('"git_fetch"');
  });

  it("keeps remote fetch behind the explicit refresh action", () => {
    const refreshHandler = sourceBetween(
      "const handleRefresh = useCallback",
      "const handleSwitchBranch = useCallback",
    );

    expect(refreshHandler).toContain("await fetchRemote(workspacePath)");
    expect(source.match(/fetchRemote\(workspacePath\)/g)).toHaveLength(1);
    expect(source).toContain("onRefresh={handleRefresh}");
  });
});
