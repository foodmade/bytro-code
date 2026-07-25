import { describe, expect, it } from "vitest";
import {
  validateProviderBaseUrl,
  validateProxyUrl,
} from "../endpoint-validation.js";

describe("provider endpoint validation", () => {
  it("accepts path-based API bases and proxy userinfo", () => {
    expect(validateProviderBaseUrl("https://api.example.test/v1")).toBe(
      "https://api.example.test/v1",
    );
    expect(validateProxyUrl("socks5h://user:pass@127.0.0.1:1080")).toBe(
      "socks5h://user:pass@127.0.0.1:1080",
    );
  });

  it("rejects base URL secrets without echoing them", () => {
    const sentinel = "sentinel-base-secret";
    for (const value of [
      `https://user:${sentinel}@api.example.test/v1`,
      `https://api.example.test/v1?token=${sentinel}`,
      `https://api.example.test/v1#${sentinel}`,
    ]) {
      const getError = () => validateProviderBaseUrl(value);
      expect(getError).toThrow();
      try {
        getError();
      } catch (error) {
        expect(String(error)).not.toContain(sentinel);
      }
    }
  });

  it("rejects proxy query and fragment secrets without echoing them", () => {
    const sentinel = "sentinel-proxy-secret";
    for (const value of [
      `http://127.0.0.1:8080?token=${sentinel}`,
      `socks5://127.0.0.1:1080#${sentinel}`,
    ]) {
      let rejected = false;
      try {
        validateProxyUrl(value);
      } catch (error) {
        rejected = true;
        expect(String(error)).not.toContain(sentinel);
      }
      expect(rejected).toBe(true);
    }
  });
});
