import { describe, expect, it, vi } from "vitest";
import { createDefaultPlatforms } from "@/lib/platform-config";
import { scanAndMergeLocalCredentials } from "@/lib/local-credential-import";

describe("explicit local credential import", () => {
  it("does not scan until explicitly requested, then merges one new credential", async () => {
    const scan = vi.fn().mockResolvedValue([
      {
        platformId: "codex",
        source: "config_file",
        sourceLabel: "Codex",
        apiKey: "local-test-key",
        apiKeyMasked: "loc…key",
        baseUrl: "https://provider.example/v1",
      },
    ]);
    const platforms = createDefaultPlatforms();

    expect(scan).not.toHaveBeenCalled();
    const result = await scanAndMergeLocalCredentials(platforms, "Imported", scan);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(result.importedCount).toBe(1);
    expect(result.platforms.codex.profiles[0]).toMatchObject({
      apiKey: "local-test-key",
      baseUrl: "https://provider.example/v1",
    });
  });

  it("does not duplicate an API key already saved in Bytro settings", async () => {
    const platforms = createDefaultPlatforms();
    platforms.codex = {
      ...platforms.codex,
      profiles: platforms.codex.profiles.map((profile, index) =>
        index === 0 ? { ...profile, apiKey: "existing-key" } : profile,
      ),
    };

    const result = await scanAndMergeLocalCredentials(platforms, "Imported", async () => [
      {
        platformId: "codex",
        source: "config_file",
        sourceLabel: "Codex",
        apiKey: "existing-key",
        apiKeyMasked: "exi…key",
      },
    ]);

    expect(result.importedCount).toBe(0);
    expect(result.platforms).toBe(platforms);
  });
});
