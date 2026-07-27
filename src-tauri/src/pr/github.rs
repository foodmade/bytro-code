use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use super::models::*;

/// Parse `host`, `owner`, `repo` out of an HTTPS or SCP-style git remote URL.
pub fn parse_remote_url(url: &str) -> Option<(String, String, String)> {
    let trimmed = url.trim();

    let (host, path) = if let Ok(parsed) = url::Url::parse(trimmed) {
        let host = parsed.host_str()?.to_lowercase();
        (host, parsed.path().trim_start_matches('/').to_string())
    } else {
        // SCP-like SSH URL: git@github.com:owner/repo.git
        let rest = trimmed.split_once('@').map(|(_, r)| r).unwrap_or(trimmed);
        let (host, path) = rest.split_once(':')?;
        (host.to_lowercase(), path.to_string())
    };

    let mut segments = path.trim_end_matches('/').splitn(2, '/');
    let owner = segments.next()?.to_string();
    let repo = segments
        .next()?
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((host, owner, repo))
}

/// Whether a host is served by the GitHub REST API we implement.
pub fn is_github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com")
}

/// REST API base URL for a GitHub host (github.com or GitHub Enterprise).
fn api_base(host: &str) -> String {
    if is_github_host(host) {
        "https://api.github.com".to_string()
    } else {
        // GitHub Enterprise convention; only reached if a caller opts in.
        format!("https://{host}/api/v3")
    }
}

/// Pick the token for a host from the flat map built by the frontend
/// (`buildGitTokensMap`): the built-in "github" slot for github.com,
/// otherwise the self-hosted "host:<host>" slot.
pub fn resolve_token(tokens: &HashMap<String, String>, host: &str) -> Option<String> {
    let candidate = if is_github_host(host) {
        tokens.get("github")
    } else {
        tokens.get(&format!("host:{host}"))
    };
    candidate.filter(|t| !t.trim().is_empty()).cloned()
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))
}

