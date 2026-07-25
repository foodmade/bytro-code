import { describe, expect, it } from "vitest";
import { migratePermissionMode } from "../permission-store";

describe("permission mode migration", () => {
  it("downgrades legacy automatic grants to the interactive default", () => {
    expect(migratePermissionMode("auto", 1)).toBe("default");
    expect(migratePermissionMode("auto", 2)).toBe("default");
    expect(migratePermissionMode("bypassPermissions", 2)).toBe("default");
  });

  it("retains bypass only after the version-three explicit selection boundary", () => {
    expect(migratePermissionMode("bypassPermissions", 3)).toBe("bypassPermissions");
  });
});
