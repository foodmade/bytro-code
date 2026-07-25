use git2::{build::CheckoutBuilder, Diff, DiffOptions, Direction, Repository, Sort, StatusOptions};
use sha2::{Digest, Sha256};
use std::io::BufRead;
use std::path::Path;
use url::Url;

use super::models::*;

/// Open a git repository at the given path.
fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| format!("failed to open repository: {e}"))
}

// ── Read Operations ──────────────────────────────────────────────────

/// Get basic git info (compatible with existing GitInfo interface).
pub fn get_git_info(path: &str) -> Result<GitInfo, String> {
    let repo = match Repository::discover(path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitInfo {
                branch: None,
                modified_count: 0,
                untracked_count: 0,
                ahead: 0,
                behind: 0,
                is_git_repo: false,
                detached_head: false,
                merge_in_progress: false,
            });
        }
    };

    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().map(String::from));
    let detached_head = repo.head_detached().unwrap_or(false);
    let merge_in_progress = repo.state() == git2::RepositoryState::Merge;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut modified_count: u32 = 0;
    let mut untracked_count: u32 = 0;
    for entry in statuses.iter() {
        let s = entry.status();
        if s.contains(git2::Status::WT_NEW) {
            untracked_count += 1;
        } else if s.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            modified_count += 1;
        }
    }

    let (ahead, behind) = calculate_ahead_behind(&repo);

    Ok(GitInfo {
        branch,
        modified_count,
        untracked_count,
        ahead,
        behind,
        is_git_repo: true,
        detached_head,
        merge_in_progress,
    })
}

/// Get detailed file statuses for all changed files.
pub fn get_git_status(path: &str) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in statuses.iter() {
        let s = entry.status();
        let file_path = entry.path().unwrap_or("").to_string();

        // Special case: file was deleted from index but re-created on disk.
        // This commonly happens when AI tools delete-then-recreate files.
        // Present it as a single unstaged "modified" entry instead of
        // confusing dual entries (staged "deleted" + unstaged "untracked").
        if s.contains(git2::Status::INDEX_DELETED) && s.contains(git2::Status::WT_NEW) {
            result.push(GitFileStatus {
                path: file_path,
                status: "modified".to_string(),
                is_staged: false,
                old_path: None,
            });
            continue;
        }

        // Index (staged) statuses
        if s.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED
                | git2::Status::INDEX_TYPECHANGE,
        ) {
            let status_name = if s.contains(git2::Status::INDEX_NEW) {
                "added"
            } else if s.contains(git2::Status::INDEX_MODIFIED) {
                "modified"
            } else if s.contains(git2::Status::INDEX_DELETED) {
                "deleted"
            } else if s.contains(git2::Status::INDEX_RENAMED) {
                "renamed"
            } else {
                "typechange"
            };

            let old_path = entry
                .head_to_index()
                .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().to_string()));

            result.push(GitFileStatus {
                path: file_path.clone(),
                status: status_name.to_string(),
                is_staged: true,
                old_path,
            });
        }

        // Workdir (unstaged) statuses
        if s.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE
                | git2::Status::WT_NEW,
        ) {
            let status_name = if s.contains(git2::Status::WT_NEW) {
                "untracked"
            } else if s.contains(git2::Status::WT_MODIFIED) {
                "modified"
            } else if s.contains(git2::Status::WT_DELETED) {
                "deleted"
            } else if s.contains(git2::Status::WT_RENAMED) {
                "renamed"
            } else {
                "typechange"
            };

            result.push(GitFileStatus {
                path: file_path,
                status: status_name.to_string(),
                is_staged: false,
                old_path: None,
            });
        }
    }

    Ok(result)
}

/// Get diff for all changed files (staged or unstaged).
pub fn get_git_diff(path: &str, staged: bool) -> Result<GitDiffResult, String> {
    let repo = open_repo(path)?;
    let diff = build_diff(&repo, staged)?;
    parse_diff(&diff)
}

/// Get diff for a single file.
pub fn get_file_diff(path: &str, file_path: &str, staged: bool) -> Result<GitDiffFile, String> {
    let repo = open_repo(path)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(file_path);

    let diff = if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
    } else {
        // Match build_diff: include untracked files so single-file diffs
        // resolve for newly-created files too.
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))
    }
    .map_err(|e| e.to_string())?;

    let result = parse_diff(&diff)?;
    result
        .files
        .into_iter()
        .next()
        .ok_or_else(|| "file not found in diff".to_string())
}

/// Get original and modified file contents for diff viewing.
///
/// For staged changes: original = HEAD version, modified = index version.
/// For unstaged changes: original = index version (or HEAD), modified = working tree.
pub fn get_diff_contents(
    path: &str,
    file_path: &str,
    staged: bool,
) -> Result<DiffContents, String> {
    let repo = open_repo(path)?;
    let workdir = repo.workdir().ok_or("bare repository")?;

    let get_blob_content = |tree: &git2::Tree, fp: &str| -> Option<String> {
        tree.get_path(Path::new(fp))
            .ok()
            .and_then(|entry| entry.to_object(&repo).ok())
            .and_then(|obj| obj.as_blob().map(|b| b.content().to_vec()))
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    if staged {
        // staged: original = HEAD, modified = index
        let original = head_tree
            .as_ref()
            .and_then(|t| get_blob_content(t, file_path))
            .unwrap_or_default();

        let index = repo.index().map_err(|e| e.to_string())?;
        let modified = index
            .get_path(Path::new(file_path), 0)
            .and_then(|entry| repo.find_blob(entry.id).ok())
            .and_then(|blob| String::from_utf8(blob.content().to_vec()).ok())
            .unwrap_or_default();

        Ok(DiffContents { original, modified })
    } else {
        // unstaged: original = index (fallback to HEAD), modified = working tree
        let index = repo.index().map_err(|e| e.to_string())?;
        let original = index
            .get_path(Path::new(file_path), 0)
            .and_then(|entry| repo.find_blob(entry.id).ok())
            .and_then(|blob| String::from_utf8(blob.content().to_vec()).ok())
            .or_else(|| {
                head_tree
                    .as_ref()
                    .and_then(|t| get_blob_content(t, file_path))
            })
            .unwrap_or_default();

        let abs_path = workdir.join(file_path);
        let modified = std::fs::read_to_string(&abs_path).unwrap_or_default();

        Ok(DiffContents { original, modified })
    }
}

/// Get commit log entries, optionally filtered by file path.
pub fn get_git_log(
    path: &str,
    limit: Option<u32>,
    file_path: Option<&str>,
) -> Result<Vec<GitLogEntry>, String> {
    let repo = open_repo(path)?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;

    let max = limit.unwrap_or(50) as usize;
    let mut entries = Vec::with_capacity(max);

    for oid_result in revwalk {
        if entries.len() >= max {
            break;
        }
        let oid = oid_result.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        // If file_path is specified, only include commits that touch the file
        if let Some(fp) = file_path {
            let commit_tree = commit.tree().map_err(|e| e.to_string())?;
            let parent_tree = if commit.parent_count() > 0 {
                commit.parent(0).ok().and_then(|p| p.tree().ok())
            } else {
                None
            };
            let mut opts = git2::DiffOptions::new();
            opts.pathspec(fp);
            let diff = repo
                .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))
                .map_err(|e| e.to_string())?;
            if diff.deltas().len() == 0 {
                continue;
            }
        }

        let id = oid.to_string()[..7].to_string();
        let full_id = oid.to_string();
        let message = commit.message().unwrap_or("").trim().to_string();
        let author = commit.author();

        entries.push(GitLogEntry {
            id,
            full_id,
            message,
            author: author.name().unwrap_or("Unknown").to_string(),
            email: author.email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            parent_count: commit.parent_count(),
        });
    }

    Ok(entries)
}

/// Get the diff patch text for a specific file in a specific commit.
pub fn get_file_diff_in_commit(
    path: &str,
    commit_id: &str,
    file_path: &str,
) -> Result<String, String> {
    let repo = open_repo(path)?;
    let commit = repo
        .revparse_single(commit_id)
        .map_err(|e| format!("commit not found: {e}"))?
        .peel_to_commit()
        .map_err(|e| format!("commit not found: {e}"))?;

    let commit_tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = if commit.parent_count() > 0 {
        commit.parent(0).ok().and_then(|p| p.tree().ok())
    } else {
        None
    };

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;

    let mut patch_text = String::new();
    for delta_idx in 0..diff.deltas().len() {
        if let Ok(Some(mut patch)) = git2::Patch::from_diff(&diff, delta_idx) {
            if let Ok(buf) = patch.to_buf() {
                patch_text.push_str(&String::from_utf8_lossy(&buf));
            }
        }
    }

    Ok(patch_text)
}

/// Get all branches (local and remote).
pub fn get_git_branches(path: &str) -> Result<Vec<GitBranchInfo>, String> {
    let repo = open_repo(path)?;
    let branches = repo.branches(None).map_err(|e| e.to_string())?;

    let head_ref = repo.head().ok();
    let current_branch = head_ref
        .as_ref()
        .and_then(|h| h.shorthand().map(String::from));

    let mut result = Vec::new();
    for branch_result in branches {
        let (branch, branch_type) = branch_result.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();
        let is_remote = branch_type == git2::BranchType::Remote;
        let is_current = !is_remote
            && current_branch
                .as_deref()
                .map(|c| c == name)
                .unwrap_or(false);

        let upstream = branch
            .upstream()
            .ok()
            .and_then(|u| u.name().ok().flatten().map(String::from));

        let (ahead, behind) = if !is_remote {
            branch_ahead_behind(&repo, &branch)
        } else {
            (0, 0)
        };

        result.push(GitBranchInfo {
            name,
            is_current,
            is_remote,
            upstream,
            ahead,
            behind,
        });
    }

    Ok(result)
}

