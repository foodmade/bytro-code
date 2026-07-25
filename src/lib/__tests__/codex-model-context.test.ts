import { describe, expect, it } from "vitest";
import { getContextWindowForModel } from "../../../sidecar/src/shared";

const GPT_5_6_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

describe("GPT-5.6 context window", () => {
  it.each(GPT_5_6_MODELS)("uses 1,050,000 tokens for %s", (modelId) => {
    expect(getContextWindowForModel(modelId)).toBe(1_050_000);
    expect(getContextWindowForModel(`openai/${modelId}`)).toBe(1_050_000);
  });

  it("keeps the generic GPT-5 fallback for older models", () => {
    expect(getContextWindowForModel("gpt-5.5")).toBe(400_000);
  });
});
