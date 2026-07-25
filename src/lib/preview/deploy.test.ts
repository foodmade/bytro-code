import { describe, expect, it } from "vitest";
import {
  deployErrorMessage,
  InvalidSiteIdError,
  isAllowedPublishedPreviewUrl,
  isDeployConfigurationError,
  normalizeOptionalSiteId,
} from "./deploy";

describe("normalizeOptionalSiteId", () => {
  it("normalizes an empty value to an omitted site ID", () => {
    expect(normalizeOptionalSiteId("   ")).toBeNull();
  });

  it("accepts a reusable lowercase site ID", () => {
    expect(normalizeOptionalSiteId("  demo-site-2 ")).toBe("demo-site-2");
  });

  it.each(["a", "-demo", "demo-", "Demo", "api", "www", "mail", "../demo"])(
    "rejects unsafe or reserved site ID %s",
    (value) => {
      expect(() => normalizeOptionalSiteId(value)).toThrow(InvalidSiteIdError);
    },
  );

  it("uses a stable error code instead of user-facing copy", () => {
    try {
      normalizeOptionalSiteId("invalid site");
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSiteIdError);
      expect((error as InvalidSiteIdError).code).toBe("invalid-site-id");
      expect((error as Error).message).toBe("invalid-site-id");
    }
  });
});

describe("isAllowedPublishedPreviewUrl", () => {
  it.each([
    "https://demo.example.com",
    "http://localhost:8787/",
    "http://127.0.0.1:8787/",
    "http://[::1]:8787/",
  ])("accepts a secure or loopback preview URL: %s", (value) => {
    expect(isAllowedPublishedPreviewUrl(value)).toBe(true);
  });

  it.each([
    "http://preview.example.com",
    "javascript:alert(1)",
    "https://user:secret@preview.example.com",
    "https://demo.example.com/nested",
    "https://demo.example.com/?token=secret",
    "https://demo.example.com/#fragment",
    "not a URL",
  ])("rejects an unsafe preview URL: %s", (value) => {
    expect(isAllowedPublishedPreviewUrl(value)).toBe(false);
  });

  it("requires the returned host to match the deployed site ID", () => {
    expect(isAllowedPublishedPreviewUrl("https://demo.preview.example.com/", "demo")).toBe(true);
    expect(isAllowedPublishedPreviewUrl("https://other.preview.example.com/", "demo")).toBe(false);
  });
});

describe("isDeployConfigurationError", () => {
  it("recognizes missing or invalid desktop Worker configuration", () => {
    expect(isDeployConfigurationError("Missing BYTRO_DEPLOY_WORKER_URL")).toBe(true);
    expect(isDeployConfigurationError("Invalid API key")).toBe(true);
  });

  it("does not misclassify project build failures", () => {
    expect(isDeployConfigurationError("Build failed: TypeScript error")).toBe(false);
    expect(isDeployConfigurationError("The Worker rejected the request (status 400).")).toBe(false);
  });
});

describe("deployErrorMessage", () => {
  it("normalizes Error, string, and unknown failures", () => {
    expect(deployErrorMessage(new Error("broken"))).toBe("broken");
    expect(deployErrorMessage("missing config")).toBe("missing config");
    expect(deployErrorMessage({ code: 500 })).toBe("Preview publication failed.");
  });
});
