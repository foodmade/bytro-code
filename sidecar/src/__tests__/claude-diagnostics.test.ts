import { describe, expect, it } from "vitest";
import {
  buildRedactedCliError,
  collectCliDiagnosticSecrets,
  redactCliDiagnostic,
} from "../claude-handler.js";

describe("Claude CLI diagnostic redaction", () => {
  it("collects launch credentials and nested MCP header/env values", () => {
    const secrets = collectCliDiagnosticSecrets(
      {
        apiKey: "sentinel-api-key",
        baseUrl: "https://user:password@example.test/v1?token=base-secret",
        proxyUrl: "http://proxy-user:proxy-pass@proxy.test",
        mcpServers: {
          private: {
            headers: {
              Authorization: "Bearer sentinel-header-token",
            },
            env: {
              PRIVATE_TOKEN: "sentinel-mcp-env-token",
            },
          },
        },
      },
      {
        CLAUDE_CODE_OAUTH_TOKEN: "sentinel-oauth-token",
      },
    );

    expect(secrets).toEqual(
      expect.arrayContaining([
        "sentinel-api-key",
        "Bearer sentinel-header-token",
        "sentinel-mcp-env-token",
        "sentinel-oauth-token",
      ]),
    );
  });

  it("removes known and common credentials from CLI diagnostics", () => {
    const raw =
      "Authorization: Bearer sentinel-header-token " +
      "api_key=sk-sentinel123456 " +
      "url=https://user:password@example.test/v1?token=query-secret " +
      "private=sentinel-known-secret";
    const redacted = redactCliDiagnostic(raw, [
      "sentinel-known-secret",
      "sentinel-header-token",
    ]);

    for (const secret of [
      "sentinel-known-secret",
      "sentinel-header-token",
      "sk-sentinel123456",
      "user",
      "password",
      "query-secret",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  it("reduces arbitrary CLI errors and stderr to a fixed category and diagnostic ID", () => {
    const pathSentinel = "/Users/private/project";
    const promptSentinel = "write the unreleased acquisition memo";
    const unknownTokenSentinel = "opaque-Z9x7Q2-value";
    const detailed = buildRedactedCliError(
      `Claude CLI failed ${pathSentinel} ${promptSentinel} ${unknownTokenSentinel}`,
      [
        `provider body ${pathSentinel}`,
        `prompt=${promptSentinel} token=${unknownTokenSentinel}`,
      ],
      [],
    );

    expect(detailed).toMatch(/^Provider request failed \(diagnosticId: [a-f0-9]{12}\)$/);
    expect(detailed).not.toContain(pathSentinel);
    expect(detailed).not.toContain(promptSentinel);
    expect(detailed).not.toContain(unknownTokenSentinel);
  });

  it("keeps actionable categories without exposing provider text", () => {
    expect(buildRedactedCliError("HTTP 429 raw provider body", [])).toMatch(
      /^Provider rate limit reached \(diagnosticId: [a-f0-9]{12}\)$/,
    );
    expect(buildRedactedCliError("authentication failed raw provider body", [])).toMatch(
      /^Provider authentication failed \(diagnosticId: [a-f0-9]{12}\)$/,
    );
    expect(buildRedactedCliError("request timed out raw provider body", [])).toMatch(
      /^Provider request timed out \(diagnosticId: [a-f0-9]{12}\)$/,
    );
  });
});
