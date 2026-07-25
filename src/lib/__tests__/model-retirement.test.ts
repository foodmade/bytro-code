import { describe, expect, it } from "vitest";
import {
  RETIRED_GPT_FALLBACK_MODEL,
  filterRetiredGptModels,
  findGptRetirementFallback,
  isRetiredGptModel,
  normalizeRetiredGptModelId,
} from "@/lib/model-retirement";

describe("GPT-5.1/5.2 retirement", () => {
  it.each([
    "gpt-5.1",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "openai/gpt-5.1-codex",
    "provider/openai/gpt-5.2",
    "official:gpt-5.2",
  ])("recognizes retired model %s", (modelId) => {
    expect(isRetiredGptModel(modelId)).toBe(true);
  });

  it.each(["gpt-5.3-codex", "gpt-5.5", "gpt-5.6-sol", "gpt-5.20", "glm-5.1"])(
    "does not retire current or unrelated model %s",
    (modelId) => {
      expect(isRetiredGptModel(modelId)).toBe(false);
    },
  );

  it("normalizes retired IDs to GPT-5.6 Sol", () => {
    expect(normalizeRetiredGptModelId("openai/gpt-5.2-codex")).toBe(RETIRED_GPT_FALLBACK_MODEL);
    expect(normalizeRetiredGptModelId("gpt-5.4")).toBe("gpt-5.4");
  });

  it("filters retired models without changing the remaining entries", () => {
    const models = [
      { id: "gpt-5.6-sol", label: "Sol" },
      { id: "gpt-5.2", label: "Retired" },
      { id: "claude-opus-4-8", label: "Opus" },
    ];

    expect(filterRetiredGptModels(models)).toEqual([models[0], models[2]]);
  });

  it("prefers a provider-prefixed GPT-5.6 Sol fallback", () => {
    const models = [{ id: "claude-opus-4-8" }, { id: "openai/gpt-5.6-sol" }];

    expect(findGptRetirementFallback(models)?.id).toBe("openai/gpt-5.6-sol");
    expect(findGptRetirementFallback([models[0]])?.id).toBe("claude-opus-4-8");
    expect(findGptRetirementFallback([])).toBeUndefined();
  });
});
