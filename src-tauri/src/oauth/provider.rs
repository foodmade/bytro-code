//! Anthropic OAuth 2.0 PKCE client constants.
//!
//! Anthropic's OAuth application only accepts a single fixed redirect URI.
//! Dynamic localhost ports are rejected (GitHub issues #34917, #36015, #36215),
//! so we use Claude CLI's manual-paste flow instead of a local HTTP listener.

pub struct AnthropicProvider;

impl AnthropicProvider {
    pub const CLIENT_ID: &'static str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
    pub const AUTHORIZE_URL: &'static str = "https://claude.com/cai/oauth/authorize";
    pub const TOKEN_URL: &'static str = "https://console.anthropic.com/v1/oauth/token";
    pub const REDIRECT_URI: &'static str = "https://console.anthropic.com/oauth/code/callback";
    pub const SCOPES: &'static str =
        "user:inference user:profile org:create_api_key user:file_upload user:mcp_servers";
    /// Subscription usage endpoint (same one Claude Code's `/usage` panel calls).
    pub const USAGE_URL: &'static str = "https://api.anthropic.com/api/oauth/usage";
    /// Beta header required for OAuth-authenticated API endpoints.
    pub const OAUTH_BETA: &'static str = "oauth-2025-04-20";
}
