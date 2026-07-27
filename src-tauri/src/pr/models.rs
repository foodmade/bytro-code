use serde::{Deserialize, Serialize};

/// Repository identity and merge capabilities resolved from the current
/// branch's remote URL plus the platform's repository API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrRepoInfo {
    pub host: String,
    pub owner: String,
    pub repo: String,
    /// Currently "github"; other hosts yield "unsupported" so the UI can
    /// explain rather than fail on every request.
    pub platform: String,
    pub default_branch: String,
    pub allow_merge_commit: bool,
    pub allow_squash_merge: bool,
    pub allow_rebase_merge: bool,
    pub delete_branch_on_merge: bool,
    pub html_url: String,
    /// Set when the repository API could not be queried (missing token,
    /// private repo, network) and defaults were substituted.
    pub warning: Option<String>,
}

/// One row in the pull-request list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    /// "open" | "closed" | "merged"
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub head_branch: String,
    pub base_branch: String,
    pub html_url: String,
    /// ISO-8601 timestamp straight from the API.
    pub updated_at: String,
}

/// Full pull-request detail for the detail view and merge gating.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub head_branch: String,
    pub base_branch: String,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
    pub body: String,
    pub head_sha: String,
    /// `None` while the platform is still computing mergeability.
    pub mergeable: Option<bool>,
    /// "clean" | "dirty" | "blocked" | "behind" | "unstable" | "draft" | "unknown"
    pub mergeable_state: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub commits: u64,
}

/// A single CI check (check-run or legacy commit status).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrCheck {
    pub name: String,
    /// "queued" | "in_progress" | "completed"
    pub status: String,
    /// "success" | "failure" | "neutral" | "cancelled" | "skipped" |
    /// "timed_out" | "action_required" — `None` until completed.
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
}

/// Aggregated CI state for a head commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrChecksResult {
    /// "none" | "running" | "success" | "failure"
    pub overall: String,
    pub checks: Vec<PrCheck>,
}

/// Result of a merge attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrMergeResult {
    pub merged: bool,
    pub sha: Option<String>,
    pub message: String,
    /// True when the remote head branch was deleted after the merge.
    pub branch_deleted: bool,
}
