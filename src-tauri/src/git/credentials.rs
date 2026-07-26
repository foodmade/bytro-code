use super::models::GitAuthCredentials;
use git2::{Cred, CredentialType, RemoteCallbacks, Repository};
use std::collections::HashMap;
use std::path::PathBuf;

/// Run `git credential fill` with CREATE_NO_WINDOW on Windows to avoid
/// flashing a console window every time the credential helper is invoked.
#[cfg(windows)]
fn credential_helper_no_window(
    url: &str,
    username_from_url: Option<&str>,
) -> Result<Cred, git2::Error> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let (protocol, host, path) = parse_credential_url(url);
    let mut input = format!("protocol={protocol}\nhost={host}\n");
    if !path.is_empty() {
        input.push_str(&format!("path={path}\n"));
    }
    if let Some(username) = username_from_url {
        input.push_str(&format!("username={username}\n"));
    }
    input.push('\n');

    let mut child = Command::new("git")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| git2::Error::from_str(&format!("failed to spawn git credential: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }

    let output = child
        .wait_with_output()
        .map_err(|e| git2::Error::from_str(&format!("git credential failed: {e}")))?;

    if !output.status.success() {
        return Err(git2::Error::from_str("git credential fill failed"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut username = String::new();
    let mut password = String::new();

    for line in stdout.lines() {
        if let Some(val) = line.strip_prefix("username=") {
            username = val.to_string();
        } else if let Some(val) = line.strip_prefix("password=") {
            password = val.to_string();
        }
    }

    if username.is_empty() || password.is_empty() {
        return Err(git2::Error::from_str(
            "credential helper did not provide credentials",
        ));
    }

    Cred::userpass_plaintext(&username, &password)
}

#[cfg(windows)]
fn parse_credential_url(url: &str) -> (String, String, String) {
    if let Some(rest) = url.strip_prefix("https://") {
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        ("https".to_string(), host.to_string(), path.to_string())
    } else if let Some(rest) = url.strip_prefix("http://") {
        let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
        ("http".to_string(), host.to_string(), path.to_string())
    } else {
        ("https".to_string(), url.to_string(), String::new())
    }
}

/// Match a remote URL to a known Git platform and return (username, token).
///
/// The `tokens` map may contain:
/// - `"github"`, `"gitee"`, `"gitlab"` → PAT tokens
/// - `"github_username"`, `"gitee_username"`, `"gitlab_username"` → stored usernames from test connection
///
/// If a stored username is available, it is used. Otherwise, platform-specific
/// defaults are applied:
/// - GitHub: `x-access-token` (official docs)
/// - GitLab: `oauth2` (official docs for PAT auth)
/// - Gitee: stored username (required; no universal fallback)
///
/// For any other (self-hosted) host, falls back to host-keyed credentials:
/// - `"host:<host>"` → token / password
/// - `"host-username:<host>"` → username (defaults to `git` if absent)
fn match_platform_token(url: &str, tokens: &HashMap<String, String>) -> Option<(String, String)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split('/').next().unwrap_or("");

    // Strip optional username@ prefix and port (e.g. "user@github.com:443").
    let host = host
        .split('@')
        .next_back()
        .unwrap_or(host)
        .split(':')
        .next()
        .unwrap_or(host)
        .to_ascii_lowercase();

    let platform = if host == "github.com" || host.ends_with(".github.com") {
        "github"
    } else if host == "gitee.com" || host.ends_with(".gitee.com") {
        "gitee"
    } else if host == "gitlab.com" || host.ends_with(".gitlab.com") {
        "gitlab"
    } else {
        // Self-hosted / custom host (e.g. a company GitLab or GitHub
        // Enterprise). Look up host-keyed credentials saved from the clone
        // auth prompt. Key format set by the frontend `buildGitTokensMap`:
        //   "host:<host>"          → token / password
        //   "host-username:<host>" → username
        let token = tokens
            .get(&format!("host:{host}"))
            .filter(|t| !t.is_empty())?;
        let username = tokens
            .get(&format!("host-username:{host}"))
            .filter(|u| !u.is_empty())
            .cloned()
            .unwrap_or_else(|| "git".to_string());
        return Some((username, token.clone()));
    };

    let token = tokens.get(platform).filter(|t| !t.is_empty())?;

    // Use stored username if available; otherwise platform-specific default.
    let username_key = format!("{platform}_username");
    let stored_username = tokens.get(&username_key).filter(|u| !u.is_empty());

    let username = if let Some(u) = stored_username {
        u.clone()
    } else {
        match platform {
            "github" => "x-access-token".to_string(),
            "gitlab" => "oauth2".to_string(),
            // Gitee requires the actual username; if not stored, still try
            // x-access-token as a best-effort fallback.
            "gitee" => "x-access-token".to_string(),
            _ => return None,
        }
    };

    Some((username, token.clone()))
}

pub(crate) fn has_platform_token(url: &str, tokens: &HashMap<String, String>) -> bool {
    match_platform_token(url, tokens).is_some()
}

fn username_for_manual_credentials(
    url: &str,
    username_from_url: Option<&str>,
    tokens: &HashMap<String, String>,
    credentials: &GitAuthCredentials,
) -> String {
    if let Some(username) = credentials
        .username
        .as_deref()
        .map(str::trim)
        .filter(|username| !username.is_empty())
    {
        return username.to_string();
    }

    if let Some(username) = username_from_url
        .map(str::trim)
        .filter(|username| !username.is_empty())
    {
        return username.to_string();
    }

    if let Some((username, _token)) = match_platform_token(url, tokens) {
        return username;
    }

    "git".to_string()
}

fn build_remote_callbacks_for_repo_path<'a>(
    repo_path: Option<PathBuf>,
    tokens: HashMap<String, String>,
    manual_credentials: Option<GitAuthCredentials>,
) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    let mut attempts = 0;

    callbacks.credentials(move |_url, username_from_url, allowed_types| {
        attempts += 1;
        if attempts > 5 {
            return Err(git2::Error::from_str("too many authentication attempts"));
        }

        let username = username_from_url.unwrap_or("git");

        // If libgit2 asks only for a username, prefer the HTTPS username that
        // belongs to the configured token. The follow-up request will receive
        // the matching token via USER_PASS_PLAINTEXT.
        if allowed_types.contains(CredentialType::USERNAME)
            && !allowed_types
                .intersects(CredentialType::SSH_KEY | CredentialType::USER_PASS_PLAINTEXT)
        {
            if let Some(credentials) = manual_credentials.as_ref() {
                let username =
                    username_for_manual_credentials(_url, username_from_url, &tokens, credentials);
                return Cred::username(&username);
            }
            if let Some((username, _token)) = match_platform_token(_url, &tokens) {
                return Cred::username(&username);
            }
            if let Some(username) = username_from_url {
                return Cred::username(username);
            }
        }

        // Try SSH agent first.
        if allowed_types.contains(CredentialType::SSH_KEY) {
            if let Ok(cred) = Cred::ssh_key_from_agent(username) {
                return Ok(cred);
            }

            // Try common SSH key paths.
            if let Some(home) = dirs::home_dir() {
                let key_names = ["id_ed25519", "id_rsa", "id_ecdsa"];
                for key_name in &key_names {
                    let private_key = home.join(".ssh").join(key_name);
                    let public_key = home.join(".ssh").join(format!("{key_name}.pub"));

                    if private_key.exists() {
                        let pub_path: Option<PathBuf> = if public_key.exists() {
                            Some(public_key)
                        } else {
                            None
                        };
                        if let Ok(cred) =
                            Cred::ssh_key(username, pub_path.as_deref(), &private_key, None)
                        {
                            return Ok(cred);
                        }
                    }
                }
            }
        }

        // Try username/password credentials.
        if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(credentials) = manual_credentials.as_ref() {
                if !credentials.password.is_empty() {
                    let username = username_for_manual_credentials(
                        _url,
                        username_from_url,
                        &tokens,
                        credentials,
                    );
                    if let Ok(cred) = Cred::userpass_plaintext(&username, &credentials.password) {
                        return Ok(cred);
                    }
                }
            }

            // First, try user-configured PAT tokens from Settings. This must
            // come before DEFAULT; otherwise libgit2 may keep retrying a generic
            // default credential and never reach the HTTPS token path.
            if let Some((username, token)) = match_platform_token(_url, &tokens) {
                if let Ok(cred) = Cred::userpass_plaintext(&username, &token) {
                    return Ok(cred);
                }
            }
        }

        // Try default credentials (git credential helper / OS keychain).
        if allowed_types.contains(CredentialType::DEFAULT) {
            if let Ok(cred) = Cred::default() {
                return Ok(cred);
            }
        }

        if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) {
            // On Windows, use our own credential helper invocation with
            // CREATE_NO_WINDOW to prevent a console window from flashing.
            #[cfg(windows)]
            {
                if let Ok(cred) = credential_helper_no_window(_url, username_from_url) {
                    return Ok(cred);
                }
            }

            // On non-Windows (or if the Windows helper failed), fall back to
            // git2's built-in credential_helper. Repo operations read the
            // repo-level config; clone/access-check use the default config.
            #[cfg(not(windows))]
            {
                let cfg = if let Some(repo_path) = repo_path.as_ref() {
                    Repository::open_bare(repo_path)
                        .and_then(|r| r.config())
                        .and_then(|mut c| c.snapshot())
                        .or_else(|_| git2::Config::open_default())
                } else {
                    git2::Config::open_default()
                };

                if let Ok(cfg) = cfg {
                    if let Ok(cred) = Cred::credential_helper(&cfg, _url, username_from_url) {
                        return Ok(cred);
                    }
                }
            }
        }

        Err(git2::Error::from_str(
            "no suitable credentials found; configure an HTTPS token in Git settings, a git credential helper, or SSH keys",
        ))
    });

    callbacks
}

