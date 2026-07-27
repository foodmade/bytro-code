use serde::{Deserialize, Serialize};

/// Basic git repository info (compatible with existing GitInfo interface)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: Option<String>,
    pub modified_count: u32,
    pub untracked_count: u32,
    pub ahead: u32,
    pub behind: u32,
    pub is_git_repo: bool,
    pub detached_head: bool,
    pub merge_in_progress: bool,
}

/// Status of a single file in the working tree or index
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub is_staged: bool,
    pub old_path: Option<String>,
}

/// Complete diff result across all changed files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffResult {
    pub files: Vec<GitDiffFile>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

/// Diff information for a single file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub hunks: Vec<GitDiffHunk>,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
}

/// A single hunk in a diff
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffHunk {
    pub header: String,
    pub lines: Vec<GitDiffLine>,
}

/// A single line in a diff hunk
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffLine {
    pub content: String,
    pub line_type: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

/// A single commit log entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLogEntry {
    pub id: String,
    pub full_id: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub parent_count: usize,
}

/// Branch information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// Stash entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
}

/// Detailed commit information (full message + changed files)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDetail {
    pub id: String,
    pub full_id: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub parent_ids: Vec<String>,
    pub files: Vec<CommitFileChange>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

/// A single file changed in a commit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
}

/// Result of a pull operation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitPullResult {
    pub fast_forward: bool,
    pub conflicts: bool,
    pub updated_files: u32,
}

/// A checkpoint entry recovered from git log
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointEntry {
    pub commit_id: String,
    pub label: String,
    pub conversation_id: Option<String>,
    pub timestamp: i64,
    pub file_count: u32,
    pub additions: u32,
    pub deletions: u32,
}

/// Original and modified file contents for diff viewing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffContents {
    pub original: String,
    pub modified: String,
}

/// Result of a single-file revert operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevertFileResult {
    pub success: bool,
    pub file_path: String,
    pub error: Option<String>,
}

/// Result of testing a Git platform token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitTokenTestResult {
    pub success: bool,
    pub message: String,
    pub elapsed_ms: u64,
    pub username: Option<String>,
}

/// One-time credentials supplied from the clone authentication prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitAuthCredentials {
    pub username: Option<String>,
    pub password: String,
}

/// Detailed access check result for clone UI decisions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRepoAccessResult {
    pub accessible: bool,
    pub auth_required: bool,
    pub message: Option<String>,
}

/// Per-file stats in a branch-vs-base comparison.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchDiffFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Summary of what a branch adds on top of its merge base with another
/// branch — the raw material for AI-generated PR descriptions. Committed
/// and uncommitted work are reported separately so callers can describe
/// what will actually end up in the PR (uncommitted changes usually being
/// the user's intended content before they branch/commit/push).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranchSummary {
    pub head_branch: String,
    pub base_branch: String,
    /// Commit subjects in base..HEAD.
    pub commits: Vec<String>,
    /// Committed changes: base → HEAD.
    pub files: Vec<BranchDiffFile>,
    pub total_additions: u32,
    pub total_deletions: u32,
    /// Unified diff truncated to a size safe to embed in a prompt.
    pub patch_excerpt: String,
    /// Uncommitted changes: HEAD → working tree + index (untracked included).
    pub uncommitted_files: Vec<BranchDiffFile>,
    pub uncommitted_additions: u32,
    pub uncommitted_deletions: u32,
    pub uncommitted_patch_excerpt: String,
}

/// Workspace-level statistics derived from the Git repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStats {
    pub total_lines: u64,
    pub total_files: u64,
    pub total_commits: u64,
    pub lines_trend: f64,
    pub files_trend: f64,
    pub commits_trend: f64,
}
