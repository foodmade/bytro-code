import { describe, expect, it } from "vitest";
import { summarizeClaudeApiRetry } from "../claude-handler.js";

describe("Claude provider retry diagnostics", () => {
  it("keeps retry metadata while hashing provider error text", () => {
    const retry = summarizeClaudeApiRetry({
      attempt: 2,
      max_retries: 4,
      retry_delay_ms: 1500,
      error_status: 429,
      error: {
        message:
          "SECRET_SENTINEL Authorization: Bearer private /Users/private",
      },
    });

    expect(retry).toMatchObject({
      attempt: 2,
      maxAttempts: 4,
      retryDelayMs: 1500,
      errorStatus: 429,
      reason: "provider_retry status=429 delay_ms=1500",
    });
    expect(retry.errorDiagnostic).toMatch(
      /^event=claude\.api_retry_error len=\d+ sha256=[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(retry)).not.toContain("SECRET_SENTINEL");
    expect(JSON.stringify(retry)).not.toContain("Authorization");
    expect(JSON.stringify(retry)).not.toContain("/Users/private");
  });
});