/// Build remote callbacks with credential handling for fetch/push operations.
///
/// Accepts a reference to the repository so we can read the **repo-level** git
/// config (`.git/config`) where `credential.helper` is typically set, in
/// addition to the global/system config.  `git2::Config::open_default()` only
/// reads the global config, which misses repo-level settings.
///
/// `tokens` is a map of platform → Personal Access Token (e.g. "github" → "ghp_xxx").
/// When the remote URL matches a known platform and a token is configured,
/// it will be used as HTTPS credentials before falling back to other methods.
pub fn build_remote_callbacks<'a>(
    repo: &Repository,
    tokens: HashMap<String, String>,
) -> RemoteCallbacks<'a> {
    build_remote_callbacks_for_repo_path(Some(repo.path().to_path_buf()), tokens, None)
}

/// Build remote callbacks for fetch/push that also accept manual credentials
/// supplied from an interactive authentication prompt.
///
/// Same as [`build_remote_callbacks`] (reads the repo-level `credential.helper`
/// config), but tries the user-entered username/password before falling back to
/// stored tokens and credential helpers.
pub fn build_remote_callbacks_with_credentials<'a>(
    repo: &Repository,
    tokens: HashMap<String, String>,
    manual_credentials: Option<GitAuthCredentials>,
) -> RemoteCallbacks<'a> {
    build_remote_callbacks_for_repo_path(
        Some(repo.path().to_path_buf()),
        tokens,
        manual_credentials,
    )
}

pub fn build_remote_callbacks_without_repo_with_credentials<'a>(
    tokens: HashMap<String, String>,
    manual_credentials: Option<GitAuthCredentials>,
) -> RemoteCallbacks<'a> {
    build_remote_callbacks_for_repo_path(None, tokens, manual_credentials)
}
