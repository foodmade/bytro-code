import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { useRemoteModelsStore } from "@/stores/remote-models-store";

describe("remote model loading", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      success: true,
      models: [{ id: "provider/model", display_name: "Model", context_length: null }],
      message: "",
    });
    useRemoteModelsStore.setState({ providers: {} });
  });

  it("performs no request before the explicit refresh action", async () => {
    expect(invokeMock).not.toHaveBeenCalled();

    await useRemoteModelsStore
      .getState()
      .fetchModels("provider", "https://provider.example/v1", "test-key", undefined, true);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fetch_remote_models", {
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      proxyUrl: null,
    });
  });
});
