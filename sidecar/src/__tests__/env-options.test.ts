import { afterEach, describe, expect, it } from "vitest";
import { buildProcessEnvWithManagedPath } from "../shared.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("options.env replacement safety", () => {
  it("copies process.env without injecting app-managed toolchain paths", () => {
    const oldPath = process.env.PATH ?? "";
    process.env = {
      ...ORIGINAL_ENV,
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_AUTH_TOKEN: "oauth-test",
      ANTHROPIC_BASE_URL: "https://example.test",
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "localhost,127.0.0.1",
      PATH: oldPath,
    };

    const env = buildProcessEnvWithManagedPath([
      "/app/managed/toolchain",
      "/definitely/missing",
    ]);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("oauth-test");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://example.test");
    expect(env.HTTPS_PROXY).toBe("http://proxy.test:8080");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.PATH ?? env.Path ?? "").toBe(oldPath);
  });
});
