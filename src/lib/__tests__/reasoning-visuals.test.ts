import { describe, expect, it } from "vitest";
import { isPeakReasoningVisualActive } from "@/lib/reasoning-visuals";

describe("isPeakReasoningVisualActive", () => {
  it("activates for Claude UltraCode", () => {
    expect(
      isPeakReasoningVisualActive({
        sdk: "claude",
        modelId: "claude-opus-4-8",
        reasoningLevel: "high",
        ultracodeEnabled: true,
      }),
    ).toBe(true);
  });

  it("does not activate for Claude max without UltraCode", () => {
    expect(
      isPeakReasoningVisualActive({
        sdk: "claude",
        modelId: "claude-opus-4-8",
        reasoningLevel: "max",
        ultracodeEnabled: false,
      }),
    ).toBe(false);
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "openai/gpt-5.6-sol"])(
    "activates for GPT-5.6 native max on Codex: %s",
    (modelId) => {
      expect(
        isPeakReasoningVisualActive({
          sdk: "codex",
          modelId,
          reasoningLevel: "max",
          ultracodeEnabled: false,
        }),
      ).toBe(true);
    },
  );

  it("does not activate for an older Codex max fallback", () => {
    expect(
      isPeakReasoningVisualActive({
        sdk: "codex",
        modelId: "gpt-5.5",
        reasoningLevel: "max",
        ultracodeEnabled: false,
      }),
    ).toBe(false);
  });

  it("does not activate below max or on another SDK", () => {
    expect(
      isPeakReasoningVisualActive({
        sdk: "codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
        ultracodeEnabled: true,
      }),
    ).toBe(false);
    expect(
      isPeakReasoningVisualActive({
        sdk: "chatcmpl",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "max",
        ultracodeEnabled: false,
      }),
    ).toBe(false);
  });
});