/// Get stash list.
pub fn get_git_stash_list(path: &str) -> Result<Vec<GitStashEntry>, String> {
    let repo = open_repo(path)?;
    let mut stashes = Vec::new();

    // stash_foreach requires &mut repo
    let mut repo = repo;
    repo.stash_foreach(|index, message, _oid| {
        stashes.push(GitStashEntry {
            index,
            message: message.to_string(),
        });
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(stashes)
}

/// Get detailed information about a specific commit (message, author, changed files).
/// Accepts both full 40-char SHAs and short SHAs (7+ chars).
pub fn get_commit_detail(path: &str, commit_id: &str) -> Result<CommitDetail, String> {
    let repo = open_repo(path)?;
    // Use revparse_single so both full and abbreviated SHAs (and refs) are accepted.
    let commit = repo
        .revparse_single(commit_id)
        .map_err(|e| format!("commit not found: {e}"))?
        .peel_to_commit()
        .map_err(|e| format!("commit not found: {e}"))?;

    let commit_tree = commit.tree().map_err(|e| e.to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        commit.parent(0).ok().and_then(|p| p.tree().ok())
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        .map_err(|e| e.to_string())?;

    let stats = diff.stats().map_err(|e| e.to_string())?;
    let total_additions = stats.insertions() as u32;
    let total_deletions = stats.deletions() as u32;

    let mut files = Vec::new();
    for delta_idx in 0..diff.deltas().len() {
        let delta = diff.get_delta(delta_idx).unwrap();
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().to_string());

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified",
            git2::Delta::Renamed => "renamed",
            git2::Delta::Copied => "copied",
            _ => "modified",
        };

        let is_binary = delta.flags().contains(git2::DiffFlags::BINARY);

        let mut additions: u32 = 0;
        let mut deletions: u32 = 0;
        if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, delta_idx) {
            let (_, adds, dels) = patch.line_stats().unwrap_or((0, 0, 0));
            additions = adds as u32;
            deletions = dels as u32;
        }

        files.push(CommitFileChange {
            path: new_path,
            old_path,
            status: status.to_string(),
            additions,
            deletions,
            is_binary,
        });
    }

    let parent_ids: Vec<String> = (0..commit.parent_count())
        .filter_map(|i| commit.parent_id(i).ok())
        .map(|oid| oid.to_string()[..7].to_string())
        .collect();

    let author = commit.author();

    let full_sha = commit.id().to_string();
    Ok(CommitDetail {
        id: full_sha[..7].to_string(),
        full_id: full_sha,
        message: commit.message().unwrap_or("").trim().to_string(),
        author: author.name().unwrap_or("Unknown").to_string(),
        email: author.email().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
        parent_ids,
        files,
        total_additions,
        total_deletions,
    })
}

// ── Write Operations ─────────────────────────────────────────────────

/// Stage specified files (add to index).
pub fn stage_files(path: &str, files: &[String]) -> Result<(), String> {
    let repo = open_repo(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repository has no working directory".to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    for file in files {
        let file_path = Path::new(file);
        // Check if file exists on disk; if not, treat as deleted (remove from index)
        let full_path = workdir.join(file_path);
        if full_path.exists() {
            index
                .add_path(file_path)
                .map_err(|e| format!("failed to stage {file}: {e}"))?;
        } else {
            index
                .remove_path(file_path)
                .map_err(|e| format!("failed to stage deletion of {file}: {e}"))?;
        }
    }

    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

/// Unstage specified files (reset index to HEAD).
pub fn unstage_files(path: &str, files: &[String]) -> Result<(), String> {
    let repo = open_repo(path)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let head_tree = head.tree().map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in files {
        let file_path = Path::new(file);
        // Try to get entry from HEAD tree
        match head_tree.get_path(file_path) {
            Ok(entry) => {
                let obj = entry.to_object(&repo).map_err(|e| e.to_string())?;
                let blob = obj.as_blob().ok_or("not a blob")?;
                let index_entry = git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: entry.filemode() as u32,
                    uid: 0,
                    gid: 0,
                    file_size: blob.content().len() as u32,
                    id: entry.id(),
                    flags: 0,
                    flags_extended: 0,
                    path: file.as_bytes().to_vec(),
                };
                index
                    .add(&index_entry)
                    .map_err(|e| format!("failed to unstage {file}: {e}"))?;
            }
            Err(_) => {
                // File was newly added; remove from index entirely
                index
                    .remove_path(file_path)
                    .map_err(|e| format!("failed to unstage {file}: {e}"))?;
            }
        }
    }

    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

/// Discard changes in working directory for specified files.
///
/// Tracked files (present in HEAD) are restored via checkout_head.
/// Untracked files (not in HEAD) are deleted from disk.
pub fn discard_files(path: &str, files: &[String]) -> Result<(), String> {
    let repo = open_repo(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repository has no working directory".to_string())?;

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let mut tracked = Vec::new();
    let mut untracked = Vec::new();

    for file in files {
        let in_head = head_tree
            .as_ref()
            .and_then(|tree| tree.get_path(Path::new(file)).ok())
            .is_some();
        if in_head {
            tracked.push(file.as_str());
        } else {
            untracked.push(file.as_str());
        }
    }

    // Restore tracked files from HEAD
    if !tracked.is_empty() {
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.force();
        for file in &tracked {
            checkout_builder.path(*file);
        }
        repo.checkout_head(Some(&mut checkout_builder))
            .map_err(|e| format!("failed to discard changes: {e}"))?;
    }

    // Delete untracked files from disk
    for file in &untracked {
        let full_path = workdir.join(file);
        if full_path.is_file() {
            std::fs::remove_file(&full_path)
                .map_err(|e| format!("failed to delete untracked file {file}: {e}"))?;
        } else if full_path.is_dir() {
            std::fs::remove_dir_all(&full_path)
                .map_err(|e| format!("failed to delete untracked directory {file}: {e}"))?;
        }
    }

    Ok(())
}

/// Remove files from the index only (git rm --cached), keeping them on disk.
pub fn rm_cached(path: &str, files: &[String]) -> Result<(), String> {
    let repo = open_repo(path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in files {
        index
            .remove_path(Path::new(file))
            .map_err(|e| format!("failed to rm --cached {file}: {e}"))?;
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

/// Create a commit from the current index.
pub fn commit(path: &str, message: &str) -> Result<String, String> {
    let repo = open_repo(path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let sig = repo.signature().map_err(|e| {
        format!("failed to get signature (configure user.name and user.email): {e}")
    })?;

    let head = repo.head().ok();
    let parent_commit = head.as_ref().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| e.to_string())?;

    Ok(oid.to_string()[..7].to_string())
}

/// Create a new local branch from HEAD.
pub fn create_branch(path: &str, name: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| e.to_string())?;
    repo.branch(name, &head, false)
        .map_err(|e| format!("failed to create branch '{name}': {e}"))?;
    Ok(())
}

/// Switch to an existing branch.
pub fn switch_branch(path: &str, name: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let refname = format!("refs/heads/{name}");

    let obj = repo
        .revparse_single(&refname)
        .map_err(|e| format!("branch '{name}' not found: {e}"))?;

    let mut checkout_opts = CheckoutBuilder::new();
    checkout_opts.force().remove_untracked(true);

    repo.checkout_tree(&obj, Some(&mut checkout_opts))
        .map_err(|e| format!("failed to checkout branch '{name}': {e}"))?;
    repo.set_head(&refname)
        .map_err(|e| format!("failed to set HEAD to '{name}': {e}"))?;

    Ok(())
}

/// Pull from remote (fetch + fast-forward merge).
pub fn pull(
    path: &str,
    tokens: std::collections::HashMap<String, String>,
    credentials: Option<GitAuthCredentials>,
) -> Result<GitPullResult, String> {
    let repo = open_repo(path)?;

    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .ok_or("HEAD is not on a branch")?
        .to_string();

    // Find remote for current branch
    let remote_name = repo
        .branch_upstream_remote(&format!("refs/heads/{branch_name}"))
        .map(|b| b.as_str().unwrap_or("origin").to_string())
        .unwrap_or_else(|_| "origin".to_string());

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("remote '{remote_name}' not found: {e}"))?;
    let remote_url = remote.url().unwrap_or_default().to_string();

    // Fetch
    let mut fetch_opts = git2::FetchOptions::new();
    let callbacks =
        super::credentials::build_remote_callbacks_with_credentials(&repo, tokens, credentials);
    fetch_opts.remote_callbacks(callbacks);

    remote
        .fetch(&[&branch_name], Some(&mut fetch_opts), None)
        .map_err(|e| public_git_remote_error("Git fetch failed", &e.to_string(), &remote_url))?;

    // Find upstream branch
    let fetch_head = repo
        .find_reference("FETCH_HEAD")
        .map_err(|e| e.to_string())?;
    let fetch_commit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;

    let (merge_analysis, _) = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| e.to_string())?;

    if merge_analysis.is_up_to_date() {
        return Ok(GitPullResult {
            fast_forward: false,
            conflicts: false,
            updated_files: 0,
        });
    }

    if merge_analysis.is_fast_forward() {
        let refname = format!("refs/heads/{branch_name}");
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        reference
            .set_target(fetch_commit.id(), "fast-forward pull")
            .map_err(|e| e.to_string())?;
        repo.set_head(&refname).map_err(|e| e.to_string())?;

        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.force();
        repo.checkout_head(Some(&mut checkout))
            .map_err(|e| e.to_string())?;

        return Ok(GitPullResult {
            fast_forward: true,
            conflicts: false,
            updated_files: 0,
        });
    }

    // Normal merge needed — perform merge
    let mut merge_opts = git2::MergeOptions::new();
    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    checkout_opts.safe(); // don't overwrite uncommitted changes

    repo.merge(
        &[&fetch_commit],
        Some(&mut merge_opts),
        Some(&mut checkout_opts),
    )
    .map_err(|e| format!("merge failed: {e}"))?;

    let mut index = repo
        .index()
        .map_err(|e| format!("failed to get index: {e}"))?;
    let has_conflicts = index.has_conflicts();

    if has_conflicts {
        // Leave the repo in merge state so user can resolve conflicts
        return Ok(GitPullResult {
            fast_forward: false,
            conflicts: true,
            updated_files: 0,
        });
    }

    // No conflicts — create the merge commit to finalize the pull
    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("failed to write tree: {e}"))?;
    index
        .write()
        .map_err(|e| format!("failed to write index: {e}"))?;

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("failed to find tree: {e}"))?;
    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("failed to get HEAD commit: {e}"))?;
    let fetch_commit_obj = repo
        .find_commit(fetch_commit.id())
        .map_err(|e| format!("failed to find fetch commit: {e}"))?;

    let sig = repo
        .signature()
        .unwrap_or_else(|_| git2::Signature::now("Bytro", "noreply@bytro.community").unwrap());

    let merge_msg = format!("Merge remote-tracking branch 'origin/{branch_name}'");
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &merge_msg,
        &tree,
        &[&head_commit, &fetch_commit_obj],
    )
    .map_err(|e| format!("failed to create merge commit: {e}"))?;

    // Clean up merge state files (MERGE_HEAD, MERGE_MSG, etc.)
    repo.cleanup_state()
        .map_err(|e| format!("failed to cleanup merge state: {e}"))?;

    Ok(GitPullResult {
        fast_forward: false,
        conflicts: false,
        updated_files: 0,
    })
}

