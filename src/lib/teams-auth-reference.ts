export interface TeamsProfileAuth {
  readonly id: string;
  readonly authMode?: "apiKey" | "oauth";
}

export interface TeamsApiCredentials {
  readonly apiKey: string;
  readonly baseUrl: string;
}

export interface TeamsAuthInvokeArgs {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly authMode: "apiKey" | "oauth";
  readonly profileId?: string;
  readonly oauthProvider?: string;
}

/**
 * Build the non-secret WebView → Rust credential reference for teams.
 * OAuth tokens are resolved by Rust immediately before the local sidecar write.
 */
export function buildTeamsAuthInvokeArgs(
  profile: TeamsProfileAuth | undefined,
  credentials: TeamsApiCredentials | null,
): TeamsAuthInvokeArgs | null {
  if (profile?.authMode === "oauth") {
    return {
      authMode: "oauth",
      profileId: profile.id,
      oauthProvider: "claude",
    };
  }
  if (!credentials) return null;
  return {
    apiKey: credentials.apiKey || undefined,
    baseUrl: credentials.baseUrl || undefined,
    authMode: "apiKey",
  };
}
