import { describe, expect, it } from "vitest";
import {
  createDefaultPlatformConfig,
  createDefaultPlatforms,
  createCustomModelEntry,
  decodeConversationModel,
  getCustomModelsForActiveProfile,
  getDisplayModelsForPlatform,
  getModelsForPlatform,
  hasActiveProfileCredentials,
  isProfileConnectionHealthy,
  buildProfileProxyUrl,
  normalizeOAuthProfiles,
  normalizeModelIdForPlatform,
  ollamaLocalModelsToEntries,
  resolveActiveCredentials,
  supportsCodexMaxReasoning,
} from "@/lib/platform-config";

describe("platform-config codex models", () => {
  it("surfaces the GPT-5.6 family first with the expected tiers", () => {
    const models = getModelsForPlatform("codex");

    expect(models.slice(0, 3)).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "flagship" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "balanced" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", tier: "fast" },
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
    ]);
    expect(models.some((model) => model.id === "gpt-5.6")).toBe(false);
  });

  it("uses GPT-5.6 Sol as the default codex model for new configs", () => {
    const config = createDefaultPlatformConfig("codex");

    expect(config.activeModelId).toBe("gpt-5.6-sol");
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "openai/gpt-5.6-sol"])(
    "recognizes native max reasoning for %s",
    (modelId) => {
      expect(supportsCodexMaxReasoning(modelId)).toBe(true);
    },
  );

  it("keeps older Codex models on their existing max fallback", () => {
    expect(supportsCodexMaxReasoning("gpt-5.5")).toBe(false);
  });

  it.each([
    ["codex:gpt-5.2-codex", "codex"],
    ["official:openai/gpt-5.1", null],
    ["gpt-5.2", null],
  ] as const)("restores retired conversation model %s as GPT-5.6 Sol", (stored, platformId) => {
    expect(decodeConversationModel(stored)).toEqual({
      platformId,
      modelId: "gpt-5.6-sol",
    });
  });
});

describe("platform-config custom models", () => {
  it("merges custom models into non-Ollama display models", () => {
    const custom = createCustomModelEntry("provider/model-id");

    const models = getDisplayModelsForPlatform("claude", undefined, custom ? [custom] : []);

    expect(models.some((model) => model.id === "provider/model-id")).toBe(true);
  });

  it("does not merge custom models into Ollama display models", () => {
    const custom = createCustomModelEntry("provider/model-id");

    const models = getDisplayModelsForPlatform("ollama", undefined, custom ? [custom] : []);

    expect(models.some((model) => model.id === "provider/model-id")).toBe(false);
  });

  it("rejects retired GPT custom models", () => {
    expect(createCustomModelEntry("openai/gpt-5.2-codex")).toBeNull();
  });

  it("filters retired GPT models from remote catalogs", () => {
    const models = getDisplayModelsForPlatform("qwen", [
      { id: "gpt-5.2", label: "Retired", tier: "balanced" },
      { id: "qwen3.5-plus", label: "Qwen 3.5 Plus", tier: "flagship" },
    ]);

    expect(models.map((model) => model.id)).toEqual(["qwen3.5-plus"]);
  });

  it("filters retired GPT models from Ollama catalogs", () => {
    expect(
      ollamaLocalModelsToEntries([{ name: "gpt-5.2" }, { name: "llama3.3" }]),
    ).toEqual([{ id: "llama3.3", label: "llama3.3", tier: "balanced" }]);
  });

  it("falls back to each platform's own default model", () => {
    expect(normalizeModelIdForPlatform("codex", "gpt-5.2")).toBe("gpt-5.6-sol");
    expect(normalizeModelIdForPlatform("qwen", "gpt-5.1-codex-mini")).toBe(
      "qwen3.5-plus",
    );
  });

  it("normalizes a retired active model at the credential boundary", () => {
    const config = createDefaultPlatformConfig("qwen");
    const configured = {
      ...config,
      activeModelId: "gpt-5.2",
      profiles: config.profiles.map((profile) => ({ ...profile, apiKey: "test-key" })),
    };

    expect(resolveActiveCredentials(configured)?.model).toBe("qwen3.5-plus");
  });

  it("hides custom models while the active profile uses OAuth", () => {
    const custom = createCustomModelEntry("provider/model-id");
    const config = createDefaultPlatformConfig("claude");
    const oauthConfig = {
      ...config,
      customModels: custom ? [custom] : [],
      profiles: config.profiles.map((profile) => ({
        ...profile,
        authMode: "oauth" as const,
        oauthAccountEmail: "user@example.com",
      })),
    };

    expect(getCustomModelsForActiveProfile(oauthConfig)).toEqual([]);
  });
});

