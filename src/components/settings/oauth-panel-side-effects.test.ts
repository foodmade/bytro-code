import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./oauth-panel.tsx", import.meta.url)), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("OAuthPanel usage network side effects", () => {
  it("performs zero usage requests when a signed-in panel mounts", () => {
    const phaseEffect = sourceBetween(
      "// Signing out only clears cached quota state.",
      "const startSignIn = useCallback",
    );

    expect(phaseEffect).not.toContain('phase === "signedIn"');
    expect(phaseEffect).not.toContain("loadUsage()");
    expect(phaseEffect).toContain('phase !== "signedOut"');
    expect(phaseEffect).toContain("clearCachedUsage(provider, profileId)");
  });

  it("performs one usage request from the explicit Refresh action", () => {
    const refreshHandler = sourceBetween(
      "const handleRefresh = useCallback",
      "const handleSignOut = useCallback",
    );

    expect(refreshHandler.match(/loadUsage\(\)/g)).toHaveLength(1);
    expect(refreshHandler).toContain("await loadUsage()");
    expect(source).toContain("onClick={handleRefresh}");
    expect(source.match(/"oauth_get_usage"/g)).toHaveLength(1);
  });
});
