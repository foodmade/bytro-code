import { describe, expect, it } from "vitest";
import { formatChatError } from "../stream-handlers/system-handlers";
import i18n from "@/i18n/config";

describe("formatChatError", () => {
  it("returns model-not-found guidance without preserving the provider body", () => {
    const raw = "api_error_status=404 type=model_not_found model claude-nope";

    expect(formatChatError(raw)).toBe(i18n.t("chat.errors.modelNotFound"));
  });

  it("reduces unknown paths, prompts, and tokens to a fixed category", () => {
    const sentinels = [
      "/Users/private/project",
      "opaque-token-Z9x7Q2",
      "write the unreleased acquisition memo",
    ];
    const raw = sentinels.join(" ");

    expect(formatChatError(raw)).toBe("Provider request failed");
    for (const sentinel of sentinels) {
      expect(formatChatError(raw)).not.toContain(sentinel);
    }
  });

  it("preserves only actionable status and a bounded diagnostic ID", () => {
    const raw =
      "authentication failed provider body (diagnosticId: abcdef123456) /private/path";

    expect(formatChatError(raw, 401)).toBe(
      "Provider authentication failed (HTTP 401) (diagnosticId: abcdef123456)",
    );
  });
});
