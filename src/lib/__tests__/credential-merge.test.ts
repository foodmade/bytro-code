import { describe, expect, it } from "vitest";
import {
  filterUnimportedCredentials,
  mergeCredentials,
  type ScannedCredential,
} from "../credential-merge";
import {
  createDefaultPlatforms,
  PLATFORM_REGISTRY,
  type PlatformConfig,
  type PlatformId,
} from "../platform-config";

const IMPORTED_LABEL = "从本机导入";

function cred(
  platformId: PlatformId,
  overrides: Partial<ScannedCredential> = {},
): ScannedCredential {
  return {
    platformId,
    source: "env",
    sourceLabel: "ANTHROPIC_API_KEY",
    baseUrl: null,
    apiKey: "sk-test-12345678",
    apiKeyMasked: "sk-t…5678",
    configPath: null,
    ...overrides,
  };
}

/** Mutate a platform's active profile — used to set up fixtures where the
 *  user has already configured a key before scanning. */
function withExistingKey(
  platforms: Record<PlatformId, PlatformConfig>,
  id: PlatformId,
  apiKey: string,
  baseUrl?: string,
): Record<PlatformId, PlatformConfig> {
  const p = platforms[id];
  const active = p.profiles.find((x) => x.id === p.activeProfileId)!;
  return {
    ...platforms,
    [id]: {
      ...p,
      profiles: p.profiles.map((x) =>
        x.id === active.id
          ? { ...x, apiKey, baseUrl: baseUrl ?? x.baseUrl }
          : x,
      ),
    },
  };
}