describe("platform-config profile proxy", () => {
  it("builds agent proxy URLs with mode and encoded auth", () => {
    const config = createDefaultPlatformConfig("claude");
    const profile = {
      ...config.profiles[0],
      proxy: {
        enabled: true,
        mode: "socks5" as const,
        host: "127.0.0.1",
        port: "1080",
        username: "user@example.com",
        password: "p@ss:word",
      },
    };

    expect(buildProfileProxyUrl(profile)).toBe(
      "socks5://user%40example.com:p%40ss%3Aword@127.0.0.1:1080",
    );
  });

  it("ignores disabled or incomplete agent proxy config", () => {
    const config = createDefaultPlatformConfig("codex");
    const baseProfile = config.profiles[0];

    expect(
      buildProfileProxyUrl({
        ...baseProfile,
        proxy: { enabled: false, mode: "http", host: "127.0.0.1", port: "8080" },
      }),
    ).toBeUndefined();
    expect(
      buildProfileProxyUrl({
        ...baseProfile,
        proxy: { enabled: true, mode: "https", host: "", port: "8080" },
      }),
    ).toBeUndefined();
    expect(
      buildProfileProxyUrl({
        ...baseProfile,
        proxy: { enabled: true, mode: "http", host: "127.0.0.1", port: "abc" },
      }),
    ).toBeUndefined();
  });
});

describe("platform-config oauth profiles", () => {
  it("treats signed-in Claude OAuth profiles as configured without an API key", () => {
    const config = createDefaultPlatformConfig("claude");
    const oauthConfig = {
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        authMode: "oauth" as const,
        baseUrl: "",
        apiKey: "",
        testPassed: false,
        oauthAccountEmail: "user@example.com",
        oauthExpiresAt: 2_000,
      })),
    };

    expect(hasActiveProfileCredentials(oauthConfig, 1_000)).toBe(true);
    expect(isProfileConnectionHealthy(oauthConfig.profiles[0], 1_000)).toBe(true);
  });

  it("does not treat expired Claude OAuth profiles as configured", () => {
    const config = createDefaultPlatformConfig("claude");
    const oauthConfig = {
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        authMode: "oauth" as const,
        baseUrl: "",
        apiKey: "",
        testPassed: false,
        oauthAccountEmail: "user@example.com",
        oauthExpiresAt: 1_000,
      })),
    };

    expect(hasActiveProfileCredentials(oauthConfig, 2_000)).toBe(false);
    expect(isProfileConnectionHealthy(oauthConfig.profiles[0], 2_000)).toBe(false);
  });

  it("normalizes OAuth profiles while preserving API-key settings and sign-in metadata", () => {
    const config = createDefaultPlatformConfig("claude");
    const platforms = {
      ...createDefaultPlatforms(),
      claude: {
        ...config,
        profiles: config.profiles.map((profile) => ({
          ...profile,
          authMode: "oauth" as const,
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-ant-api03-x",
          testPassed: true,
          oauthAccountEmail: "user@example.com",
          oauthPlan: "Pro",
          oauthExpiresAt: 2_000,
        })),
      },
    };

    const normalized = normalizeOAuthProfiles(platforms);
    const profile = normalized.claude.profiles[0];

    expect(profile.baseUrl).toBe("https://api.anthropic.com");
    expect(profile.apiKey).toBe("sk-ant-api03-x");
    expect(profile.testPassed).toBe(true);
    expect(profile.oauthAccountEmail).toBe("user@example.com");
    expect(profile.oauthPlan).toBe("Pro");
    expect(profile.oauthExpiresAt).toBe(2_000);
    expect(hasActiveProfileCredentials(normalized.claude, 1_000)).toBe(true);
  });

  it("does not resolve retained API-key credentials while a profile is in OAuth mode", () => {
    const config = createDefaultPlatformConfig("codex");
    const oauthConfig = {
      ...config,
      profiles: config.profiles.map((profile) => ({
        ...profile,
        authMode: "oauth" as const,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-retained",
        oauthAccountEmail: "user@example.com",
      })),
    };

    expect(resolveActiveCredentials(oauthConfig)).toBeNull();
  });

  it("normalizes OAuth profiles away from custom active models", () => {
    const custom = createCustomModelEntry("provider/model-id");
    const config = createDefaultPlatformConfig("claude");
    const platforms = {
      ...createDefaultPlatforms(),
      claude: {
        ...config,
        activeModelId: "provider/model-id",
        customModels: custom ? [custom] : [],
        profiles: config.profiles.map((profile) => ({
          ...profile,
          authMode: "oauth" as const,
          oauthAccountEmail: "user@example.com",
        })),
      },
    };

    const normalized = normalizeOAuthProfiles(platforms);

    expect(normalized.claude.activeModelId).toBe("claude-opus-4-8");
  });
});
