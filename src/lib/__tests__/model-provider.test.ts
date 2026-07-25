import { describe, expect, it } from "vitest";
import { createDefaultPlatforms } from "@/lib/platform-config";
import {
  resolveAgentProviderForModel,
  resolveModelSdkForContext,
} from "@/lib/model-provider";

describe("resolveAgentProviderForModel", () => {
  it("uses the provider from an explicitly qualified conversation model", () => {
    expect(
      resolveAgentProviderForModel({
        activePlatformId: "claude",
        platforms: createDefaultPlatforms(),
        conversationModel: "codex:gpt-5.6-sol",
      }),
    ).toBe("codex");
  });

  it.each(["official:gpt-5.4", "gpt-5.4"])(
    "does not infer credentials for legacy model %s",
    (conversationModel) => {
      expect(
        resolveAgentProviderForModel({
          activePlatformId: "claude",
          platforms: createDefaultPlatforms(),
          conversationModel,
        }),
      ).toBeNull();
    },
  );

  it("resolves an explicitly qualified draft model", () => {
    expect(
      resolveAgentProviderForModel({
        activePlatformId: "claude",
        platforms: createDefaultPlatforms(),
        draftPaneModel: { model: "codex:gpt-5.6-sol" },
      }),
    ).toBe("codex");
  });

  it("uses the active local platform when no scoped model exists", () => {
    expect(
      resolveModelSdkForContext({
        activePlatformId: "claude",
        platforms: createDefaultPlatforms(),
      }),
    ).toBe("claude");
  });
});
