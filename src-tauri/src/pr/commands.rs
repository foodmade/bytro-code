use std::collections::HashMap;

use super::github;
use super::models::*;

/// Helper: run a blocking network operation on the tokio blocking thread-pool
/// so that it never blocks the Tauri IPC (main async) thread.
macro_rules! blocking {
    ($body:expr) => {
        tokio::task::spawn_blocking(move || $body)
            .await
            .map_err(|e| e.to_string())?
    };
}

fn tokens_or_default(tokens: Option<HashMap<String, String>>) -> HashMap<String, String> {
    tokens.unwrap_or_default()
}

/// Resolve the workspace's remote into a PR-capable repository description.
/// Non-GitHub hosts return `platform: "unsupported"` instead of an error so
/// the panel can explain the limitation.
#[tauri::command]
pub async fn pr_detect_repo(
    path: String,
    git_tokens: Option<HashMap<String, String>>,
) -> Result<Option<PrRepoInfo>, String> {
    let tokens = tokens_or_default(git_tokens);
    blocking!({
        let Some(url) = crate::git::operations::get_remote_url(&path)? else {
            return Ok(None);
        };
        let Some((host, owner, repo)) = github::parse_remote_url(&url) else {
            return Ok(None);
        };

        if !github::is_github_host(&host) {
            return Ok(Some(PrRepoInfo {
                html_url: format!("https://{host}/{owner}/{repo}"),
                host,
                owner,
                repo,
                platform: "unsupported".to_string(),
                default_branch: "main".to_string(),
                allow_merge_commit: true,
                allow_squash_merge: true,
                allow_rebase_merge: true,
                delete_branch_on_merge: false,
                warning: None,
            }));
        }

        let token = github::resolve_token(&tokens, &host);
        match github::fetch_repo_info(&host, &owner, &repo, token.as_deref()) {
            Ok(info) => Ok(Some(info)),
            // Degrade to sensible defaults so the panel still renders; the
            // warning tells the user why merge options may be inaccurate.
            Err(warning) => Ok(Some(PrRepoInfo {
                html_url: format!("https://{host}/{owner}/{repo}"),
                host,
                owner,
                repo,
                platform: "github".to_string(),
                default_branch: "main".to_string(),
                allow_merge_commit: true,
                allow_squash_merge: true,
                allow_rebase_merge: true,
                delete_branch_on_merge: false,
                warning: Some(warning),
            })),
        }
    })
}

#[tauri::command]
pub async fn pr_list(
    host: String,
    owner: String,
    repo: String,
    state: Option<String>,
    git_tokens: Option<HashMap<String, String>>,
) -> Result<Vec<PrSummary>, String> {
    let tokens = tokens_or_default(git_tokens);
    let state = state.unwrap_or_else(|| "open".to_string());
    blocking!({
        let token = github::resolve_token(&tokens, &host);
        github::list_prs(&host, &owner, &repo, &state, token.as_deref())
    })
}

#[tauri::command]
pub async fn pr_get_detail(
    host: String,
    owner: String,
    repo: String,
    number: u64,
    git_tokens: Option<HashMap<String, String>>,
) -> Result<PrDetail, String> {
    let tokens = tokens_or_default(git_tokens);
    blocking!({
        let token = github::resolve_token(&tokens, &host);
        github::get_pr_detail(&host, &owner, &repo, number, token.as_deref())
    })
}

#[tauri::command]
pub async fn pr_get_checks(
    host: String,
    owner: String,
    repo: String,
    sha: String,
    git_tokens: Option<HashMap<String, String>>,
) -> Result<PrChecksResult, String> {
    let tokens = tokens_or_default(git_tokens);
    blocking!({
        let token = github::resolve_token(&tokens, &host);
        github::get_checks(&host, &owner, &repo, &sha, token.as_deref())
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pr_create(
    host: String,
    owner: String,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: bool,
    git_tokens: Option<HashMap<String, String>>,
) -> Result<PrDetail, String> {
    let tokens = tokens_or_default(git_tokens);
    blocking!({
        let token = github::resolve_token(&tokens, &host);
        if token.is_none() {
            return Err(
                "A GitHub token is required to create a pull request — add one in Settings → Git"
                    .to_string(),
            );
        }
        github::create_pr(
            &host,
            &owner,
            &repo,
            &title,
            &body,
            &head,
            &base,
            draft,
            token.as_deref(),
        )
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pr_merge(
    host: String,
    owner: String,
    repo: String,
    number: u64,
    method: String,
    head_branch: Option<String>,
    delete_branch: Option<bool>,
    git_tokens: Option<HashMap<String, String>>,
) -> Result<PrMergeResult, String> {
    let tokens = tokens_or_default(git_tokens);
    blocking!({
        let token = github::resolve_token(&tokens, &host);
        if token.is_none() {
            return Err(
                "A GitHub token is required to merge a pull request — add one in Settings → Git"
                    .to_string(),
            );
        }
        github::merge_pr(
            &host,
            &owner,
            &repo,
            number,
            &method,
            head_branch.as_deref(),
            delete_branch.unwrap_or(false),
            token.as_deref(),
        )
    })
}
