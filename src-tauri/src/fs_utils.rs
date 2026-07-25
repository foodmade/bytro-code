use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    "__pycache__",
    ".cache",
    ".turbo",
    "build",
    ".svelte-kit",
];

const IGNORED_FILES: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];

/// Reject paths with traversal components as a defense-in-depth measure.
/// In a desktop app the user already has full FS access, but this prevents
/// accidental reads of sensitive files via programmatic path construction.
fn validate_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err(format!("Path traversal not allowed: '{}'", path));
        }
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn log_fs_path(operation: &str, path: &str) {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("<failed to read cwd: {e}>"));
    eprintln!(
        "[fs_utils:path] {operation}: path={path:?}, absolute={}, cwd={cwd:?}",
        Path::new(path).is_absolute()
    );
}

#[cfg(not(debug_assertions))]
fn log_fs_path(_: &str, _: &str) {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangedEvent {
    pub path: String,
    pub change_type: String,
}

pub struct FsWatcherState {
    /// One watcher per window label so each workspace monitors its own directory.
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl FsWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Remove the watcher for a given window label (called on window close).
    pub fn remove_watcher(&self, label: &str) {
        if let Ok(mut state) = self.watchers.lock() {
            state.remove(label);
        }
    }
}

fn is_ignored(name: &str, is_dir: bool) -> bool {
    if is_dir {
        IGNORED_DIRS.contains(&name)
    } else {
        IGNORED_FILES.contains(&name)
    }
}

#[tauri::command]
pub fn read_dir_entries(path: String) -> Result<Vec<DirEntry>, String> {
    validate_path(&path)?;
    let entries = std::fs::read_dir(&path)
        .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?;

    let mut result: Vec<DirEntry> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = metadata.is_dir();

        if is_ignored(&name, is_dir) {
            continue;
        }

        let extension = if is_dir {
            None
        } else {
            Path::new(&name)
                .extension()
                .map(|ext| ext.to_string_lossy().to_string())
        };

        result.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_file: metadata.is_file(),
            size: metadata.len(),
            extension,
        });
    }

    result.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(result)
}

