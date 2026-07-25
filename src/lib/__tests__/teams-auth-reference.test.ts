import { describe, expect, it } from "vitest";
import { buildTeamsAuthInvokeArgs } from "../teams-auth-reference";

describe("buildTeamsAuthInvokeArgs", () => {
  it("uses only a provider/profile reference for OAuth", () => {
    const args = buildTeamsAuthInvokeArgs(
      { id: "oauth-profile", authMode: "oauth" },
      { apiKey: "ACCESS_TOKEN_SENTINEL", baseUrl: "https://api.example.test" },
    );

    expect(args).toEqual({
      authMode: "oauth",
      profileId: "oauth-profile",
      oauthProvider: "claude",
    });
    expect(JSON.stringify(args)).not.toContain("ACCESS_TOKEN_SENTINEL");
  });

  it("preserves the API-key invoke shape", () => {
    expect(
      buildTeamsAuthInvokeArgs(
        { id: "key-profile", authMode: "apiKey" },
        { apiKey: "local-key", baseUrl: "https://api.example.test" },
      ),
    ).toEqual({
      apiKey: "local-key",
      baseUrl: "https://api.example.test",
      authMode: "apiKey",
    });
  });
});
