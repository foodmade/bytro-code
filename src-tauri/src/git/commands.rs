use super::models::*;
use super::operations;

/// Helper: run a blocking git operation on the tokio blocking thread-pool
/// so that it never blocks the Tauri IPC (main async) thread.
macro_rules! blocking {
    ($body:expr) => {
        tokio::task::spawn_blocking(move || $body)
            .await
            .map_err(|e| e.to_string())?
    };
}

// ── Read Commands ────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_git_info(path: String) -> Result<GitInfo, String> {
    blocking!(operations::get_git_info(&path))
}

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<Vec<GitFileStatus>, String> {
    blocking!(operations::get_git_status(&path))
}

#[tauri::command]
pub async fn get_git_diff(path: String, staged: bool) -> Result<GitDiffResult, String> {
    blocking!(operations::get_git_diff(&path, staged))
}

#[tauri::command]
pub async fn get_file_diff(
    path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiffFile, String> {
    blocking!(operations::get_file_diff(&path, &file_path, staged))
}

#[tauri::command]
pub async fn get_diff_contents(
    path: String,
    file_path: String,
    staged: bool,
) -> Result<DiffContents, String> {
    blocking!(operations::get_diff_contents(&path, &file_path, staged))
}

#[tauri::command]
pub async fn get_git_log(
    path: String,
    limit: Option<u32>,
    file_path: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    blocking!(operations::get_git_log(&path, limit, file_path.as_deref()))
}

#[tauri::command]
pub async fn get_file_diff_in_commit(
    path: String,
    commit_id: String,
    file_path: String,
) -> Result<String, String> {
    blocking!(operations::get_file_diff_in_commit(
        &path, &commit_id, &file_path
    ))
}

#[tauri::command]
pub async fn get_git_branches(path: String) -> Result<Vec<GitBranchInfo>, String> {
    blocking!(operations::get_git_branches(&path))
}

#[tauri::command]
pub async fn get_git_stash_list(path: String) -> Result<Vec<GitStashEntry>, String> {
    blocking!(operations::get_git_stash_list(&path))
}

#[tauri::command]
pub async fn get_commit_detail(path: String, commit_id: String) -> Result<CommitDetail, String> {
    blocking!(operations::get_commit_detail(&path, &commit_id))
}

#[tauri::command]
pub async fn get_workspace_stats(path: String) -> Result<WorkspaceStats, String> {
    blocking!(operations::get_workspace_stats(&path))
}

/// Resolve the current branch's remote URL (best-effort; `None` when detached,
/// no remote, or the URL is non-UTF-8). Used to enrich the push/pull
/// credential prompt with a host label and a "remember" target.
#[tauri::command]
pub async fn git_get_remote_url(path: String) -> Result<Option<String>, String> {
    blocking!(operations::get_remote_url(&path))
}

// ── Write Commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn git_stage_files(path: String, files: Vec<String>) -> Result<(), String> {
    blocking!(operations::stage_files(&path, &files))
}

#[tauri::command]
pub async fn git_unstage_files(path: String, files: Vec<String>) -> Result<(), String> {
    blocking!(operations::unstage_files(&path, &files))
}

#[tauri::command]
pub async fn git_discard_files(path: String, files: Vec<String>) -> Result<(), String> {
    blocking!(operations::discard_files(&path, &files))
}

#[tauri::command]
pub async fn git_rm_cached(path: String, files: Vec<String>) -> Result<(), String> {
    blocking!(operations::rm_cached(&path, &files))
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    blocking!(operations::commit(&path, &message))
}

#[tauri::command]
pub async fn git_create_branch(path: String, name: String) -> Result<(), String> {
    blocking!(operations::create_branch(&path, &name))
}

#[tauri::command]
pub async fn git_switch_branch(path: String, name: String) -> Result<(), String> {
    blocking!(operations::switch_branch(&path, &name))
}

#[tauri::command]
pub async fn git_pull(
    path: String,
    git_tokens: Option<std::collections::HashMap<String, String>>,
    credentials: Option<super::models::GitAuthCredentials>,
) -> Result<GitPullResult, String> {
    let tokens = git_tokens.unwrap_or_default();
    blocking!(operations::pull(&path, tokens, credentials))
}

#[tauri::command]
pub async fn git_fetch(
    path: String,
    git_tokens: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    let tokens = git_tokens.unwrap_or_default();
    blocking!(operations::fetch(&path, tokens))
}

#[tauri::command]
pub async fn git_push(
    path: String,
    git_tokens: Option<std::collections::HashMap<String, String>>,
    credentials: Option<super::models::GitAuthCredentials>,
) -> Result<(), String> {
    let tokens = git_tokens.unwrap_or_default();
    blocking!(operations::push(&path, tokens, credentials))
}

#[tauri::command]
pub async fn git_stash_save(path: String, message: Option<String>) -> Result<(), String> {
    blocking!(operations::stash_save(&path, message.as_deref()))
}

