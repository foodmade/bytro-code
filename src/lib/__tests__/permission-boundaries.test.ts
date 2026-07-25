import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = new URL("../../", import.meta.url);

function readSource(path: string): string {
  return readFileSync(new URL(path, SOURCE_ROOT), "utf8");
}

describe("internal agent permission boundaries", () => {
  it.each([
    "hooks/use-teams-chat.ts",
    "hooks/use-health-check.ts",
    "stores/project-memory-store.ts",
  ])("%s inherits the user's current permission mode", (path) => {
    const source = readSource(path);

    expect(source).toContain("usePermissionStore.getState().mode");
    expect(source).not.toMatch(
      /permissionMode\s*:\s*["']bypassPermissions["']/,
    );
  });

  it("preview chat inherits normal chat permissions", () => {
    const previewSource = readSource("components/layout/main-area.tsx");
    const streamingSource = readSource("hooks/use-chat-streaming.ts");

    expect(previewSource).not.toContain("permissionModeOverride:");
    expect(streamingSource).toContain(
      "currentOptions?.permissionModeOverride ?? usePermissionStore.getState().mode",
    );
  });
});
