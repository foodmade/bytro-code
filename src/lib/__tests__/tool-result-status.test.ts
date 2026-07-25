import { describe, expect, it } from "vitest";
import { resolveToolCallFinalStatus } from "../tool-result-status";

describe("resolveToolCallFinalStatus", () => {
  it("prefers explicit display status from sidecar", () => {
    expect(resolveToolCallFinalStatus({ status: "warning", severity: "warning" }, false)).toBe("warning");
  });

  it("falls back to success when no display metadata is present", () => {
    expect(resolveToolCallFinalStatus(undefined, true)).toBe("success");
  });

  it("falls back to error when no display metadata is present", () => {
    expect(resolveToolCallFinalStatus(undefined, false)).toBe("error");
  });
});