#[tauri::command]
pub async fn git_stash_pop(path: String, index: usize) -> Result<(), String> {
    blocking!(operations::stash_pop(&path, index))
}

// ── Checkpoint Commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn git_checkpoint_create(
    path: String,
    label: String,
    conversation_id: Option<String>,
) -> Result<String, String> {
    blocking!(operations::checkpoint_create(
        &path,
        &label,
        conversation_id.as_deref()
    ))
}

#[tauri::command]
pub async fn git_checkpoint_restore(
    path: String,
    commit_id: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    blocking!(operations::checkpoint_restore(
        &path,
        &commit_id,
        conversation_id.as_deref()
    ))
}

#[tauri::command]
pub async fn git_checkpoint_list(
    path: String,
    conversation_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<super::models::CheckpointEntry>, String> {
    blocking!(operations::checkpoint_list(
        &path,
        conversation_id.as_deref(),
        limit.unwrap_or(100)
    ))
}

#[tauri::command]
pub async fn git_checkpoint_migrate(path: String) -> Result<u32, String> {
    blocking!(operations::checkpoint_migrate_legacy_branches(&path))
}

#[tauri::command]
pub async fn git_checkpoint_cleanup(
    path: String,
    max_age_days: Option<u32>,
) -> Result<u32, String> {
    let days = max_age_days.unwrap_or(7);
    let max_age_secs = days as i64 * 86400;
    blocking!(operations::checkpoint_cleanup(&path, max_age_secs))
}

/// Summarize commits + diff of HEAD vs a base branch (for AI PR descriptions).
#[tauri::command]
pub async fn git_branch_summary(path: String, base: String) -> Result<GitBranchSummary, String> {
    blocking!(operations::branch_summary(&path, &base))
}

// ── Token Test Commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn git_test_token(platform: String, token: String) -> Result<GitTokenTestResult, String> {
    blocking!(operations::test_git_token(&platform, &token))
}

// ── Revert Commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn revert_file_from_diff(
    path: String,
    file_path: String,
    file_diff: String,
    file_kind: String,
) -> Result<RevertFileResult, String> {
    blocking!(operations::revert_file_from_diff(
        &path, &file_path, &file_diff, &file_kind
    ))
}

// ── Advanced Commands ───────────────────────────────────────────────

#[tauri::command]
pub async fn git_create_tag(path: String, name: String, commit_id: String) -> Result<(), String> {
    blocking!(operations::create_tag(&path, &name, &commit_id))
}

#[tauri::command]
pub async fn git_create_branch_from_commit(
    path: String,
    name: String,
    commit_id: String,
) -> Result<(), String> {
    blocking!(operations::create_branch_from_commit(
        &path, &name, &commit_id
    ))
}

#[tauri::command]
pub async fn git_checkout_commit(path: String, commit_id: String) -> Result<(), String> {
    blocking!(operations::checkout_commit(&path, &commit_id))
}

#[tauri::command]
pub async fn git_reset_to_commit(
    path: String,
    commit_id: String,
    mode: String,
) -> Result<(), String> {
    blocking!(operations::reset_to_commit(&path, &commit_id, &mode))
}

#[tauri::command]
pub async fn git_archive_commit(
    path: String,
    commit_id: String,
    output_path: String,
) -> Result<(), String> {
    blocking!(operations::archive_commit(&path, &commit_id, &output_path))
}

#[tauri::command]
pub async fn git_format_patch(
    path: String,
    commit_id: String,
    output_path: String,
) -> Result<(), String> {
    blocking!(operations::format_patch(&path, &commit_id, &output_path))
}

#[tauri::command]
pub async fn git_clone_repo(
    url: String,
    target_dir: String,
    name: Option<String>,
    branch: Option<String>,
    git_tokens: Option<std::collections::HashMap<String, String>>,
    credentials: Option<super::models::GitAuthCredentials>,
) -> Result<String, String> {
    let tokens = git_tokens.unwrap_or_default();
    blocking!(operations::clone_repo(
        &url,
        &target_dir,
        name.as_deref(),
        branch.as_deref(),
        tokens,
        credentials
    ))
}

#[tauri::command]
pub async fn git_check_repo_access(
    url: String,
    git_tokens: Option<std::collections::HashMap<String, String>>,
) -> Result<bool, String> {
    let tokens = git_tokens.unwrap_or_default();
    blocking!(operations::check_repo_access(&url, tokens))
}

#[tauri::command]
pub async fn git_check_repo_access_details(
    url: String,
    git_tokens: Option<std::collections::HashMap<String, String>>,
    credentials: Option<super::models::GitAuthCredentials>,
) -> Result<super::models::GitRepoAccessResult, String> {
    let tokens = git_tokens.unwrap_or_default();
    blocking!(operations::check_repo_access_detailed(
        &url,
        tokens,
        credentials
    ))
}
