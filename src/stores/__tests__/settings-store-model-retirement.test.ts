import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPlatforms } from "@/lib/platform-config";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { useSettingsStore } from "@/stores/settings-store";

describe("settings-store retired GPT selections", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useSettingsStore.setState({ platforms: createDefaultPlatforms() });
  });

  it("normalizes a programmatic retired model selection", () => {
    useSettingsStore.getState().setActiveModel("codex", "gpt-5.2-codex");

    expect(useSettingsStore.getState().platforms.codex.activeModelId).toBe("gpt-5.6-sol");
    expect(invokeMock).toHaveBeenCalledWith("set_last_used_model", {
      platformId: "codex",
      modelId: "gpt-5.6-sol",
      isOfficial: false,
    });
  });

  it("uses a non-Codex platform's own default for a retired custom selection", () => {
    useSettingsStore.getState().setActiveModel("qwen", "openai/gpt-5.1");

    expect(useSettingsStore.getState().platforms.qwen.activeModelId).toBe("qwen3.5-plus");
  });

  it("does not start a provider session when switching platforms", () => {
    useSettingsStore.getState().setActivePlatform("claude");

    expect(invokeMock).not.toHaveBeenCalledWith("init_session", expect.anything());
    expect(invokeMock.mock.calls.every(([command]) => command !== "init_session")).toBe(true);
  });

  it("normalizes retired selections supplied through a bulk platform update", () => {
    const platforms = createDefaultPlatforms();
    platforms.qwen = { ...platforms.qwen, activeModelId: "gpt-5.2" };

    useSettingsStore.getState().setPlatforms(platforms);

    expect(useSettingsStore.getState().platforms.qwen.activeModelId).toBe("qwen3.5-plus");
  });

  it("migrates a persisted GPT-5.1/5.2 Codex selection", async () => {
    const platforms = createDefaultPlatforms();
    platforms.codex = { ...platforms.codex, activeModelId: "gpt-5.1-codex-mini" };
    const migrate = useSettingsStore.persist.getOptions().migrate;

    expect(migrate).toBeTypeOf("function");
    const migrated = (await migrate?.({ platforms }, 52)) as {
      platforms: ReturnType<typeof createDefaultPlatforms>;
    };

    expect(migrated.platforms.codex.activeModelId).toBe("gpt-5.6-sol");
  });

  it("migrates a retired non-Codex custom selection", async () => {
    const platforms = createDefaultPlatforms();
    platforms.qwen = { ...platforms.qwen, activeModelId: "provider/gpt-5.2" };
    const migrate = useSettingsStore.persist.getOptions().migrate;

    const migrated = (await migrate?.({ platforms }, 52)) as {
      platforms: ReturnType<typeof createDefaultPlatforms>;
    };

    expect(migrated.platforms.qwen.activeModelId).toBe("qwen3.5-plus");
  });
});