/// Recursively search for files whose name contains the query string.
/// Returns at most `limit` results, sorted by path depth (shallower first).
#[tauri::command]
pub fn search_files(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<DirEntry>, String> {
    validate_path(&root)?;
    let limit = limit.unwrap_or(30);
    let query_lower = query.to_lowercase();

    if query_lower.is_empty() {
        return Ok(Vec::new());
    }

    let mut results: Vec<(usize, DirEntry)> = Vec::new();
    let mut stack: Vec<(String, usize)> = vec![(root.clone(), 0)];

    while let Some((dir_path, depth)) = stack.pop() {
        // Cap recursion depth to avoid extremely deep trees
        if depth > 20 {
            continue;
        }

        let read = match std::fs::read_dir(&dir_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        for entry in read {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = metadata.is_dir();

            if is_ignored(&name, is_dir) {
                continue;
            }

            if is_dir {
                stack.push((entry.path().to_string_lossy().to_string(), depth + 1));
            }

            // Match file name against query
            if name.to_lowercase().contains(&query_lower) {
                let extension = if is_dir {
                    None
                } else {
                    Path::new(&name)
                        .extension()
                        .map(|ext| ext.to_string_lossy().to_string())
                };

                results.push((
                    depth,
                    DirEntry {
                        name,
                        path: entry.path().to_string_lossy().to_string(),
                        is_dir,
                        is_file: metadata.is_file(),
                        size: metadata.len(),
                        extension,
                    },
                ));

                // Early exit if we have way more than needed
                if results.len() >= limit * 3 {
                    break;
                }
            }
        }

        if results.len() >= limit * 3 {
            break;
        }
    }

    // Sort: files first over dirs, then by depth (shallow first), then by name
    results.sort_by(|a, b| {
        a.1.is_dir
            .cmp(&b.1.is_dir)
            .then(a.0.cmp(&b.0))
            .then(a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
    });

    results.truncate(limit);
    Ok(results.into_iter().map(|(_, entry)| entry).collect())
}

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    log_fs_path("read_file_base64", &path);
    validate_path(&path)?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn read_file_content(path: String) -> Result<String, String> {
    log_fs_path("read_file_content", &path);
    validate_path(&path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file '{}': {}", path, e))?;
    // Strip UTF-8 BOM (EF BB BF) if present — it causes JSON parse errors and other issues
    Ok(content
        .strip_prefix('\u{FEFF}')
        .unwrap_or(&content)
        .to_string())
}

#[tauri::command]
pub fn write_file_content(path: String, content: String) -> Result<(), String> {
    log_fs_path("write_file_content", &path);
    validate_path(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }
    // Strip UTF-8 BOM if present to prevent it from being persisted
    let clean = content.strip_prefix('\u{FEFF}').unwrap_or(&content);
    std::fs::write(&path, clean).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

/// Append one diagnostic line to `<app_data_dir>/logs/<category>.log`.
///
/// Used by the cross-session leak guards (frontend chat-session guard + forwarded
/// sidecar `[cross-session-guard]` / `SESSION CHANGED` diagnostics) to persist
/// evidence that survives an app restart — sidecar stderr is not otherwise written
/// to disk, so a transient cross-conversation leak would leave no trace. The caller
/// passes the fully-formatted line (including its own timestamp); this only appends.
/// `category` is sanitized to a safe filename stem.
#[tauri::command]
pub fn append_diagnostics_log(
    app: AppHandle,
    category: String,
    line: String,
) -> Result<(), String> {
    use std::io::Write as _;
    let stem: String = category
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let stem = if stem.is_empty() {
        "diagnostics".to_string()
    } else {
        stem
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create logs dir: {e}"))?;
    let path = dir.join(format!("{stem}.log"));
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("Failed to append diagnostics: {e}"))
}

/// Result of reverting a single AI file edit. Business-level failures
/// (content moved on, ambiguous match, etc.) come back as `success: false`
/// with a machine-readable `error` code the frontend maps to i18n; only an
/// invalid path is surfaced as a hard `Err`.
#[derive(Serialize)]
pub struct RevertEditResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Undo a single file modification using the tool call's own recorded content.
///
/// - **Write** (`is_write = true`): the call created/overwrote the file. Undo
///   means deleting it — Bytro does not snapshot pre-write content, so an
///   overwrite of a pre-existing file cannot be restored this way.
/// - **Edit** (`is_write = false`): replace the single occurrence of
///   `new_string` back with `old_string`. The match must be unique to undo
///   safely: 0 matches means a later edit changed the region; >1 means the
///   target is ambiguous. Both are refused rather than guessed.
#[tauri::command]
pub fn revert_tool_edit(
    file_path: String,
    old_string: String,
    new_string: String,
    is_write: bool,
) -> Result<RevertEditResult, String> {
    log_fs_path("revert_tool_edit", &file_path);
    validate_path(&file_path)?;
    let path = Path::new(&file_path);

    if is_write {
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("Failed to delete file '{}': {}", file_path, e))?;
        }
        return Ok(RevertEditResult {
            success: true,
            error: None,
        });
    }

    // An empty new_string means the edit was a pure deletion of old_string;
    // there is no anchor in the current file to locate where to reinsert it.
    if new_string.is_empty() {
        return Ok(RevertEditResult {
            success: false,
            error: Some("empty_replacement".to_string()),
        });
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return Ok(RevertEditResult {
                success: false,
                error: Some(format!("read_failed: {e}")),
            });
        }
    };

    let count = content.matches(new_string.as_str()).count();
    if count == 0 {
        return Ok(RevertEditResult {
            success: false,
            error: Some("content_not_found".to_string()),
        });
    }
    if count > 1 {
        return Ok(RevertEditResult {
            success: false,
            error: Some("ambiguous_match".to_string()),
        });
    }

    let reverted = content.replacen(new_string.as_str(), &old_string, 1);
    std::fs::write(path, reverted)
        .map_err(|e| format!("Failed to write file '{}': {}", file_path, e))?;

    Ok(RevertEditResult {
        success: true,
        error: None,
    })
}

#[tauri::command]
pub fn write_file_binary(path: String, data: Vec<u8>) -> Result<(), String> {
    log_fs_path("write_file_binary", &path);
    validate_path(&path)?;
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directories: {}", e))?;
        }
    }
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to write binary file '{}': {}", path, e))
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("'{}' already exists", path));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    std::fs::File::create(&path).map_err(|e| format!("Failed to create file '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub fn path_exists(path: String) -> Result<bool, String> {
    validate_path(&path)?;
    Ok(Path::new(&path).exists())
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("'{}' already exists", path));
    }
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
pub fn delete_entry(path: String) -> Result<(), String> {
    validate_path(&path)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("'{}' does not exist", path));
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))?;
    } else {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete file '{}': {}", path, e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn copy_entry(src: String, dest_dir: String) -> Result<String, String> {
    validate_path(&src)?;
    validate_path(&dest_dir)?;
    let src_path = Path::new(&src);
    if !src_path.exists() {
        return Err(format!("'{}' does not exist", src));
    }
    let file_name = src_path
        .file_name()
        .ok_or_else(|| "Invalid source path".to_string())?
        .to_string_lossy()
        .to_string();

    // Generate a unique destination name to avoid conflicts
    let dest_base = Path::new(&dest_dir);
    let mut dest = dest_base.join(&file_name);
    if dest.to_string_lossy() == src {
        // Pasting into same directory — create "name - Copy" variant
        let stem = src_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = src_path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 0u32;
        loop {
            let suffix = if counter == 0 {
                " - Copy".to_string()
            } else {
                format!(" - Copy ({})", counter)
            };
            dest = dest_base.join(format!("{}{}{}", stem, suffix, ext));
            if !dest.exists() {
                break;
            }
            counter += 1;
        }
    } else if dest.exists() {
        let stem = src_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = src_path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 0u32;
        loop {
            let suffix = if counter == 0 {
                " - Copy".to_string()
            } else {
                format!(" - Copy ({})", counter)
            };
            dest = dest_base.join(format!("{}{}{}", stem, suffix, ext));
            if !dest.exists() {
                break;
            }
            counter += 1;
        }
    }

    if src_path.is_dir() {
        copy_dir_recursive(src_path, &dest)?;
    } else {
        std::fs::copy(&src, &dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    }
    Ok(dest.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create directory '{}': {}", dest.display(), e))?;
    let entries = std::fs::read_dir(src)
        .map_err(|e| format!("Failed to read directory '{}': {}", src.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_child = entry.path();
        let dest_child = dest.join(entry.file_name());
        if src_child.is_dir() {
            copy_dir_recursive(&src_child, &dest_child)?;
        } else {
            std::fs::copy(&src_child, &dest_child)
                .map_err(|e| format!("Failed to copy '{}': {}", src_child.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn rename_entry(src: String, dest: String) -> Result<(), String> {
    validate_path(&src)?;
    validate_path(&dest)?;
    let src_path = Path::new(&src);
    if !src_path.exists() {
        return Err(format!("'{}' does not exist", src));
    }
    let dest_path = Path::new(&dest);
    if dest_path.exists() {
        return Err(format!("'{}' already exists", dest));
    }
    std::fs::rename(&src, &dest)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", src, dest, e))?;
    Ok(())
}

#[tauri::command]
pub fn get_cwd() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to get cwd: {}", e))
}

#[tauri::command]
pub fn watch_dir(
    app: AppHandle,
    window: tauri::Window,
    watcher_state: State<'_, FsWatcherState>,
    path: String,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let app_clone = app.clone();
    let label_clone = window_label.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let change_type = match event.kind {
                EventKind::Create(_) => "create",
                EventKind::Modify(_) => "modify",
                EventKind::Remove(_) => "delete",
                _ => return,
            };

            for event_path in &event.paths {
                let path_str = event_path.to_string_lossy().to_string();
                let payload = FileChangedEvent {
                    path: path_str,
                    change_type: change_type.to_string(),
                };
                // Emit to the specific window that owns this watcher.
                if let Some(w) = app_clone.get_webview_window(&label_clone) {
                    let _ = w.emit("file-changed", payload);
                } else {
                    // Fallback: broadcast if window is gone.
                    let _ = app_clone.emit("file-changed", payload);
                }
            }
        }
    })
    .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch directory '{}': {}", path, e))?;

    let mut state = watcher_state.watchers.lock().map_err(|e| e.to_string())?;
    state.insert(window_label, watcher);

    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(
    window: tauri::Window,
    watcher_state: State<'_, FsWatcherState>,
) -> Result<(), String> {
    let mut state = watcher_state.watchers.lock().map_err(|e| e.to_string())?;
    state.remove(window.label());
    Ok(())
}