/// Push to remote.
pub fn push(
    path: &str,
    tokens: std::collections::HashMap<String, String>,
    credentials: Option<GitAuthCredentials>,
) -> Result<(), String> {
    let repo = open_repo(path)?;

    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .ok_or("HEAD is not on a branch")?
        .to_string();

    let remote_name = repo
        .branch_upstream_remote(&format!("refs/heads/{branch_name}"))
        .map(|b| b.as_str().unwrap_or("origin").to_string())
        .unwrap_or_else(|_| "origin".to_string());

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("remote '{remote_name}' not found: {e}"))?;
    let remote_url = remote.url().unwrap_or_default().to_string();

    let mut push_opts = git2::PushOptions::new();
    let callbacks =
        super::credentials::build_remote_callbacks_with_credentials(&repo, tokens, credentials);
    push_opts.remote_callbacks(callbacks);

    let refspec = format!("refs/heads/{branch_name}:refs/heads/{branch_name}");
    remote
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| public_git_remote_error("Git push failed", &e.to_string(), &remote_url))?;

    Ok(())
}

/// Fetch from remote (update remote refs without merging).
pub fn fetch(path: &str, tokens: std::collections::HashMap<String, String>) -> Result<(), String> {
    let repo = open_repo(path)?;

    let head = repo.head().map_err(|e| e.to_string())?;
    let branch_name = head
        .shorthand()
        .ok_or("HEAD is not on a branch")?
        .to_string();

    let remote_name = repo
        .branch_upstream_remote(&format!("refs/heads/{branch_name}"))
        .map(|b| b.as_str().unwrap_or("origin").to_string())
        .unwrap_or_else(|_| "origin".to_string());

    let mut remote = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("remote '{remote_name}' not found: {e}"))?;
    let remote_url = remote.url().unwrap_or_default().to_string();

    let mut fetch_opts = git2::FetchOptions::new();
    let callbacks = super::credentials::build_remote_callbacks(&repo, tokens);
    fetch_opts.remote_callbacks(callbacks);

    remote
        .fetch(&[&branch_name], Some(&mut fetch_opts), None)
        .map_err(|e| public_git_remote_error("Git fetch failed", &e.to_string(), &remote_url))?;

    Ok(())
}

/// Get the remote URL used by the current branch (best-effort).
///
/// Resolves the current branch's upstream remote, falling back to `origin`,
/// and returns its URL. Any failure — detached/unborn HEAD, no matching remote,
/// or a non-UTF-8 URL — yields `Ok(None)` rather than an error, so callers can
/// use it purely to enrich a credential prompt (host label, remember target).
pub fn get_remote_url(path: &str) -> Result<Option<String>, String> {
    let repo = open_repo(path)?;

    let remote_name = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(str::to_string))
        .and_then(|branch| {
            repo.branch_upstream_remote(&format!("refs/heads/{branch}"))
                .ok()
                .and_then(|remote| remote.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| "origin".to_string());

    Ok(repo
        .find_remote(&remote_name)
        .ok()
        .and_then(|remote| remote.url().and_then(safe_git_url_for_display)))
}

/// Save current changes to stash.
pub fn stash_save(path: &str, message: Option<&str>) -> Result<(), String> {
    let repo = open_repo(path)?;
    let mut repo = repo;
    let sig = repo.signature().map_err(|e| e.to_string())?;
    let msg = message.unwrap_or("WIP");

    repo.stash_save(&sig, msg, None)
        .map_err(|e| format!("stash save failed: {e}"))?;
    Ok(())
}

/// Pop a stash entry by index.
pub fn stash_pop(path: &str, index: usize) -> Result<(), String> {
    let repo = open_repo(path)?;
    let mut repo = repo;
    repo.stash_pop(index, None)
        .map_err(|e| format!("stash pop failed: {e}"))?;
    Ok(())
}

// ── Advanced Operations ──────────────────────────────────────────────

/// Create a lightweight tag on a specific commit.
pub fn create_tag(path: &str, name: &str, commit_id: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("invalid commit id: {e}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("commit not found: {e}"))?;
    repo.tag_lightweight(name, commit.as_object(), false)
        .map_err(|e| format!("failed to create tag '{name}': {e}"))?;
    Ok(())
}

/// Create a branch from a specific commit.
pub fn create_branch_from_commit(path: &str, name: &str, commit_id: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("invalid commit id: {e}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("commit not found: {e}"))?;
    repo.branch(name, &commit, false)
        .map_err(|e| format!("failed to create branch '{name}': {e}"))?;
    Ok(())
}

/// Checkout a specific commit (detached HEAD).
pub fn checkout_commit(path: &str, commit_id: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("invalid commit id: {e}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("commit not found: {e}"))?;
    repo.checkout_tree(commit.as_object(), None)
        .map_err(|e| format!("failed to checkout: {e}"))?;
    repo.set_head_detached(oid)
        .map_err(|e| format!("failed to detach HEAD: {e}"))?;
    Ok(())
}

/// Reset current branch to a specific commit.
pub fn reset_to_commit(path: &str, commit_id: &str, mode: &str) -> Result<(), String> {
    let repo = open_repo(path)?;
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("invalid commit id: {e}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("commit not found: {e}"))?;

    let reset_type = match mode {
        "soft" => git2::ResetType::Soft,
        "mixed" => git2::ResetType::Mixed,
        "hard" => git2::ResetType::Hard,
        _ => return Err(format!("invalid reset mode: {mode}")),
    };

    // For hard reset, we must pass a CheckoutBuilder with force() enabled.
    // Passing None uses the default GIT_CHECKOUT_NONE strategy which is a
    // dry-run and will NOT update the working directory — only HEAD and the
    // index get moved, leaving all files appearing as "staged".
    let mut checkout_opts = if reset_type == git2::ResetType::Hard {
        let mut cb = git2::build::CheckoutBuilder::new();
        cb.force();
        cb.remove_untracked(true);
        Some(cb)
    } else {
        None
    };

    repo.reset(commit.as_object(), reset_type, checkout_opts.as_mut())
        .map_err(|e| format!("failed to reset: {e}"))?;
    Ok(())
}

/// Create archive (zip) from a specific commit.
pub fn archive_commit(path: &str, commit_id: &str, output_path: &str) -> Result<(), String> {
    use std::process::Command;
    let output = Command::new("git")
        .args(["archive", "--format=zip", "-o", output_path, commit_id])
        .current_dir(path)
        .output()
        .map_err(|e| format!("failed to run git archive (is git CLI installed?): {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git archive failed: {stderr}"));
    }
    Ok(())
}

/// Check if a remote repository is accessible (public or with stored credentials).
pub fn check_repo_access(
    url: &str,
    tokens: std::collections::HashMap<String, String>,
) -> Result<bool, String> {
    Ok(check_repo_access_detailed(url, tokens, None)?.accessible)
}

/// Check if a remote repository is accessible and report whether HTTPS
/// credentials are likely required.
pub fn check_repo_access_detailed(
    url: &str,
    tokens: std::collections::HashMap<String, String>,
    credentials: Option<GitAuthCredentials>,
) -> Result<GitRepoAccessResult, String> {
    use std::process::Command;

    validate_http_clone_url(url)?;

    if (credentials.is_some() || super::credentials::has_platform_token(url, &tokens))
        && match check_repo_access_with_git2(url, tokens.clone(), credentials.clone()) {
            Ok(()) => return Ok(access_result(true, false, None)),
            Err(err) => {
                let message = sanitize_git_error(&err, url);
                credentials.is_some() && is_http_git_url(url) && is_auth_required_message(&message)
            }
        }
    {
        return Ok(access_result(
            false,
            true,
            Some("Authentication failed for the supplied credentials".to_string()),
        ));
    }

    let output = Command::new("git")
        .args(["ls-remote", "--heads", url])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("failed to run git ls-remote (is git CLI installed?): {e}"))?;

    if output.status.success() {
        return Ok(access_result(true, false, None));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = sanitize_git_error(
        if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        },
        url,
    );
    let auth_required = is_http_git_url(url) && is_auth_required_message(&message);

    let public_message = if auth_required {
        "Authentication failed for the supplied credentials".to_string()
    } else {
        public_git_error("Remote repository access failed", &message)
    };

    Ok(access_result(false, auth_required, Some(public_message)))
}

fn check_repo_access_with_git2(
    url: &str,
    tokens: std::collections::HashMap<String, String>,
    credentials: Option<GitAuthCredentials>,
) -> Result<(), String> {
    let mut remote =
        git2::Remote::create_detached(url).map_err(|e| format!("failed to create remote: {e}"))?;
    let callbacks = super::credentials::build_remote_callbacks_without_repo_with_credentials(
        tokens,
        credentials,
    );
    let connection = remote
        .connect_auth(Direction::Fetch, Some(callbacks), None)
        .map_err(|e| format!("failed to connect remote: {e}"))?;
    connection
        .list()
        .map_err(|e| format!("failed to read remote refs: {e}"))?;
    Ok(())
}

fn access_result(
    accessible: bool,
    auth_required: bool,
    message: Option<String>,
) -> GitRepoAccessResult {
    GitRepoAccessResult {
        accessible,
        auth_required,
        message,
    }
}

/// Clone a remote repository into the given directory.
pub fn clone_repo(
    url: &str,
    target_dir: &str,
    name: Option<&str>,
    branch: Option<&str>,
    tokens: std::collections::HashMap<String, String>,
    credentials: Option<GitAuthCredentials>,
) -> Result<String, String> {
    use std::process::Command;

    validate_http_clone_url(url)?;

    let target = if let Some(n) = name {
        std::path::Path::new(target_dir).join(n)
    } else {
        // Derive folder name from URL
        let repo_name = url
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("repo")
            .trim_end_matches(".git");
        std::path::Path::new(target_dir).join(repo_name)
    };

    if target.exists() {
        return Err(format!(
            "Target directory already exists: {}",
            target.display()
        ));
    }

    let should_try_git2 =
        credentials.is_some() || super::credentials::has_platform_token(url, &tokens);

    let token_clone_error = if should_try_git2 {
        match clone_repo_with_git2(url, &target, branch, tokens.clone(), credentials.clone()) {
            Ok(()) => return Ok(target.to_string_lossy().to_string()),
            Err(err) => {
                remove_partial_clone_target(&target);
                let sanitized = sanitize_git_error(&err, url);
                if credentials.is_some() {
                    return Err(format_auth_aware_clone_error(&sanitized, url));
                }
                Some(sanitized)
            }
        }
    } else {
        None
    };

    let mut args = vec!["clone".to_string()];
    if let Some(b) = branch {
        let b = b.trim();
        if !b.is_empty() {
            args.push("--branch".to_string());
            args.push(b.to_string());
        }
    }
    args.push(url.to_string());
    args.push(target.to_string_lossy().to_string());

    let output = Command::new("git")
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| public_git_error("Unable to start Git clone", &e.to_string()))?;

    if !output.status.success() {
        let stderr = sanitize_git_error(&String::from_utf8_lossy(&output.stderr), url);
        if let Some(token_error) = token_clone_error {
            return Err(format!(
                "git clone failed with configured HTTPS token: {token_error}; git CLI fallback failed: {stderr}"
            ));
        }
        return Err(format_auth_aware_clone_error(&stderr, url));
    }

    Ok(target.to_string_lossy().to_string())
}

fn clone_repo_with_git2(
    url: &str,
    target: &Path,
    branch: Option<&str>,
    tokens: std::collections::HashMap<String, String>,
    credentials: Option<GitAuthCredentials>,
) -> Result<(), String> {
    let mut fetch_opts = git2::FetchOptions::new();
    fetch_opts.remote_callbacks(
        super::credentials::build_remote_callbacks_without_repo_with_credentials(
            tokens,
            credentials,
        ),
    );

    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch_opts);

    if let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        builder.branch(branch);
    }

    builder
        .clone(url, target)
        .map_err(|e| format!("git clone failed: {e}"))?;
    Ok(())
}

