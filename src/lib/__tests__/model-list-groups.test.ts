import { describe, expect, it } from "vitest";
import { groupModelsForPicker } from "@/lib/model-list-groups";

describe("groupModelsForPicker", () => {
  it("pins the complete GPT-5.6 family ahead of tier groups in family order", () => {
    const groups = groupModelsForPicker(
      [
        { id: "gpt-5.5", tier: "flagship" },
        { id: "gpt-5.6-luna", tier: "fast" },
        { id: "gpt-5.6-sol", tier: "flagship" },
        { id: "other-balanced", tier: "balanced" },
        { id: "gpt-5.6-terra", tier: "balanced" },
      ],
      { pinCodex56: true },
    );

    expect(groups.map((group) => group.category)).toEqual(["GPT-5.6", "flagship", "balanced"]);
    expect(groups[0]?.items.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(groups[1]?.items.map((model) => model.id)).toEqual(["gpt-5.5"]);
    expect(groups[2]?.items.map((model) => model.id)).toEqual(["other-balanced"]);
  });

  it("does not pin GPT-5.6 models for other platforms", () => {
    const groups = groupModelsForPicker(
      [
        { id: "gpt-5.6-sol", tier: "flagship" },
        { id: "other-fast", tier: "fast" },
      ],
      { pinCodex56: false },
    );

    expect(groups.map((group) => group.category)).toEqual(["flagship", "fast"]);
  });

  it("keeps a filtered GPT-5.6 subset in family order", () => {
    const groups = groupModelsForPicker(
      [
        { id: "gpt-5.6-terra", tier: "balanced" },
        { id: "gpt-5.6-sol", tier: "flagship" },
      ],
      { pinCodex56: true },
    );

    expect(groups[0]?.items.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
  });

  it("keeps the existing fable-first behavior after pinning", () => {
    const groups = groupModelsForPicker(
      [
        { id: "claude-opus", tier: "flagship" },
        { id: "claude-fable", tier: "fable" },
      ],
      { prioritizeFable: true },
    );

    expect(groups.map((group) => group.category)).toEqual(["fable", "flagship"]);
  });
});
