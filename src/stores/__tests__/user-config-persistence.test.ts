import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPlatforms } from "@/lib/platform-config";
import { scanAndMergeLocalCredentials } from "@/lib/local-credential-import";

const { invokeMock, storeGetMock, storeSetMock, storeDeleteMock, storeSaveMock, storeLoadMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn().mockResolvedValue(undefined),
    storeGetMock: vi.fn().mockResolvedValue(null),
    storeSetMock: vi.fn().mockResolvedValue(undefined),
    storeDeleteMock: vi.fn().mockResolvedValue(undefined),
    storeSaveMock: vi.fn().mockResolvedValue(undefined),
    storeLoadMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: storeLoadMock.mockResolvedValue({
    get: storeGetMock,
    set: storeSetMock,
    delete: storeDeleteMock,
    save: storeSaveMock,
  }),
}));

import { MCP_CONFIG_READ_ERROR, useMcpStore } from "@/stores/mcp-store";
import {
  flushSettingsPersistence,
  SETTINGS_PERSISTENCE_READ_ERROR,
  useSettingsStore,
} from "@/stores/settings-store";

describe("user configuration persistence", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    storeGetMock.mockReset();
    storeGetMock.mockResolvedValue(null);
    storeSetMock.mockReset();
    storeSetMock.mockResolvedValue(undefined);
    storeDeleteMock.mockReset();
    storeDeleteMock.mockResolvedValue(undefined);
    storeSaveMock.mockReset();
    storeSaveMock.mockResolvedValue(undefined);

    useSettingsStore.setState({
      platforms: createDefaultPlatforms(),
      persistenceError: null,
    });
    useMcpStore.setState({ servers: {}, loaded: true, loadError: null });
    await flushSettingsPersistence();
    storeSetMock.mockClear();
    storeSaveMock.mockClear();
  });

  it("writes user-saved provider credentials into the local settings store", async () => {
    expect(storeLoadMock).toHaveBeenCalledWith("settings.json", {
      defaults: {},
      autoSave: false,
    });
    const platforms = createDefaultPlatforms();
    const profile = platforms.codex.profiles[0];
    platforms.codex = {
      ...platforms.codex,
      profiles: [
        {
          ...profile,
          apiKey: "test-api-key",
          baseUrl: "https://provider.example/v1",
          proxy: {
            enabled: true,
            mode: "https",
            host: "proxy.example",
            port: "8443",
            username: "saved-user",
            password: "test-password",
          },
        },
      ],
    };

    await useSettingsStore.getState().setPlatforms(platforms);

    expect(storeSetMock).toHaveBeenCalled();
    await flushSettingsPersistence();
    expect(storeSaveMock).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("harden_settings_store");
    const lastCall = storeSetMock.mock.calls[storeSetMock.mock.calls.length - 1];
    const persistedValue = lastCall?.[1] as {
      readonly state?: {
        readonly platforms?: typeof platforms;
      };
    };
    const persistedProfile = persistedValue.state?.platforms?.codex.profiles[0];
    expect(persistedProfile).toMatchObject({
      apiKey: "test-api-key",
      baseUrl: "https://provider.example/v1",
      proxy: {
        enabled: true,
        host: "proxy.example",
        port: "8443",
        username: "saved-user",
        password: "test-password",
      },
    });

    storeGetMock.mockResolvedValue(persistedValue);
    useSettingsStore.setState({ platforms: createDefaultPlatforms() });
    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().platforms.codex.profiles[0]).toMatchObject({
      apiKey: "test-api-key",
      baseUrl: "https://provider.example/v1",
      proxy: {
        enabled: true,
        host: "proxy.example",
        port: "8443",
        username: "saved-user",
        password: "test-password",
      },
    });
  });

  it("flushes an explicit local credential import before immediate restart", async () => {
    const result = await scanAndMergeLocalCredentials(
      createDefaultPlatforms(),
      "Imported from Local",
      async () => [
        {
          platformId: "claude",
          source: "config_file",
          sourceLabel: "Claude",
          apiKey: "imported-persisted-key",
          apiKeyMasked: "imp…key",
          baseUrl: "https://imported-provider.example",
        },
      ],
    );

    useSettingsStore.getState().setPlatforms(result.platforms);
    await flushSettingsPersistence();
    const lastCall = storeSetMock.mock.calls[storeSetMock.mock.calls.length - 1];
    const persistedValue = lastCall?.[1];
    storeGetMock.mockResolvedValue(persistedValue);

    vi.resetModules();
    const {
      flushSettingsPersistence: flushRestartedSettings,
      useSettingsStore: restartedSettingsStore,
    } = await import("@/stores/settings-store");
    await restartedSettingsStore.persist.rehydrate();
    await flushRestartedSettings();

    expect(restartedSettingsStore.getState().platforms.claude.profiles[0]).toMatchObject({
      apiKey: "imported-persisted-key",
      baseUrl: "https://imported-provider.example",
    });
  });

  it("saves and reloads MCP environment values and authorization headers", async () => {
    const httpConfig = {
      type: "http" as const,
      url: "https://mcp.example/api",
      headers: {
        Authorization: "Bearer test-mcp-token",
      },
    };
    const stdioConfig = {
      type: "stdio" as const,
      command: "example-mcp",
      env: {
        MCP_API_KEY: "test-mcp-env-value",
      },
    };

    await useMcpStore.getState().setServer("private-http-mcp", httpConfig);
    await useMcpStore.getState().setServer("private-stdio-mcp", stdioConfig);

    expect(invokeMock).toHaveBeenCalledWith("save_mcp_servers", {
      servers: {
        "private-http-mcp": httpConfig,
        "private-stdio-mcp": stdioConfig,
      },
    });

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_mcp_servers") {
        return {
          "private-http-mcp": httpConfig,
          "private-stdio-mcp": stdioConfig,
        };
      }
      return undefined;
    });
    useMcpStore.setState({ servers: {}, loaded: false, loadError: null });

    await useMcpStore.getState().load();

    expect(useMcpStore.getState()).toMatchObject({
      loaded: true,
      servers: {
        "private-http-mcp": httpConfig,
        "private-stdio-mcp": stdioConfig,
      },
    });
  });

  it("continues queued MCP saves after an earlier save fails", async () => {
    const firstConfig = {
      type: "http" as const,
      url: "https://first-mcp.example/api",
      headers: {
        Authorization: "Bearer first-token",
      },
    };
    const recoveredConfig = {
      type: "stdio" as const,
      command: "recovered-mcp",
      env: {
        MCP_API_KEY: "recovered-token",
      },
    };
    let saveAttempt = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "save_mcp_servers") {
        saveAttempt += 1;
        if (saveAttempt === 1) {
          throw new Error("simulated MCP save failure");
        }
      }
      return undefined;
    });

    await expect(useMcpStore.getState().setServer("first-mcp", firstConfig)).rejects.toThrow(
      "simulated MCP save failure",
    );
    await expect(
      useMcpStore.getState().setServer("recovered-mcp", recoveredConfig),
    ).resolves.toBeUndefined();

    const saveCalls = invokeMock.mock.calls.filter(([command]) => command === "save_mcp_servers");
    expect(saveCalls).toHaveLength(2);
    expect(saveCalls[1]?.[1]).toEqual({
      servers: {
        "first-mcp": firstConfig,
        "recovered-mcp": recoveredConfig,
      },
    });
  });

  it("preserves MCP state and blocks writes until a failed read is retried", async () => {
    const inMemoryConfig = {
      type: "http" as const,
      url: "https://in-memory-mcp.example/api",
    };
    const recoveredConfig = {
      type: "stdio" as const,
      command: "recovered-from-disk",
      env: { MCP_API_KEY: "recovered-secret" },
    };
    useMcpStore.setState({
      servers: { "in-memory": inMemoryConfig },
      loaded: false,
      loadError: null,
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_mcp_servers") {
        throw new Error("permission denied at private path");
      }
      return undefined;
    });

    await useMcpStore.getState().load();

    expect(useMcpStore.getState()).toMatchObject({
      servers: { "in-memory": inMemoryConfig },
      loaded: true,
      loadError: MCP_CONFIG_READ_ERROR,
    });
    invokeMock.mockClear();
    await expect(
      useMcpStore.getState().setServer("must-not-overwrite", recoveredConfig),
    ).rejects.toThrow(MCP_CONFIG_READ_ERROR);
    expect(invokeMock).not.toHaveBeenCalledWith("save_mcp_servers", expect.anything());
    expect(useMcpStore.getState().servers).toEqual({ "in-memory": inMemoryConfig });

    invokeMock.mockImplementation(async (command: string) => {
      if (command === "load_mcp_servers") {
        return { "recovered-from-disk": recoveredConfig };
      }
      return undefined;
    });
    await useMcpStore.getState().load();

    expect(useMcpStore.getState()).toMatchObject({
      servers: { "recovered-from-disk": recoveredConfig },
      loaded: true,
      loadError: null,
    });
    await useMcpStore.getState().setServer("new-after-retry", inMemoryConfig);
    expect(invokeMock).toHaveBeenCalledWith("save_mcp_servers", {
      servers: {
        "recovered-from-disk": recoveredConfig,
        "new-after-retry": inMemoryConfig,
      },
    });
  });

  it("preserves settings and blocks writes until a failed read is retried", async () => {
    const inMemoryPlatforms = createDefaultPlatforms();
    inMemoryPlatforms.codex = {
      ...inMemoryPlatforms.codex,
      profiles: inMemoryPlatforms.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "in-memory-key" } : profile,
      ),
    };
    useSettingsStore.setState({ platforms: inMemoryPlatforms });
    await flushSettingsPersistence();
    storeSetMock.mockClear();
    storeSaveMock.mockClear();
    storeGetMock.mockRejectedValue(new Error("corrupt or unreadable settings"));

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().persistenceError).toBe(SETTINGS_PERSISTENCE_READ_ERROR);
    expect(useSettingsStore.getState().platforms.codex.profiles[0].apiKey).toBe("in-memory-key");

    const blockedPlatforms = createDefaultPlatforms();
    blockedPlatforms.codex = {
      ...blockedPlatforms.codex,
      profiles: blockedPlatforms.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "must-not-overwrite" } : profile,
      ),
    };
    useSettingsStore.getState().setPlatforms(blockedPlatforms);
    await expect(flushSettingsPersistence()).rejects.toThrow(SETTINGS_PERSISTENCE_READ_ERROR);
    expect(storeSetMock).not.toHaveBeenCalled();

    const recoveredPlatforms = createDefaultPlatforms();
    recoveredPlatforms.codex = {
      ...recoveredPlatforms.codex,
      profiles: recoveredPlatforms.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "recovered-from-disk" } : profile,
      ),
    };
    storeGetMock.mockResolvedValue({
      state: { platforms: recoveredPlatforms },
      version: 53,
    });

    await useSettingsStore.getState().retryPersistenceLoad();
    await flushSettingsPersistence();

    expect(useSettingsStore.getState().persistenceError).toBeNull();
    expect(useSettingsStore.getState().platforms.codex.profiles[0].apiKey).toBe(
      "recovered-from-disk",
    );
    storeSetMock.mockClear();
    const savedAfterRetry = structuredClone(recoveredPlatforms);
    savedAfterRetry.codex = {
      ...savedAfterRetry.codex,
      profiles: savedAfterRetry.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "saved-after-retry" } : profile,
      ),
    };
    useSettingsStore.getState().setPlatforms(savedAfterRetry);
    await flushSettingsPersistence();
    expect(storeSetMock).toHaveBeenCalled();
  });

  it("treats a malformed settings payload as unreadable instead of empty", async () => {
    const inMemoryPlatforms = createDefaultPlatforms();
    inMemoryPlatforms.claude = {
      ...inMemoryPlatforms.claude,
      profiles: inMemoryPlatforms.claude.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "test-preserve-on-corruption" } : profile,
      ),
    };
    useSettingsStore.setState({ platforms: inMemoryPlatforms });
    await flushSettingsPersistence();
    storeSetMock.mockClear();
    storeGetMock.mockResolvedValue({ unexpected: "corrupt envelope" });

    await useSettingsStore.persist.rehydrate();

    expect(useSettingsStore.getState().persistenceError).toBe(SETTINGS_PERSISTENCE_READ_ERROR);
    expect(useSettingsStore.getState().platforms.claude.profiles[0].apiKey).toBe(
      "test-preserve-on-corruption",
    );
    useSettingsStore.getState().setPlatforms(createDefaultPlatforms());
    await expect(flushSettingsPersistence()).rejects.toThrow(SETTINGS_PERSISTENCE_READ_ERROR);
    expect(storeSetMock).not.toHaveBeenCalled();

    storeGetMock.mockResolvedValue({
      state: { platforms: inMemoryPlatforms },
      version: 53,
    });
    await useSettingsStore.getState().retryPersistenceLoad();
    await flushSettingsPersistence();
    expect(useSettingsStore.getState().persistenceError).toBeNull();
  });

  it("continues queued settings writes after an earlier write fails", async () => {
    let inMemoryStoreValue: unknown;
    let savedStoreValue: unknown;
    let setCallCount = 0;
    storeSetMock.mockImplementation(async (_name: string, value: unknown) => {
      setCallCount += 1;
      if (setCallCount === 1) {
        throw new Error("simulated write failure");
      }
      inMemoryStoreValue = value;
    });
    storeSaveMock.mockImplementation(async () => {
      savedStoreValue = inMemoryStoreValue;
    });

    const failedUpdate = createDefaultPlatforms();
    failedUpdate.codex = {
      ...failedUpdate.codex,
      profiles: failedUpdate.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "failed-api-key" } : profile,
      ),
    };
    const recoveredUpdate = structuredClone(failedUpdate);
    recoveredUpdate.codex = {
      ...recoveredUpdate.codex,
      profiles: recoveredUpdate.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "recovered-api-key" } : profile,
      ),
    };

    useSettingsStore.getState().setPlatforms(failedUpdate);
    useSettingsStore.getState().setPlatforms(recoveredUpdate);

    await vi.waitFor(() => expect(storeSetMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(storeSaveMock).toHaveBeenCalledTimes(1));
    expect(
      (
        savedStoreValue as {
          readonly state: { readonly platforms: typeof recoveredUpdate };
        }
      ).state.platforms.codex.profiles[0].apiKey,
    ).toBe("recovered-api-key");
  });

  it("serializes rapid provider updates and restores the final saved configuration", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let inMemoryStoreValue: unknown;
    let savedStoreValue: unknown;
    let setCallCount = 0;

    storeSetMock.mockImplementation(async (_name: string, value: unknown) => {
      setCallCount += 1;
      if (setCallCount === 1) {
        await firstWriteBlocked;
      }
      inMemoryStoreValue = value;
    });
    storeSaveMock.mockImplementation(async () => {
      savedStoreValue = JSON.parse(JSON.stringify(inMemoryStoreValue));
    });

    const apiKeyUpdate = createDefaultPlatforms();
    apiKeyUpdate.codex = {
      ...apiKeyUpdate.codex,
      profiles: apiKeyUpdate.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "queued-api-key" } : profile,
      ),
    };
    const baseUrlUpdate = structuredClone(apiKeyUpdate);
    baseUrlUpdate.codex = {
      ...baseUrlUpdate.codex,
      profiles: baseUrlUpdate.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, baseUrl: "https://queued-provider.example/v1" } : profile,
      ),
    };
    const proxyUpdate = structuredClone(baseUrlUpdate);
    proxyUpdate.codex = {
      ...proxyUpdate.codex,
      profiles: proxyUpdate.codex.profiles.map((profile, index) =>
        index === 0
          ? {
              ...profile,
              proxy: {
                enabled: true,
                mode: "https",
                host: "queued-proxy.example",
                port: "9443",
                username: "queued-user",
                password: "queued-password",
              },
            }
          : profile,
      ),
    };

    useSettingsStore.getState().setPlatforms(apiKeyUpdate);
    useSettingsStore.getState().setPlatforms(baseUrlUpdate);
    useSettingsStore.getState().setPlatforms(proxyUpdate);

    await vi.waitFor(() => expect(storeSetMock).toHaveBeenCalledTimes(1));
    releaseFirstWrite?.();
    await vi.waitFor(() => expect(storeSaveMock).toHaveBeenCalledTimes(3));

    const savedProfile = (
      savedStoreValue as {
        readonly state: {
          readonly platforms: typeof proxyUpdate;
        };
      }
    ).state.platforms.codex.profiles[0];
    expect(savedProfile).toMatchObject({
      apiKey: "queued-api-key",
      baseUrl: "https://queued-provider.example/v1",
      proxy: {
        enabled: true,
        host: "queued-proxy.example",
        port: "9443",
        username: "queued-user",
        password: "queued-password",
      },
    });

    storeGetMock.mockResolvedValue(savedStoreValue);
    vi.resetModules();
    const { useSettingsStore: restartedSettingsStore } = await import("@/stores/settings-store");
    await restartedSettingsStore.persist.rehydrate();

    expect(restartedSettingsStore.getState().platforms.codex.profiles[0]).toMatchObject({
      apiKey: "queued-api-key",
      baseUrl: "https://queued-provider.example/v1",
      proxy: {
        enabled: true,
        host: "queued-proxy.example",
        port: "9443",
        username: "queued-user",
        password: "queued-password",
      },
    });
  });
});
