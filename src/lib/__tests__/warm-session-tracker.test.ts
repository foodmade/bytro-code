import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWarmSession,
  registerWarmSession,
  shouldInvalidateWarmSession,
  type WarmSessionConfig,
} from "../warm-session-tracker";

const config: WarmSessionConfig = {
  model: "local-model",
  platformId: "chatcmpl",
  cwd: "/tmp/workspace",
  reasoningLevel: "medium",
  apiKey: "sk-secret-value",
  baseUrl: "https://user:pass@api.example.com/v1?token=query-secret#fragment",
  profileId: "profile-1",
  permissionMode: "default",
  proxyUrl: "http://proxy-user:proxy-secret@proxy.example.com:8080",
};

afterEach(() => {
  clearWarmSession("conversation-1");
  vi.restoreAllMocks();
});

describe("warm session diagnostics", () => {
  it("does not emit configuration or credential diagnostics", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerWarmSession("conversation-1", "request-1", config);

    expect(shouldInvalidateWarmSession("conversation-1", config)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("invalidates changed credentials without logging either value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerWarmSession("conversation-1", "request-1", config);

    expect(
      shouldInvalidateWarmSession("conversation-1", {
        ...config,
        apiKey: "sk-replacement-secret",
      }),
    ).toBe(true);

    expect(warn).not.toHaveBeenCalled();
  });
});