fn format_auth_aware_clone_error(message: &str, url: &str) -> String {
    let sanitized = sanitize_git_error(message, url);
    if is_http_git_url(url) && is_auth_required_message(&sanitized) {
        public_git_error("Git clone authentication failed", &sanitized)
    } else {
        public_git_error("Git clone failed", &sanitized)
    }
}

fn is_http_git_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn is_auth_required_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if lower.contains("proxy authentication") || lower.contains("407") {
        return false;
    }

    lower.contains("authentication")
        || lower.contains("authorization")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("http basic")
        || lower.contains("access denied")
        || lower.contains("permission denied")
        || lower.contains("repository not found")
        || lower.contains("401")
        || lower.contains("403")
}

fn sanitize_git_error(message: &str, url: &str) -> String {
    let redacted_url = redact_git_url(url);
    let mut sanitized = if redacted_url != url {
        message.replace(url, &redacted_url)
    } else {
        message.to_string()
    };
    sanitized = redact_urls_with_credentials(&sanitized);
    sanitized.trim().to_string()
}

fn redact_git_url(url: &str) -> String {
    safe_git_url_for_display(url).unwrap_or_default()
}

fn safe_git_url_for_display(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if let Ok(mut parsed) = Url::parse(trimmed) {
        parsed.set_username("").ok()?;
        parsed.set_password(None).ok()?;
        parsed.set_query(None);
        parsed.set_fragment(None);
        return Some(parsed.to_string());
    }

    if is_http_git_url(trimmed) {
        return None;
    }

    let suffix_start = trimmed.find(['?', '#']).unwrap_or(trimmed.len());
    Some(trimmed[..suffix_start].to_string())
}

fn validate_http_clone_url(url: &str) -> Result<(), String> {
    if !is_http_git_url(url) {
        return Ok(());
    }

    let parsed =
        Url::parse(url.trim()).map_err(|_| "Clone URL is not a valid HTTP(S) URL".to_string())?;
    if parsed.host_str().is_none() {
        return Err("Clone URL must include a host".to_string());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Clone URL must not include credentials, query parameters, or fragments; use the credentials dialog"
                .to_string(),
        );
    }
    Ok(())
}

fn public_git_remote_error(category: &str, detail: &str, url: &str) -> String {
    let sanitized = sanitize_git_error(detail, url);
    let public_category = if is_http_git_url(url) && is_auth_required_message(&sanitized) {
        format!("{category}: authentication failed")
    } else {
        category.to_string()
    };
    public_git_error(&public_category, &sanitized)
}

fn public_git_error(category: &str, detail: &str) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    let diagnostic_id = format!("{digest:x}")[..12].to_string();
    eprintln!(
        "[git] {category}; detail_len={}; detail_sha256={diagnostic_id}",
        detail.len()
    );
    format!("{category}. Diagnostic ID: {diagnostic_id}")
}

fn redact_urls_with_credentials(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;

    while let Some(relative_scheme_end) = input[cursor..].find("://") {
        let scheme_end = cursor + relative_scheme_end;
        let mut scheme_start = scheme_end;
        while scheme_start > cursor {
            let prev = input.as_bytes()[scheme_start - 1] as char;
            if prev.is_ascii_alphanumeric() || matches!(prev, '+' | '-' | '.') {
                scheme_start -= 1;
            } else {
                break;
            }
        }

        output.push_str(&input[cursor..scheme_start]);

        let url_end = input[scheme_end + 3..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '(' | '<' | '>'))
            .map(|pos| scheme_end + 3 + pos)
            .unwrap_or(input.len());
        let candidate = &input[scheme_start..url_end];
        output.push_str(&redact_git_url(candidate));
        cursor = url_end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn remove_partial_clone_target(target: &Path) {
    if target.is_dir() {
        let _ = std::fs::remove_dir_all(target);
    } else if target.exists() {
        let _ = std::fs::remove_file(target);
    }
}

/// Create patch file from a specific commit.
pub fn format_patch(path: &str, commit_id: &str, output_path: &str) -> Result<(), String> {
    use std::process::Command;
    let output = Command::new("git")
        .args(["format-patch", "-1", commit_id, "--stdout"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("failed to run git format-patch (is git CLI installed?): {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git format-patch failed: {stderr}"));
    }

    std::fs::write(output_path, &output.stdout)
        .map_err(|e| format!("failed to write patch file: {e}"))?;
    Ok(())
}

// ── Checkpoint Operations (Single Shadow Branch) ─────────────────────
//
// All checkpoints are stored on a single hidden shadow branch:
//
//   refs/heads/_bytro/checkpoints
//
// Conversation ownership is encoded in the commit message:
//
//   [bytro-checkpoint] [conv:<conversation_id>] <label>
//
// This avoids creating one branch per conversation and keeps the
// ref namespace clean.

/// The single shadow branch ref name shared by all conversations.
const SHADOW_REF: &str = "refs/heads/_bytro/checkpoints";

/// Commit message prefix that identifies a checkpoint commit.
const CHECKPOINT_PREFIX: &str = "[bytro-checkpoint]";

/// Format a checkpoint commit message with conversation ownership.
fn checkpoint_message(conv_id: &str, label: &str) -> String {
    let sanitized = label.replace('\n', " ").replace('\r', "");
    format!("{CHECKPOINT_PREFIX} [conv:{conv_id}] {sanitized}")
}

/// Extract conversation_id from a checkpoint commit message.
/// Returns `None` if the message is not a valid checkpoint or has no conv tag.
fn parse_checkpoint_conv_id(message: &str) -> Option<&str> {
    let rest = message.strip_prefix(CHECKPOINT_PREFIX)?.trim_start();
    let after_open = rest.strip_prefix("[conv:")?;
    let end = after_open.find(']')?;
    Some(&after_open[..end])
}

/// Extract the label portion from a checkpoint commit message.
fn parse_checkpoint_label(message: &str) -> &str {
    let Some(rest) = message.strip_prefix(CHECKPOINT_PREFIX) else {
        return message;
    };
    let rest = rest.trim_start();
    // Skip [conv:...] tag if present
    if let Some(after_open) = rest.strip_prefix("[conv:") {
        if let Some(end) = after_open.find(']') {
            return after_open[end + 1..].trim_start();
        }
    }
    rest
}

/// Validate that a commit is a valid checkpoint on the shadow branch.
/// Returns the conversation_id extracted from the commit message.
fn validate_checkpoint_commit(repo: &Repository, oid: git2::Oid) -> Result<String, String> {
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("commit not found: {e}"))?;

    let message = commit.message().unwrap_or("");
    if !message.starts_with(CHECKPOINT_PREFIX) {
        return Err("target commit is not a Bytro checkpoint".to_string());
    }

    parse_checkpoint_conv_id(message)
        .map(|s| s.to_string())
        .ok_or_else(|| "checkpoint commit has no conversation tag".to_string())
}

/// RAII guard that saves the repository's index state on creation and restores
/// it on drop.  This ensures the user's staging area is never left in a
/// corrupted state, even if a panic or early `?` return occurs between the
/// index modification and the explicit restore call.
struct IndexGuard<'a> {
    repo: &'a Repository,
    original_tree_oid: git2::Oid,
    restored: bool,
}

impl<'a> IndexGuard<'a> {
    /// Snapshot the current index state.
    fn new(repo: &'a Repository) -> Result<Self, String> {
        let mut index = repo.index().map_err(|e| e.to_string())?;
        let original_tree_oid = index
            .write_tree()
            .map_err(|e| format!("failed to snapshot original index: {e}"))?;
        Ok(Self {
            repo,
            original_tree_oid,
            restored: false,
        })
    }

