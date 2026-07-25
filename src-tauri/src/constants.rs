/// Community Edition display name — also used to isolate application data.
pub const APP_NAME: &str = "Bytro Community Edition";

/// Application bundle identifier (reverse-domain).
pub const APP_BUNDLE_ID: &str = "com.bytro.community";

/// User-Agent header value for HTTP requests.
pub const USER_AGENT: &str = "Bytro-Community";

/// macOS `.app` bundle name.
pub const MACOS_APP_NAME: &str = "Bytro Community Edition.app";

/// Unified Community Edition home directory name (under ~/.bytro-community/).
/// Stores MCP servers, skills, agents, commands, and plugins as the
/// single source of truth shared across all CLI platforms.
pub const BYTRO_COMMUNITY_HOME_DIR: &str = ".bytro-community";