fn request(
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    let client = client()?;
    let mut req = client
        .request(method, url)
        .header("User-Agent", "Bytro Community")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    if let Some(body) = body {
        req = req.json(&body);
    }

    let resp = req.send().map_err(|e| {
        if e.is_timeout() {
            "GitHub API request timed out".to_string()
        } else if e.is_connect() {
            "Failed to connect to GitHub — check your network".to_string()
        } else {
            format!("GitHub API request failed: {e}")
        }
    })?;

    let status = resp.status();
    // 204 (e.g. deleted ref) has no body.
    let value: Value = if status == reqwest::StatusCode::NO_CONTENT {
        Value::Null
    } else {
        resp.json().unwrap_or(Value::Null)
    };

    if status.is_success() {
        return Ok(value);
    }

    let api_message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let hint = match status.as_u16() {
        401 => "Invalid or expired GitHub token".to_string(),
        403 => "GitHub token lacks required permissions or rate limit exceeded".to_string(),
        404 if token.is_none() => {
            "Repository not found — a GitHub token may be required for private repositories"
                .to_string()
        }
        404 => "Not found — check repository access and token scopes".to_string(),
        _ => format!("GitHub API error (HTTP {})", status.as_u16()),
    };
    if api_message.is_empty() {
        Err(hint)
    } else {
        Err(format!("{hint}: {api_message}"))
    }
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn u64_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn author_login(value: &Value) -> String {
    value
        .get("user")
        .and_then(|u| u.get("login"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn branch_ref(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.get("ref"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// "merged" beats the raw open/closed state so the UI can show three states.
fn pr_state(value: &Value) -> String {
    let merged = bool_field(value, "merged")
        || value.get("merged_at").map(|v| !v.is_null()).unwrap_or(false);
    if merged {
        "merged".to_string()
    } else {
        str_field(value, "state")
    }
}

fn pr_summary_from(value: &Value) -> PrSummary {
    PrSummary {
        number: u64_field(value, "number"),
        title: str_field(value, "title"),
        state: pr_state(value),
        is_draft: bool_field(value, "draft"),
        author: author_login(value),
        head_branch: branch_ref(value, "head"),
        base_branch: branch_ref(value, "base"),
        html_url: str_field(value, "html_url"),
        updated_at: str_field(value, "updated_at"),
    }
}

fn pr_detail_from(value: &Value) -> PrDetail {
    PrDetail {
        number: u64_field(value, "number"),
        title: str_field(value, "title"),
        state: pr_state(value),
        is_draft: bool_field(value, "draft"),
        author: author_login(value),
        head_branch: branch_ref(value, "head"),
        base_branch: branch_ref(value, "base"),
        html_url: str_field(value, "html_url"),
        created_at: str_field(value, "created_at"),
        updated_at: str_field(value, "updated_at"),
        body: str_field(value, "body"),
        head_sha: value
            .get("head")
            .and_then(|h| h.get("sha"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        mergeable: value.get("mergeable").and_then(Value::as_bool),
        mergeable_state: {
            let s = str_field(value, "mergeable_state");
            if s.is_empty() { "unknown".to_string() } else { s }
        },
        additions: u64_field(value, "additions"),
        deletions: u64_field(value, "deletions"),
        changed_files: u64_field(value, "changed_files"),
        commits: u64_field(value, "commits"),
    }
}

/// Fetch repository metadata (default branch, allowed merge methods).
pub fn fetch_repo_info(
    host: &str,
    owner: &str,
    repo: &str,
    token: Option<&str>,
) -> Result<PrRepoInfo, String> {
    let url = format!("{}/repos/{owner}/{repo}", api_base(host));
    let value = request(reqwest::Method::GET, &url, token, None)?;
    Ok(PrRepoInfo {
        host: host.to_string(),
        owner: owner.to_string(),
        repo: repo.to_string(),
        platform: "github".to_string(),
        default_branch: {
            let b = str_field(&value, "default_branch");
            if b.is_empty() { "main".to_string() } else { b }
        },
        allow_merge_commit: value
            .get("allow_merge_commit")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        allow_squash_merge: value
            .get("allow_squash_merge")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        allow_rebase_merge: value
            .get("allow_rebase_merge")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        delete_branch_on_merge: bool_field(&value, "delete_branch_on_merge"),
        html_url: str_field(&value, "html_url"),
        warning: None,
    })
}

/// List pull requests. `state` is "open", "closed", or "all".
pub fn list_prs(
    host: &str,
    owner: &str,
    repo: &str,
    state: &str,
    token: Option<&str>,
) -> Result<Vec<PrSummary>, String> {
    let url = format!(
        "{}/repos/{owner}/{repo}/pulls?state={state}&sort=updated&direction=desc&per_page=50",
        api_base(host)
    );
    let value = request(reqwest::Method::GET, &url, token, None)?;
    Ok(value
        .as_array()
        .map(|items| items.iter().map(pr_summary_from).collect())
        .unwrap_or_default())
}

pub fn get_pr_detail(
    host: &str,
    owner: &str,
    repo: &str,
    number: u64,
    token: Option<&str>,
) -> Result<PrDetail, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{number}", api_base(host));
    let value = request(reqwest::Method::GET, &url, token, None)?;
    Ok(pr_detail_from(&value))
}

pub fn create_pr(
    host: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    draft: bool,
    token: Option<&str>,
) -> Result<PrDetail, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls", api_base(host));
    let payload = json!({
        "title": title,
        "body": body,
        "head": head,
        "base": base,
        "draft": draft,
    });
    let value = request(reqwest::Method::POST, &url, token, Some(payload))?;
    Ok(pr_detail_from(&value))
}

/// Merge a pull request; optionally delete the remote head branch afterwards.
pub fn merge_pr(
    host: &str,
    owner: &str,
    repo: &str,
    number: u64,
    method: &str,
    head_branch: Option<&str>,
    delete_branch: bool,
    token: Option<&str>,
) -> Result<PrMergeResult, String> {
    if !matches!(method, "merge" | "squash" | "rebase") {
        return Err(format!("unsupported merge method: {method}"));
    }
    let url = format!(
        "{}/repos/{owner}/{repo}/pulls/{number}/merge",
        api_base(host)
    );
    let value = request(
        reqwest::Method::PUT,
        &url,
        token,
        Some(json!({ "merge_method": method })),
    )?;

    let merged = bool_field(&value, "merged");
    let mut branch_deleted = false;
    if merged && delete_branch {
        if let Some(branch) = head_branch.filter(|b| !b.is_empty()) {
            let ref_url = format!(
                "{}/repos/{owner}/{repo}/git/refs/heads/{branch}",
                api_base(host)
            );
            // Best-effort: the merge already succeeded, so a failed branch
            // delete (protected branch, races with auto-delete) is not an error.
            branch_deleted = request(reqwest::Method::DELETE, &ref_url, token, None).is_ok();
        }
    }

    Ok(PrMergeResult {
        merged,
        sha: value.get("sha").and_then(Value::as_str).map(String::from),
        message: str_field(&value, "message"),
        branch_deleted,
    })
}

/// Combine check-runs (GitHub Actions & apps) with legacy commit statuses
/// (third-party CI) into one list, then aggregate an overall verdict.
pub fn get_checks(
    host: &str,
    owner: &str,
    repo: &str,
    sha: &str,
    token: Option<&str>,
) -> Result<PrChecksResult, String> {
    let mut checks: Vec<PrCheck> = Vec::new();

    let runs_url = format!(
        "{}/repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100",
        api_base(host)
    );
    let runs = request(reqwest::Method::GET, &runs_url, token, None)?;
    if let Some(items) = runs.get("check_runs").and_then(Value::as_array) {
        for run in items {
            checks.push(PrCheck {
                name: str_field(run, "name"),
                status: str_field(run, "status"),
                conclusion: run
                    .get("conclusion")
                    .and_then(Value::as_str)
                    .map(String::from),
                details_url: run
                    .get("html_url")
                    .and_then(Value::as_str)
                    .map(String::from),
            });
        }
    }

    // Legacy statuses are best-effort — check-runs are the primary source.
    let status_url = format!("{}/repos/{owner}/{repo}/commits/{sha}/status", api_base(host));
    if let Ok(combined) = request(reqwest::Method::GET, &status_url, token, None) {
        if let Some(statuses) = combined.get("statuses").and_then(Value::as_array) {
            for status in statuses {
                let state = str_field(status, "state");
                let (run_status, conclusion) = match state.as_str() {
                    "pending" => ("in_progress".to_string(), None),
                    "error" => ("completed".to_string(), Some("failure".to_string())),
                    other => ("completed".to_string(), Some(other.to_string())),
                };
                checks.push(PrCheck {
                    name: str_field(status, "context"),
                    status: run_status,
                    conclusion,
                    details_url: status
                        .get("target_url")
                        .and_then(Value::as_str)
                        .map(String::from),
                });
            }
        }
    }

    let overall = if checks.is_empty() {
        "none"
    } else if checks.iter().any(|c| {
        matches!(
            c.conclusion.as_deref(),
            Some("failure" | "timed_out" | "cancelled" | "action_required")
        )
    }) {
        "failure"
    } else if checks.iter().any(|c| c.status != "completed") {
        "running"
    } else {
        "success"
    };

    Ok(PrChecksResult {
        overall: overall.to_string(),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_remote() {
        let (host, owner, repo) =
            parse_remote_url("https://github.com/foo/bar.git").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "foo");
        assert_eq!(repo, "bar");
    }

    #[test]
    fn parses_scp_remote() {
        let (host, owner, repo) = parse_remote_url("git@github.com:foo/bar.git").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "foo");
        assert_eq!(repo, "bar");
    }

    #[test]
    fn parses_nested_gitlab_path_as_invalid_for_pr() {
        // Nested groups (GitLab) keep the slash in repo — rejected for now.
        assert!(parse_remote_url("https://gitlab.com/a/b/c.git").is_none());
    }

    #[test]
    fn resolves_builtin_and_host_tokens() {
        let mut tokens = HashMap::new();
        tokens.insert("github".to_string(), "tok1".to_string());
        tokens.insert("host:ghe.corp.com".to_string(), "tok2".to_string());
        assert_eq!(resolve_token(&tokens, "github.com").as_deref(), Some("tok1"));
        assert_eq!(
            resolve_token(&tokens, "ghe.corp.com").as_deref(),
            Some("tok2")
        );
        assert_eq!(resolve_token(&tokens, "example.com"), None);
    }
}