    /// Explicitly restore the index.  Marks the guard so `drop` becomes a no-op.
    fn restore(&mut self) -> Result<(), String> {
        if self.restored {
            return Ok(());
        }
        let tree = self
            .repo
            .find_tree(self.original_tree_oid)
            .map_err(|e| e.to_string())?;
        let mut index = self.repo.index().map_err(|e| e.to_string())?;
        index.read_tree(&tree).map_err(|e| e.to_string())?;
        index.write().map_err(|e| e.to_string())?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for IndexGuard<'_> {
    fn drop(&mut self) {
        if !self.restored {
            // Best-effort restore — errors are silently ignored since we are
            // already unwinding (panic or early return).
            if let Ok(tree) = self.repo.find_tree(self.original_tree_oid) {
                if let Ok(mut index) = self.repo.index() {
                    let _ = index.read_tree(&tree);
                    let _ = index.write();
                }
            }
        }
    }
}

/// Build a full-tree OID from the current working directory (all files,
/// respecting .gitignore).
///
/// IMPORTANT: This function temporarily modifies the repository's shared index.
/// Always use `IndexGuard` around calls to this function to ensure the original
/// index state is restored even on error.
fn build_workdir_tree(repo: &Repository) -> Result<git2::Oid, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;

    // Stage everything (respects .gitignore)
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("failed to stage all files: {e}"))?;
    // Handle deletions
    index
        .update_all(["*"].iter(), None)
        .map_err(|e| format!("failed to update index for deletions: {e}"))?;

    // Flush the in-memory index to disk so that write_tree() works reliably
    // across all libgit2 versions.
    index
        .write()
        .map_err(|e| format!("failed to write index: {e}"))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("failed to write tree: {e}"))?;

    Ok(tree_oid)
}

/// Create a checkpoint on the single shadow branch.
///
/// - Captures the full working-tree state as a tree object
/// - Commits it on `_bytro/checkpoints` with conversation_id in the message
/// - Uses `IndexGuard` to guarantee the user's staging area is restored even
///   if an error or panic occurs during tree building
/// - Does NOT modify HEAD or the working directory
/// - Returns the full commit hash
pub fn checkpoint_create(
    path: &str,
    label: &str,
    conversation_id: Option<&str>,
) -> Result<String, String> {
    let conv_id = conversation_id
        .filter(|s| !s.is_empty())
        .unwrap_or("__default__");

    let repo = open_repo(path)?;

    // 1. Create an IndexGuard — saves the current index and guarantees restore
    let mut guard = IndexGuard::new(&repo)?;

    // 2. Build the full working-tree as a tree object (temporarily mutates index)
    let tree_oid = build_workdir_tree(&repo)?;

    // 3. Restore the user's original staging area explicitly (guard also covers panics)
    guard.restore()?;

    // 4. Check if tree is identical to the tip AND belongs to the same conversation
    let prev_commit = repo
        .find_reference(SHADOW_REF)
        .ok()
        .and_then(|r| r.peel_to_commit().ok());

    if let Some(ref prev) = prev_commit {
        if prev.tree_id() == tree_oid {
            let is_same_conv = prev
                .message()
                .and_then(parse_checkpoint_conv_id)
                .is_some_and(|id| id == conv_id);
            if is_same_conv {
                return Ok(prev.id().to_string());
            }
        }
    }

    // 5. Create the checkpoint commit on the single shadow branch
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = repo.signature().map_err(|e| {
        format!("failed to get signature (configure user.name and user.email): {e}")
    })?;

    let message = checkpoint_message(conv_id, label);

    let parents: Vec<&git2::Commit> = prev_commit.iter().collect();
    let oid = repo
        .commit(Some(SHADOW_REF), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("failed to create checkpoint commit: {e}"))?;

    Ok(oid.to_string())
}

/// Restore the working directory to the state BEFORE a checkpoint was created.
///
/// Semantics: clicking checkpoint C restores the state that existed right
/// before C's changes were made (i.e. the parent commit's tree).
///
/// - Validates the target commit is a Bytro checkpoint
/// - Creates a safety checkpoint before restore if there are uncommitted changes
/// - Checks out the parent commit's tree (not the checkpoint's own tree)
/// - Does NOT move HEAD — only replaces working directory files
pub fn checkpoint_restore(
    path: &str,
    commit_id: &str,
    conversation_id: Option<&str>,
) -> Result<(), String> {
    let oid = git2::Oid::from_str(commit_id).map_err(|e| format!("invalid commit id: {e}"))?;

    // 1. Validate commit is a checkpoint and check for uncommitted changes
    let (has_changes, found_conv_id) = {
        let repo = open_repo(path)?;
        let found_conv_id = validate_checkpoint_commit(&repo, oid)?;

        let mut status_opts = git2::StatusOptions::new();
        status_opts.include_untracked(true);
        let statuses = repo
            .statuses(Some(&mut status_opts))
            .map_err(|e| e.to_string())?;
        let has_changes = statuses.iter().any(|entry| !entry.status().is_empty());

        (has_changes, found_conv_id)
    }; // repo dropped here

    // 2. Create safety checkpoint if there are uncommitted changes
    let safe_conv = conversation_id.unwrap_or(found_conv_id.as_str());
    if has_changes {
        checkpoint_create(path, "auto-save before restore", Some(safe_conv))?;
    }

    // 3. Checkout the PARENT's tree — restores state BEFORE this checkpoint
    let repo = open_repo(path)?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("commit not found: {e}"))?;
    let parent = commit.parent(0).map_err(|_| {
        "cannot restore: this is the first checkpoint, no earlier state exists".to_string()
    })?;
    let target_tree = parent.tree().map_err(|e| e.to_string())?;

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    checkout.remove_untracked(true);

    repo.checkout_tree(target_tree.as_object(), Some(&mut checkout))
        .map_err(|e| format!("failed to checkout checkpoint tree: {e}"))?;

    // 4. Update index to match so `git status` shows a clean state
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.read_tree(&target_tree).map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;

    Ok(())
}

/// List checkpoint commits from the single shadow branch, filtered by
/// conversation_id.  Returns entries in chronological order (oldest first).
pub fn checkpoint_list(
    path: &str,
    conversation_id: Option<&str>,
    limit: u32,
) -> Result<Vec<CheckpointEntry>, String> {
    let conv_id = conversation_id
        .filter(|s| !s.is_empty())
        .unwrap_or("__default__");

    let repo = open_repo(path)?;

    let reference = match repo.find_reference(SHADOW_REF) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let tip_oid = reference.target().ok_or("shadow branch has no target")?;

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push(tip_oid).map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    // Safety cap: stop scanning after MAX_SCAN commits to avoid traversing
    // an unbounded history. The limit only caps matched results.
    const MAX_SCAN: usize = 2000;
    for (scanned, oid_result) in revwalk.enumerate() {
        if entries.len() >= limit as usize || scanned >= MAX_SCAN {
            break;
        }

        let oid = match oid_result {
            Ok(o) => o,
            Err(_) => continue,
        };
        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let message = commit.message().unwrap_or("");
        if !message.starts_with(CHECKPOINT_PREFIX) {
            continue; // Skip non-checkpoint commits (robustness)
        }

        // Filter by conversation_id
        let msg_conv_id = match parse_checkpoint_conv_id(message) {
            Some(id) => id,
            None => continue,
        };
        if msg_conv_id != conv_id {
            continue;
        }

        let label = parse_checkpoint_label(message).to_string();

        let (file_count, additions, deletions) = match commit.parent(0).ok() {
            Some(parent) => diff_stats(&repo, &parent, &commit),
            None => (0, 0, 0),
        };

        entries.push(CheckpointEntry {
            commit_id: oid.to_string(),
            label,
            conversation_id: Some(msg_conv_id.to_string()),
            timestamp: commit.time().seconds(),
            file_count,
            additions,
            deletions,
        });
    }

    entries.reverse();
    Ok(entries)
}

/// Calculate diff stats between two commits.
fn diff_stats(repo: &Repository, parent: &git2::Commit, child: &git2::Commit) -> (u32, u32, u32) {
    let parent_tree = match parent.tree() {
        Ok(t) => t,
        Err(_) => return (0, 0, 0),
    };
    let child_tree = match child.tree() {
        Ok(t) => t,
        Err(_) => return (0, 0, 0),
    };
    let diff = match repo.diff_tree_to_tree(Some(&parent_tree), Some(&child_tree), None) {
        Ok(d) => d,
        Err(_) => return (0, 0, 0),
    };
    match diff.stats() {
        Ok(stats) => (
            stats.files_changed() as u32,
            stats.insertions() as u32,
            stats.deletions() as u32,
        ),
        Err(_) => (0, 0, 0),
    }
}