describe("mergeCredentials", () => {
  it("returns the same map when nothing is selected", () => {
    const platforms = createDefaultPlatforms();
    expect(mergeCredentials(platforms, [], IMPORTED_LABEL)).toBe(platforms);
  });

  it("fills an empty active profile in place", () => {
    const platforms = createDefaultPlatforms();
    const result = mergeCredentials(
      platforms,
      [cred("claude", { apiKey: "sk-ant-abcd1234" })],
      IMPORTED_LABEL,
    );

    const claude = result.claude;
    expect(claude.profiles).toHaveLength(1);
    expect(claude.activeProfileId).toBe(platforms.claude.activeProfileId);
    const active = claude.profiles.find((p) => p.id === claude.activeProfileId)!;
    expect(active.apiKey).toBe("sk-ant-abcd1234");
    expect(active.testPassed).toBe(false);
  });

  it("does not overwrite a user-customized baseUrl on in-place fill", () => {
    const platforms = withExistingKey(
      createDefaultPlatforms(),
      "claude",
      "",
      "https://custom.proxy.example/anthropic",
    );
    const result = mergeCredentials(
      platforms,
      [cred("claude", { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-zzz99999" })],
      IMPORTED_LABEL,
    );
    const active = result.claude.profiles.find(
      (p) => p.id === result.claude.activeProfileId,
    )!;
    expect(active.baseUrl).toBe("https://custom.proxy.example/anthropic");
    expect(active.apiKey).toBe("sk-ant-zzz99999");
  });

  it("overwrites the default baseUrl when the scanned value differs", () => {
    const platforms = createDefaultPlatforms();
    const result = mergeCredentials(
      platforms,
      [
        cred("codex", {
          baseUrl: "https://proxy.example/v1",
          apiKey: "sk-openai-abcd1234",
        }),
      ],
      IMPORTED_LABEL,
    );
    const active = result.codex.profiles.find(
      (p) => p.id === result.codex.activeProfileId,
    )!;
    expect(active.baseUrl).toBe("https://proxy.example/v1");
    expect(active.apiKey).toBe("sk-openai-abcd1234");
  });

  it("appends a new profile when the active profile already has an API key", () => {
    const platforms = withExistingKey(
      createDefaultPlatforms(),
      "claude",
      "sk-ant-existing-9999",
    );
    const originalActiveId = platforms.claude.activeProfileId;

    const result = mergeCredentials(
      platforms,
      [cred("claude", { apiKey: "sk-ant-imported-1111" })],
      IMPORTED_LABEL,
    );

    expect(result.claude.profiles).toHaveLength(2);
    const originalActive = result.claude.profiles.find((p) => p.id === originalActiveId)!;
    expect(originalActive.apiKey).toBe("sk-ant-existing-9999");
    expect(result.claude.activeProfileId).not.toBe(originalActiveId);
    const newProfile = result.claude.profiles.find(
      (p) => p.id === result.claude.activeProfileId,
    )!;
    expect(newProfile.name).toBe(IMPORTED_LABEL);
    expect(newProfile.apiKey).toBe("sk-ant-imported-1111");
    expect(newProfile.testPassed).toBe(false);
  });

  it("falls back to defaultBaseUrl when the imported credential has no baseUrl", () => {
    const platforms = withExistingKey(
      createDefaultPlatforms(),
      "claude",
      "sk-ant-existing-9999",
    );
    const result = mergeCredentials(
      platforms,
      [cred("claude", { baseUrl: null, apiKey: "sk-ant-new-22222" })],
      IMPORTED_LABEL,
    );
    const newProfile = result.claude.profiles.find(
      (p) => p.id === result.claude.activeProfileId,
    )!;
    expect(newProfile.baseUrl).toBe(PLATFORM_REGISTRY.claude.defaultBaseUrl);
  });

  it("treats ollama's 'ollama' placeholder apiKey as empty for in-place fill", () => {
    const platforms = createDefaultPlatforms();
    // Default ollama profile has apiKey = "ollama"
    const defaultActive = platforms.ollama.profiles[0];
    expect(defaultActive.apiKey).toBe("ollama");

    const result = mergeCredentials(
      platforms,
      [
        cred("ollama", {
          baseUrl: "http://192.168.1.10:11434",
          apiKey: "ollama",
          sourceLabel: "OLLAMA_HOST",
        }),
      ],
      IMPORTED_LABEL,
    );
    // Should fill in-place, not append a new profile.
    expect(result.ollama.profiles).toHaveLength(1);
    const active = result.ollama.profiles.find(
      (p) => p.id === result.ollama.activeProfileId,
    )!;
    expect(active.baseUrl).toBe("http://192.168.1.10:11434");
  });

  it("for same-platform multiple credentials, first goes in-place and the rest become new profiles", () => {
    const platforms = createDefaultPlatforms();
    const result = mergeCredentials(
      platforms,
      [
        cred("codex", {
          source: "env",
          sourceLabel: "OPENAI_API_KEY",
          apiKey: "sk-first-00001111",
        }),
        cred("codex", {
          source: "config_file",
          sourceLabel: "~/.codex/auth.json",
          apiKey: "sk-second-22223333",
          configPath: "/home/u/.codex/auth.json",
        }),
        cred("codex", {
          source: "config_file",
          sourceLabel: "~/.codex/config.toml",
          apiKey: "sk-third-44445555",
        }),
      ],
      IMPORTED_LABEL,
    );

    expect(result.codex.profiles).toHaveLength(3);
    const defaultProfile = result.codex.profiles.find(
      (p) => p.id === platforms.codex.activeProfileId,
    )!;
    expect(defaultProfile.apiKey).toBe("sk-first-00001111");

    // Last credential becomes the active one.
    expect(result.codex.activeProfileId).not.toBe(platforms.codex.activeProfileId);
    const active = result.codex.profiles.find(
      (p) => p.id === result.codex.activeProfileId,
    )!;
    expect(active.apiKey).toBe("sk-third-44445555");

    // Middle credential exists as a non-active profile.
    const middle = result.codex.profiles.find((p) => p.apiKey === "sk-second-22223333");
    expect(middle).toBeDefined();
    expect(middle!.name).toBe(IMPORTED_LABEL);
  });

  it("applies updates across multiple platforms independently", () => {
    const platforms = createDefaultPlatforms();
    const result = mergeCredentials(
      platforms,
      [
        cred("claude", { apiKey: "sk-ant-aaaa1111" }),
        cred("codex", { apiKey: "sk-openai-bbbb2222" }),
        cred("gemini", { apiKey: "AIzaSyCccc3333" }),
      ],
      IMPORTED_LABEL,
    );

    expect(
      result.claude.profiles.find((p) => p.id === result.claude.activeProfileId)!.apiKey,
    ).toBe("sk-ant-aaaa1111");
    expect(
      result.codex.profiles.find((p) => p.id === result.codex.activeProfileId)!.apiKey,
    ).toBe("sk-openai-bbbb2222");
    expect(
      result.gemini.profiles.find((p) => p.id === result.gemini.activeProfileId)!.apiKey,
    ).toBe("AIzaSyCccc3333");
    // Other platforms untouched.
    expect(result.deepseek).toBe(platforms.deepseek);
  });

  it("silently skips unknown platform IDs (defensive against Rust/TS drift)", () => {
    const platforms = createDefaultPlatforms();
    const result = mergeCredentials(
      platforms,
      [
        {
          platformId: "anthropic-experimental",
          source: "env",
          sourceLabel: "X",
          apiKey: "irrelevant",
          apiKeyMasked: "i…t",
        } as unknown as ScannedCredential,
        cred("claude", { apiKey: "sk-ant-survives" }),
      ],
      IMPORTED_LABEL,
    );
    const active = result.claude.profiles.find(
      (p) => p.id === result.claude.activeProfileId,
    )!;
    expect(active.apiKey).toBe("sk-ant-survives");
  });

  it("does not mutate the input draft", () => {
    const platforms = createDefaultPlatforms();
    const snapshot = JSON.stringify(platforms);
    mergeCredentials(
      platforms,
      [cred("claude", { apiKey: "sk-ant-mutationcheck" })],
      IMPORTED_LABEL,
    );
    expect(JSON.stringify(platforms)).toBe(snapshot);
  });
});

describe("filterUnimportedCredentials", () => {
  it("returns everything when no platform has any matching key yet", () => {
    const platforms = createDefaultPlatforms();
    const scanned: ScannedCredential[] = [
      cred("claude", { apiKey: "sk-new-1" }),
      cred("codex", { apiKey: "sk-new-2" }),
    ];
    expect(filterUnimportedCredentials(platforms, scanned)).toEqual(scanned);
  });

  it("drops credentials whose apiKey already exists on the active profile", () => {
    const platforms = withExistingKey(
      createDefaultPlatforms(),
      "claude",
      "sk-ant-existing",
    );
    const scanned: ScannedCredential[] = [
      cred("claude", { apiKey: "sk-ant-existing" }),
      cred("codex", { apiKey: "sk-brand-new" }),
    ];
    const result = filterUnimportedCredentials(platforms, scanned);
    expect(result).toHaveLength(1);
    expect(result[0].platformId).toBe("codex");
  });

  it("drops credentials whose apiKey exists on any profile, not just the active one", () => {
    // Simulate a prior import that left a non-active profile carrying the key.
    const base = createDefaultPlatforms();
    const platforms: Record<PlatformId, PlatformConfig> = {
      ...base,
      codex: {
        ...base.codex,
        profiles: [
          ...base.codex.profiles,
          {
            id: "imported-1",
            name: "从本机导入",
            baseUrl: base.codex.profiles[0].baseUrl,
            apiKey: "sk-imported-previously",
            testPassed: false,
          },
        ],
      },
    };
    const scanned: ScannedCredential[] = [
      cred("codex", { apiKey: "sk-imported-previously" }),
    ];
    expect(filterUnimportedCredentials(platforms, scanned)).toEqual([]);
  });

  it("keeps unknown platform IDs (defensive)", () => {
    const platforms = createDefaultPlatforms();
    const scanned = [
      {
        platformId: "mystery",
        source: "env",
        sourceLabel: "X",
        apiKey: "sk-unknown",
        apiKeyMasked: "s…n",
      } as unknown as ScannedCredential,
    ];
    expect(filterUnimportedCredentials(platforms, scanned)).toEqual(scanned);
  });
});