/// Remove checkpoint commits older than `max_age_secs` from the shadow branch.
///
/// Strategy: collect all commits that should be kept (within the time window),
/// delete the shadow ref, then rebuild the commit chain with only the kept
/// commits.  Orphaned objects will be collected by a subsequent `git gc`.
///
/// Returns the number of removed checkpoint commits.
pub fn checkpoint_cleanup(path: &str, max_age_secs: i64) -> Result<u32, String> {
    let repo = open_repo(path)?;

    // Find shadow branch tip
    let tip = match repo.find_reference(SHADOW_REF) {
        Ok(r) => match r.peel_to_commit() {
            Ok(c) => c,
            Err(_) => return Ok(0),
        },
        Err(_) => return Ok(0),
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let cutoff = now - max_age_secs;

    // Walk the commit chain and partition into keep / discard
    struct KeepEntry {
        tree_oid: git2::Oid,
        message: String,
        time: git2::Time,
        author_name: String,
        author_email: String,
    }

    let mut to_keep: Vec<KeepEntry> = Vec::new();
    let mut total: u32 = 0;

    let mut current = Some(tip);
    while let Some(commit) = current {
        total += 1;
        if commit.time().seconds() >= cutoff {
            to_keep.push(KeepEntry {
                tree_oid: commit.tree_id(),
                message: commit.message().unwrap_or("").to_string(),
                time: commit.time(),
                author_name: commit.author().name().unwrap_or("bytro").to_string(),
                author_email: commit.author().email().unwrap_or("noreply").to_string(),
            });
        }
        current = commit.parent(0).ok();
    }

    let removed = total - to_keep.len() as u32;
    if removed == 0 {
        return Ok(0);
    }

    // Reverse so we rebuild oldest-first
    to_keep.reverse();

    // Delete old shadow ref
    if let Ok(mut r) = repo.find_reference(SHADOW_REF) {
        r.delete()
            .map_err(|e| format!("failed to delete shadow ref: {e}"))?;
    }

    if to_keep.is_empty() {
        // All checkpoints expired — shadow branch fully removed
        return Ok(removed);
    }

    // Rebuild commit chain
    let mut parent: Option<git2::Commit> = None;
    for entry in &to_keep {
        let tree = repo.find_tree(entry.tree_oid).map_err(|e| e.to_string())?;
        let sig = git2::Signature::new(&entry.author_name, &entry.author_email, &entry.time)
            .map_err(|e| e.to_string())?;

        let parents: Vec<&git2::Commit> = parent.iter().collect();
        let oid = repo
            .commit(
                Some(SHADOW_REF),
                &sig,
                &sig,
                &entry.message,
                &tree,
                &parents,
            )
            .map_err(|e| format!("failed to recreate checkpoint: {e}"))?;

        parent = Some(repo.find_commit(oid).map_err(|e| e.to_string())?);
    }

    Ok(removed)
}

/// Migrate checkpoints from old per-conversation shadow branches into the
/// single shared shadow branch, then delete the old branches.
/// Returns the number of old branches cleaned up.
pub fn checkpoint_migrate_legacy_branches(path: &str) -> Result<u32, String> {
    let repo = open_repo(path)?;
    let legacy_prefix = "refs/heads/_bytro/checkpoints/";

    // Collect legacy branch names (excluding the new single branch)
    let legacy_refs: Vec<String> = repo
        .references()
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter_map(|r| r.name().map(|n| n.to_string()))
        .filter(|n| n.starts_with(legacy_prefix))
        .collect();

    if legacy_refs.is_empty() {
        return Ok(0);
    }

    let count = legacy_refs.len() as u32;

    // Delete each legacy branch ref
    for ref_name in &legacy_refs {
        if let Ok(mut reference) = repo.find_reference(ref_name) {
            let _ = reference.delete();
        }
    }

    Ok(count)
}

// ── Helpers ──────────────────────────────────────────────────────────

fn calculate_ahead_behind(repo: &Repository) -> (u32, u32) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (0, 0),
    };
    let local_oid = match head.target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let branch_name = match head.shorthand() {
        Some(name) => name.to_string(),
        None => return (0, 0),
    };
    let upstream_ref = format!("refs/remotes/origin/{branch_name}");
    let upstream_oid = match repo.refname_to_id(&upstream_ref) {
        Ok(oid) => oid,
        Err(_) => return (0, 0),
    };
    repo.graph_ahead_behind(local_oid, upstream_oid)
        .map(|(a, b)| (a as u32, b as u32))
        .unwrap_or((0, 0))
}

fn branch_ahead_behind(repo: &Repository, branch: &git2::Branch) -> (u32, u32) {
    let local_oid = match branch.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    let upstream = match branch.upstream() {
        Ok(u) => u,
        Err(_) => return (0, 0),
    };
    let upstream_oid = match upstream.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };
    repo.graph_ahead_behind(local_oid, upstream_oid)
        .map(|(a, b)| (a as u32, b as u32))
        .unwrap_or((0, 0))
}

fn build_diff(repo: &Repository, staged: bool) -> Result<Diff<'_>, String> {
    if staged {
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), None, None)
            .map_err(|e| e.to_string())
    } else {
        // Include untracked files as full additions so list-level diff stats
        // cover newly-created files. Keep a blob cap to avoid streaming large
        // accidental binaries through IPC.
        let mut opts = DiffOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true)
            .max_size(5 * 1024 * 1024);
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.to_string())
    }
}

fn parse_diff(diff: &Diff<'_>) -> Result<GitDiffResult, String> {
    let mut files = Vec::new();

    let stats = diff.stats().map_err(|e| e.to_string())?;
    let total_additions = stats.insertions() as u32;
    let total_deletions = stats.deletions() as u32;

    // Iterate over deltas
    for delta_idx in 0..diff.deltas().len() {
        let delta = diff.get_delta(delta_idx).unwrap();
        let new_file_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_file_path = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().to_string());
        let is_binary = delta.flags().contains(git2::DiffFlags::BINARY);

        let mut hunks = Vec::new();
        let mut file_additions: u32 = 0;
        let mut file_deletions: u32 = 0;

        let patch = git2::Patch::from_diff(diff, delta_idx).map_err(|e| e.to_string())?;
        if let Some(patch) = patch {
            for hunk_idx in 0..patch.num_hunks() {
                let (hunk, _) = patch.hunk(hunk_idx).map_err(|e| e.to_string())?;
                let header = String::from_utf8_lossy(hunk.header()).to_string();
                let mut lines = Vec::new();

                let num_lines = patch
                    .num_lines_in_hunk(hunk_idx)
                    .map_err(|e| e.to_string())?;
                for line_idx in 0..num_lines {
                    let line = patch
                        .line_in_hunk(hunk_idx, line_idx)
                        .map_err(|e| e.to_string())?;
                    let content = String::from_utf8_lossy(line.content()).to_string();
                    let line_type = match line.origin() {
                        '+' => {
                            file_additions += 1;
                            "add"
                        }
                        '-' => {
                            file_deletions += 1;
                            "delete"
                        }
                        _ => "context",
                    };

                    lines.push(GitDiffLine {
                        content,
                        line_type: line_type.to_string(),
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                    });
                }

                hunks.push(GitDiffHunk { header, lines });
            }
        }

        files.push(GitDiffFile {
            path: new_file_path,
            old_path: old_file_path,
            hunks,
            additions: file_additions,
            deletions: file_deletions,
            is_binary,
        });
    }

    Ok(GitDiffResult {
        files,
        total_additions,
        total_deletions,
    })
}

// ── Workspace Stats ─────────────────────────────────────────────────

/// Source code file extensions (lowercase, without leading dot).
/// Only actual programming / markup / style files — excludes docs, config, data.
const SOURCE_CODE_EXTENSIONS: &[&str] = &[
    // Rust
    "rs", // TypeScript / JavaScript
    "ts", "tsx", "js", "jsx", "mjs", "cjs", // Python
    "py", "pyw", // Go
    "go",  // Java / Kotlin
    "java", "kt", "kts", // C / C++
    "c", "cpp", "cc", "cxx", "h", "hpp", "hxx", // C#
    "cs",  // Swift / Objective-C
    "swift", "m", "mm",   // Ruby
    "rb",   // PHP
    "php",  // Dart
    "dart", // Lua
    "lua",  // Shell
    "sh", "bash", "zsh", "fish", // Web markup & styles
    "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", // SQL
    "sql",    // GraphQL
    "graphql", "gql", // Elixir / Erlang
    "ex", "exs", "erl",   // Haskell
    "hs",    // Scala
    "scala", // Zig
    "zig",
];

/// File name patterns for generated / lock files that should be excluded.
const GENERATED_FILE_NAMES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "cargo.lock",
    "composer.lock",
    "gemfile.lock",
    "poetry.lock",
    "pubspec.lock",
    "go.sum",
    "flake.lock",
];

/// Path segments that indicate generated / vendored directories.
const GENERATED_DIR_SEGMENTS: &[&str] = &[
    "node_modules/",
    "vendor/",
    "dist/",
    ".next/",
    "__pycache__/",
    "target/debug/",
    "target/release/",
    ".git/",
];

/// Check if a relative path points to a source code file by extension.
fn is_source_code_file(rel_path: &str) -> bool {
    let lower = rel_path.to_ascii_lowercase();
    match lower.rsplit_once('.') {
        Some((_, ext)) => SOURCE_CODE_EXTENSIONS.contains(&ext),
        None => false,
    }
}

/// Check if a relative path is a known generated / lock / vendored file.
fn is_generated_file(rel_path: &str) -> bool {
    let lower = rel_path.to_ascii_lowercase();

    // Minified files
    if lower.ends_with(".min.js") || lower.ends_with(".min.css") {
        return true;
    }

    // Lock / generated file names (check the last path component)
    if let Some(name) = lower
        .rsplit('/')
        .next()
        .or_else(|| lower.rsplit('\\').next())
    {
        if GENERATED_FILE_NAMES.contains(&name) {
            return true;
        }
    }

    // Generated / vendored directories
    for seg in GENERATED_DIR_SEGMENTS {
        if lower.contains(seg) {
            return true;
        }
    }

    false
}

/// Compute workspace statistics from a Git repository.
pub fn get_workspace_stats(path: &str) -> Result<WorkspaceStats, String> {
    let repo = open_repo(path)?;
    let workdir = repo.workdir().ok_or("bare repository")?;

    // ── 1. Tracked files & line count ──────────────────────────────
    let index = repo.index().map_err(|e| e.to_string())?;
    let mut total_files: u64 = 0;
    let mut total_lines: u64 = 0;

    for entry in index.iter() {
        let rel = String::from_utf8_lossy(&entry.path);
        let rel_str = rel.as_ref();

        // Skip non-source-code files by extension
        if !is_source_code_file(rel_str) {
            continue;
        }

        // Skip known generated / lock files
        if is_generated_file(rel_str) {
            continue;
        }

        let abs = workdir.join(rel_str);

        if !abs.is_file() {
            continue;
        }

        // Binary detection: read first 8 KB, skip if contains \0
        let Ok(file) = std::fs::File::open(&abs) else {
            continue;
        };
        let mut reader = std::io::BufReader::new(file);
        let mut header = [0u8; 8192];
        let n = std::io::Read::read(&mut reader, &mut header).unwrap_or(0);
        if header[..n].contains(&0) {
            continue;
        }

        total_files += 1;

        let Ok(file2) = std::fs::File::open(&abs) else {
            continue;
        };
        let buf = std::io::BufReader::new(file2);
        total_lines += buf.lines().count() as u64;
    }

    // ── 2. Commit count & weekly buckets ───────────────────────────
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let seven_days = 7 * 24 * 3600_i64;
    let boundary_this = now - seven_days;
    let boundary_last = now - 2 * seven_days;

    let mut total_commits: u64 = 0;
    let mut commits_this_week: u64 = 0;
    let mut commits_last_week: u64 = 0;
    let mut commit_7d_ago_oid: Option<git2::Oid> = None;

    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
            revwalk.push(oid).map_err(|e| e.to_string())?;
            revwalk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;

            for step in revwalk {
                let Ok(id) = step else { continue };
                let Ok(commit) = repo.find_commit(id) else {
                    continue;
                };
                let ts = commit.time().seconds();
                total_commits += 1;

                if ts >= boundary_this {
                    commits_this_week += 1;
                } else if ts >= boundary_last {
                    commits_last_week += 1;
                    commit_7d_ago_oid = Some(id);
                }
            }
        }
    }

    let commits_trend = if commits_last_week > 0 {
        (commits_this_week as f64 - commits_last_week as f64) / commits_last_week as f64
    } else if commits_this_week > 0 {
        1.0
    } else {
        0.0
    };

    // ── 3. Files & lines trend via diff (source-code only) ─────────
    let (lines_trend, files_trend) = match commit_7d_ago_oid {
        Some(old_oid) => {
            let old_commit = repo.find_commit(old_oid).map_err(|e| e.to_string())?;
            let old_tree = old_commit.tree().map_err(|e| e.to_string())?;
            let head_commit = repo
                .head()
                .and_then(|h| h.peel_to_commit())
                .map_err(|e| e.to_string())?;
            let head_tree = head_commit.tree().map_err(|e| e.to_string())?;

            let mut diff_opts = DiffOptions::new();
            let diff = repo
                .diff_tree_to_tree(Some(&old_tree), Some(&head_tree), Some(&mut diff_opts))
                .map_err(|e| e.to_string())?;

            // Only count source-code files (matching the filter used for total_lines)
            let mut insertions: i64 = 0;
            let mut deletions: i64 = 0;
            let mut files_added: i64 = 0;
            let mut files_deleted: i64 = 0;

            for delta_idx in 0..diff.deltas().len() {
                let delta = diff.get_delta(delta_idx).unwrap();
                let file_path = delta
                    .new_file()
                    .path()
                    .or_else(|| delta.old_file().path())
                    .and_then(|p| p.to_str())
                    .unwrap_or("");

                if !is_source_code_file(file_path) || is_generated_file(file_path) {
                    continue;
                }

                match delta.status() {
                    git2::Delta::Added => files_added += 1,
                    git2::Delta::Deleted => files_deleted += 1,
                    _ => {}
                }
            }

            // Count insertions/deletions only for source-code files.
            // NOTE: file_cb must always return `true` — returning `false`
            // aborts the entire iteration in libgit2 (GIT_EUSER).
            // Filtering is done inside line_cb instead.
            diff.foreach(
                &mut |_delta, _progress| true,
                None,
                None,
                Some(&mut |delta, _hunk, line| {
                    let fp = delta
                        .new_file()
                        .path()
                        .or_else(|| delta.old_file().path())
                        .and_then(|p| p.to_str())
                        .unwrap_or("");
                    if is_source_code_file(fp) && !is_generated_file(fp) {
                        match line.origin() {
                            '+' => insertions += 1,
                            '-' => deletions += 1,
                            _ => {}
                        }
                    }
                    true
                }),
            )
            .map_err(|e| e.to_string())?;

            let net_lines = insertions - deletions;
            let old_lines = (total_lines as i64 - net_lines).max(1);
            let lt = (net_lines as f64 / old_lines as f64).clamp(-10.0, 10.0);

            let net_files = files_added - files_deleted;
            let old_files = (total_files as i64 - net_files).max(1);
            let ft = (net_files as f64 / old_files as f64).clamp(-10.0, 10.0);

            (lt, ft)
        }
        None => (0.0, 0.0),
    };

    Ok(WorkspaceStats {
        total_lines,
        total_files,
        total_commits,
        lines_trend,
        files_trend,
        commits_trend,
    })
}

// ── Single-File Revert ──────────────────────────────────────────────

/// Revert a single file's changes using a unified diff.
///
/// `path`      – workspace root
/// `file_path` – relative file path (as shown in the diff)
/// `file_diff` – the unified diff section for this single file
/// `file_kind` – "M" (modified), "A" (added by AI), "D" (deleted by AI)
pub fn revert_file_from_diff(
    path: &str,
    file_path: &str,
    file_diff: &str,
    file_kind: &str,
) -> Result<RevertFileResult, String> {
    let workspace = Path::new(path);
    let target = workspace.join(file_path);

    match file_kind {
        "A" => {
            // File was created by AI — revert means delete it
            if target.exists() {
                std::fs::remove_file(&target).map_err(|e| format!("failed to delete file: {e}"))?;
                // Remove empty parent directories left behind
                if let Some(parent) = target.parent() {
                    let _ = remove_empty_parents(parent, workspace);
                }
            }
            Ok(RevertFileResult {
                success: true,
                file_path: file_path.to_string(),
                error: None,
            })
        }
        "D" => {
            // File was deleted by AI — revert means recreate from diff's removed lines
            let content = extract_deleted_content(file_diff);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("failed to create parent dirs: {e}"))?;
            }
            std::fs::write(&target, content).map_err(|e| format!("failed to write file: {e}"))?;
            Ok(RevertFileResult {
                success: true,
                file_path: file_path.to_string(),
                error: None,
            })
        }
        "M" => {
            // File was modified by AI — apply reverse patch
            revert_modified_file(workspace, file_path, file_diff)
        }
        _ => Err(format!("unknown file_kind: {file_kind}")),
    }
}

/// Apply reverse patch for a modified file.
/// Primary: `git apply --reverse` on the original diff.
/// Fallback: content-based matching (finds the new content in file and replaces with old).
fn revert_modified_file(
    workspace: &Path,
    file_path: &str,
    file_diff: &str,
) -> Result<RevertFileResult, String> {
    // Primary: use git's built-in --reverse flag on the ORIGINAL diff
    let tmp_dir = std::env::temp_dir();
    let tmp_name = format!("bytro_revert_{}.patch", std::process::id());
    let tmp_path = tmp_dir.join(&tmp_name);

    std::fs::write(&tmp_path, file_diff).map_err(|e| format!("failed to write temp patch: {e}"))?;

    let result = std::process::Command::new("git")
        .args(["apply", "--reverse", "--whitespace=nowarn"])
        .arg(tmp_path.to_string_lossy().as_ref())
        .current_dir(workspace)
        .output();

    let _ = std::fs::remove_file(&tmp_path);

    match result {
        Ok(output) if output.status.success() => Ok(RevertFileResult {
            success: true,
            file_path: file_path.to_string(),
            error: None,
        }),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Fallback: content-based revert (does NOT depend on line numbers)
            match content_based_revert(workspace, file_path, file_diff) {
                Ok(r) => Ok(r),
                Err(manual_err) => Ok(RevertFileResult {
                    success: false,
                    file_path: file_path.to_string(),
                    error: Some(format!(
                        "git apply --reverse failed: {}; content fallback also failed: {}",
                        stderr.trim(),
                        manual_err
                    )),
                }),
            }
        }
        Err(_) => {
            // git not available — try content-based fallback
            match content_based_revert(workspace, file_path, file_diff) {
                Ok(r) => Ok(r),
                Err(e) => Ok(RevertFileResult {
                    success: false,
                    file_path: file_path.to_string(),
                    error: Some(format!(
                        "git not available and content-based revert failed: {e}"
                    )),
                }),
            }
        }
    }
}

/// Extract the original file content from a deletion diff (all `-` lines).
fn extract_deleted_content(diff: &str) -> String {
    let mut content = String::new();
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line.starts_with('-') && !line.starts_with("---") {
            content.push_str(&line[1..]);
            content.push('\n');
        }
    }
    content
}

// ── Fallback revert: line-number hint + content verification ────────

/// A parsed hunk with both sides and a position hint from the hunk header.
struct ContentHunk {
    /// 1-based start line in the NEW (current) file, from `+START` in `@@ ... @@`.
    /// Used as the preferred match position. 0 means unknown.
    hint_start: usize,
    /// Number of lines in the NEW file for this hunk, from `+_,COUNT`.
    _hint_count: usize,
    /// Lines as they appear in the NEW (current) file: context + added lines.
    new_lines: Vec<String>,
    /// Lines as they appear in the OLD (original) file: context + removed lines.
    old_lines: Vec<String>,
}

/// Fallback revert when `git apply --reverse` fails.
///
/// Strategy: **line number first, content search as fallback**.
/// 1. Use the hunk header line number (hint) to locate the range in the file.
/// 2. Verify the content at that position matches the expected new-side lines.
/// 3. If the hint is wrong or absent, fall back to searching the file for the content.
fn content_based_revert(
    workspace: &Path,
    file_path: &str,
    file_diff: &str,
) -> Result<RevertFileResult, String> {
    let target = workspace.join(file_path);
    let current =
        std::fs::read_to_string(&target).map_err(|e| format!("failed to read file: {e}"))?;
    let mut file_lines: Vec<String> = current.lines().map(|l| l.to_string()).collect();

    let hunks = parse_content_hunks(file_diff);
    if hunks.is_empty() {
        return Err("no hunks found in diff".to_string());
    }

    // Apply hunks in reverse order so earlier indices stay valid.
    for hunk in hunks.iter().rev() {
        if hunk.new_lines.is_empty() && hunk.old_lines.is_empty() {
            continue;
        }

        if hunk.new_lines.is_empty() {
            // Pure deletion by AI — skip (need context to locate position).
            continue;
        }

        // Step 1: try the line-number hint from the hunk header
        let hint_idx = if hunk.hint_start > 0 {
            Some(hunk.hint_start - 1)
        } else {
            None
        };
        let pos = find_best_match(&file_lines, &hunk.new_lines, hint_idx);

        match pos {
            Some(p) => {
                let end = p + hunk.new_lines.len();
                file_lines.splice(p..end, hunk.old_lines.iter().cloned());
            }
            None => {
                return Err(format!(
                    "could not locate content to revert ({} lines starting with {:?})",
                    hunk.new_lines.len(),
                    hunk.new_lines.first().unwrap_or(&String::new()),
                ));
            }
        }
    }

    let result = file_lines.join("\n");
    let output = if current.ends_with('\n') && !result.ends_with('\n') {
        format!("{result}\n")
    } else {
        result
    };

    std::fs::write(&target, &output).map_err(|e| format!("failed to write file: {e}"))?;

    Ok(RevertFileResult {
        success: true,
        file_path: file_path.to_string(),
        error: None,
    })
}

/// Parse diff hunks extracting new/old content and the line-number hint.
fn parse_content_hunks(diff: &str) -> Vec<ContentHunk> {
    let mut hunks: Vec<ContentHunk> = Vec::new();
    let mut cur: Option<(usize, usize, Vec<String>, Vec<String>)> = None;

    for line in diff.lines() {
        if line.starts_with("@@") {
            // Flush previous hunk
            if let Some((hs, hc, new_l, old_l)) = cur.take() {
                hunks.push(ContentHunk {
                    hint_start: hs,
                    _hint_count: hc,
                    new_lines: new_l,
                    old_lines: old_l,
                });
            }
            let (hs, hc) = parse_hunk_new_range(line).unwrap_or((0, 0));
            cur = Some((hs as usize, hc as usize, Vec::new(), Vec::new()));
            continue;
        }

        let (_, _, new_lines, old_lines) = match cur.as_mut() {
            Some(c) => c,
            None => continue,
        };

        if line.starts_with('+') && !line.starts_with("+++") {
            new_lines.push(line[1..].to_string());
        } else if line.starts_with('-') && !line.starts_with("---") {
            old_lines.push(line[1..].to_string());
        } else if let Some(stripped) = line.strip_prefix(' ') {
            let content = stripped.to_string();
            new_lines.push(content.clone());
            old_lines.push(content);
        } else if line.is_empty() {
            // Unprefixed empty line inside a hunk — treat as empty context
            new_lines.push(String::new());
            old_lines.push(String::new());
        }
    }

    if let Some((hs, hc, new_l, old_l)) = cur {
        hunks.push(ContentHunk {
            hint_start: hs,
            _hint_count: hc,
            new_lines: new_l,
            old_lines: old_l,
        });
    }
    hunks
}

/// Parse the new-side range from a hunk header: `@@ ... +START,COUNT @@`
fn parse_hunk_new_range(header: &str) -> Option<(u32, u32)> {
    let after_plus = header.split('+').nth(1)?;
    let range_str = after_plus.split("@@").next()?.trim();
    let parts: Vec<&str> = range_str.split(',').collect();
    let start: u32 = parts.first()?.parse().ok()?;
    let count: u32 = if parts.len() > 1 {
        parts[1].parse().ok()?
    } else {
        1
    };
    Some((start, count))
}

/// Check if `needle` matches `haystack` at position `start`.
fn lines_match_at(haystack: &[String], needle: &[String], start: usize) -> bool {
    if start + needle.len() > haystack.len() {
        return false;
    }
    for (j, n) in needle.iter().enumerate() {
        if haystack[start + j].trim_end() != n.trim_end() {
            return false;
        }
    }
    true
}

/// Find the best match position for `needle` in `haystack`.
///
/// Strategy: **line number hint first, proximity search second**.
/// 1. If a hint is provided, try exact match at that position.
/// 2. If that fails, search outward from the hint (±1, ±2, ...).
/// 3. If no hint, do a linear scan from the top.
///
/// This ensures correct results even when hunk header line numbers are wrong
/// (e.g. synthesized diffs), while still preferring the hinted position when
/// duplicate content exists.
fn find_best_match(haystack: &[String], needle: &[String], hint: Option<usize>) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let max_start = haystack.len() - needle.len();

    if let Some(h) = hint {
        // Try exact hint position first
        let h = h.min(max_start);
        if lines_match_at(haystack, needle, h) {
            return Some(h);
        }
        // Expand outward from hint: ±1, ±2, ... up to full file
        let max_offset = max_start.max(h);
        for offset in 1..=max_offset {
            if h + offset <= max_start && lines_match_at(haystack, needle, h + offset) {
                return Some(h + offset);
            }
            if offset <= h && lines_match_at(haystack, needle, h - offset) {
                return Some(h - offset);
            }
        }
        None
    } else {
        // No hint — linear scan
        for i in 0..=max_start {
            if lines_match_at(haystack, needle, i) {
                return Some(i);
            }
        }
        None
    }
}

// ── Git Platform Token Testing ──────────────────────────────────────

fn git_token_request_parts(
    platform: &str,
    token: &str,
) -> Result<(&'static str, &'static str, String), String> {
    match platform {
        "github" => Ok((
            "https://api.github.com/user",
            "Authorization",
            format!("Bearer {token}"),
        )),
        "gitee" => Ok((
            "https://gitee.com/api/v5/user",
            "Authorization",
            format!("token {token}"),
        )),
        "gitlab" => Ok((
            "https://gitlab.com/api/v4/user",
            "PRIVATE-TOKEN",
            token.to_string(),
        )),
        _ => Err(format!("unsupported platform: {platform}")),
    }
}

/// Test a Personal Access Token against a Git platform's API.
/// Supports: github, gitee, gitlab.
pub fn test_git_token(platform: &str, token: &str) -> Result<GitTokenTestResult, String> {
    let start = std::time::Instant::now();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;

    let (url, auth_header, auth_value) = git_token_request_parts(platform, token)?;
    let response = client
        .get(url)
        .header(auth_header, auth_value)
        .header("User-Agent", "Bytro Community")
        .header("Accept", "application/json")
        .send();

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match response {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                let body: serde_json::Value = resp.json().unwrap_or_default();
                let username = match platform {
                    "gitlab" => body
                        .get("username")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    _ => body.get("login").and_then(|v| v.as_str()).map(String::from),
                };
                Ok(GitTokenTestResult {
                    success: true,
                    message: format!("Connected ({}ms)", elapsed_ms),
                    elapsed_ms,
                    username,
                })
            } else {
                let msg = match status.as_u16() {
                    401 => "Invalid token or token expired".to_string(),
                    403 => "Token lacks required permissions".to_string(),
                    _ => format!("HTTP {}", status.as_u16()),
                };
                Ok(GitTokenTestResult {
                    success: false,
                    message: msg,
                    elapsed_ms,
                    username: None,
                })
            }
        }
        Err(e) => {
            let msg = if e.is_timeout() {
                "Connection timed out".to_string()
            } else if e.is_connect() {
                "Failed to connect — check your network".to_string()
            } else {
                "Request failed".to_string()
            };
            Ok(GitTokenTestResult {
                success: false,
                message: msg,
                elapsed_ms,
                username: None,
            })
        }
    }
}

/// Remove empty parent directories up to (but not including) the workspace root.
fn remove_empty_parents(dir: &Path, stop_at: &Path) -> Result<(), std::io::Error> {
    let mut current = dir;
    while current != stop_at && current.starts_with(stop_at) {
        match std::fs::read_dir(current) {
            Ok(mut entries) => {
                if entries.next().is_none() {
                    std::fs::remove_dir(current)?;
                } else {
                    break;
                }
            }
            Err(_) => break,
        }
        current = match current.parent() {
            Some(p) => p,
            None => break,
        };
    }
    Ok(())
}

#[cfg(test)]
mod clone_auth_tests {
    use super::*;

    #[test]
    fn auth_detection_ignores_branch_not_found() {
        assert!(!is_auth_required_message(
            "fatal: Remote branch missing not found in upstream origin"
        ));
    }

    #[test]
    fn auth_detection_ignores_proxy_auth() {
        assert!(!is_auth_required_message(
            "fatal: unable to access: Proxy Authentication Required 407"
        ));
    }

    #[test]
    fn auth_detection_accepts_repository_auth_failures() {
        assert!(is_auth_required_message("fatal: Authentication failed"));
        assert!(is_auth_required_message(
            "fatal: could not read Username: terminal prompts disabled"
        ));
        assert!(is_auth_required_message("remote: Repository not found."));
    }

    #[test]
    fn sanitize_git_error_redacts_url_secrets() {
        let url =
            "https://alice:secret@example.com/org/repo.git?access_token=sentinel-query#sentinel";
        let message = format!("fatal: Authentication failed for '{url}'");

        let sanitized = sanitize_git_error(&message, url);

        assert!(!sanitized.contains("alice:secret"));
        assert!(!sanitized.contains("sentinel"));
        assert!(sanitized.contains("https://example.com/org/repo.git"));
    }

    #[test]
    fn remote_display_url_strips_userinfo_query_and_fragment() {
        let sanitized = safe_git_url_for_display(
            "https://alice:secret@example.com/org/repo.git?token=sentinel#private",
        )
        .unwrap();

        assert_eq!(sanitized, "https://example.com/org/repo.git");
        assert!(!sanitized.contains("alice"));
        assert!(!sanitized.contains("sentinel"));
    }

    #[test]
    fn clone_url_validation_rejects_http_secrets_without_echoing_them() {
        let sentinel = "sentinel-clone-secret";
        for url in [
            format!("https://alice:{sentinel}@example.com/org/repo.git"),
            format!("https://example.com/org/repo.git?token={sentinel}"),
            format!("https://example.com/org/repo.git#{sentinel}"),
        ] {
            let error = validate_http_clone_url(&url).unwrap_err();
            assert!(!error.contains(sentinel));
        }
        assert!(validate_http_clone_url("git@example.com:org/repo.git").is_ok());
        assert!(validate_http_clone_url("ssh://git@example.com/org/repo.git").is_ok());
    }

    #[test]
    fn public_git_errors_do_not_echo_remote_details() {
        let sentinel = "sentinel-git-token";
        let error = public_git_remote_error(
            "Git fetch failed",
            &format!("failed for https://alice:{sentinel}@example.com/org/repo.git"),
            &format!("https://alice:{sentinel}@example.com/org/repo.git"),
        );

        assert!(!error.contains(sentinel));
        assert!(!error.contains("example.com"));
        assert!(error.contains("Diagnostic ID:"));
    }

    #[test]
    fn token_request_urls_never_contain_credentials() {
        let sentinel = "sentinel-token-value";
        for platform in ["github", "gitee", "gitlab"] {
            let (url, _header, value) = git_token_request_parts(platform, sentinel).unwrap();
            assert!(!url.contains(sentinel));
            assert!(value.contains(sentinel));
        }
    }
}
