use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ── Helpers for flexible deserialization ──────────────────────────────

/// Deserialize a value that may be a string or a number into a String.
/// Claude teams config.json uses numbers for timestamps (e.g., `1770657708516`)
/// while the UI expects strings.
fn string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de;

    struct StringOrNumber;

    impl<'de> de::Visitor<'de> for StringOrNumber {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or a number")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<String, E> {
            Ok(v.to_owned())
        }

        fn visit_string<E: de::Error>(self, v: String) -> Result<String, E> {
            Ok(v)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<String, E> {
            Ok(v.to_string())
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<String, E> {
            Ok(v.to_string())
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<String, E> {
            Ok(v.to_string())
        }

        fn visit_unit<E: de::Error>(self) -> Result<String, E> {
            Ok(String::new())
        }
    }

    deserializer.deserialize_any(StringOrNumber)
}

/// Same as string_or_number but returns empty string as default.
fn string_or_number_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    string_or_number(deserializer)
}

// ── Data Structs ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, deserialize_with = "string_or_number_default")]
    pub created_at: String,
    #[serde(default)]
    pub lead_agent_id: String,
    #[serde(default)]
    pub lead_session_id: String,
    #[serde(default)]
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub name: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub agent_type: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, deserialize_with = "string_or_number_default")]
    pub joined_at: String,
    #[serde(default)]
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessage {
    pub from: String,
    #[serde(default)]
    pub to: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub read: bool,
    #[serde(default)]
    pub message_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTask {
    pub id: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub active_form: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub is_internal: bool,
}

// ── Event Payloads ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamCreatedEvent {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamUpdatedEvent {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInboxChangedEvent {
    pub team: String,
    pub agent: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTaskChangedEvent {
    pub team: String,
    pub task_id: String,
}

// ── State ─────────────────────────────────────────────────────────────

pub struct TeamsWatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    known_teams: Mutex<Vec<String>>,
}

impl TeamsWatcherState {
    pub fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
            known_teams: Mutex::new(Vec::new()),
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

const MAX_TEAMS: usize = 1024;
const MAX_INBOX_FILES: usize = 2048;
const MAX_TEAM_MESSAGES: usize = 50_000;
const MAX_TASK_FILES: usize = 10_000;

fn get_claude_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

fn get_teams_base_dir() -> Option<PathBuf> {
    get_claude_root().map(|root| root.join("teams"))
}

fn get_tasks_base_dir() -> Option<PathBuf> {
    get_claude_root().map(|root| root.join("tasks"))
}

fn read_team_config(claude_root: &Path, team_dir: &Path) -> Option<TeamConfig> {
    let config_path = team_dir.join("config.json");
    let content = match crate::provider_readonly::read_provider_text(claude_root, &config_path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    match serde_json::from_str::<TeamConfig>(&content) {
        Ok(config) if crate::provider_readonly::is_safe_component(&config.name) => Some(config),
        Ok(_) | Err(_) => None,
    }
}

fn read_inbox_messages(claude_root: &Path, team_dir: &Path) -> Vec<TeamMessage> {
    let inboxes_dir = team_dir.join("inboxes");
    if !crate::provider_readonly::is_real_directory(claude_root, &inboxes_dir) {
        return Vec::new();
    }

    let mut all_messages: Vec<TeamMessage> = Vec::new();

    let entries = match crate::provider_readonly::read_directory_bounded(
        claude_root,
        &inboxes_dir,
        MAX_INBOX_FILES,
    ) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in entries {
        if all_messages.len() >= MAX_TEAM_MESSAGES {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let agent_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if !crate::provider_readonly::is_safe_component(&agent_name) {
            continue;
        }

        let content = match crate::provider_readonly::read_provider_text(claude_root, &path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Inbox files can be an array of messages or a single object
        if let Ok(messages) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
            for msg_val in messages {
                if all_messages.len() >= MAX_TEAM_MESSAGES {
                    break;
                }
                if let Ok(mut msg) = serde_json::from_value::<TeamMessage>(msg_val) {
                    if msg.to.is_empty() {
                        msg.to = agent_name.clone();
                    }
                    // Detect message type from text content
                    if msg.message_type.is_empty() {
                        msg.message_type = detect_message_type(&msg.text);
                    }
                    all_messages.push(msg);
                }
            }
        } else if let Ok(mut msg) = serde_json::from_str::<TeamMessage>(&content) {
            if msg.to.is_empty() {
                msg.to = agent_name;
            }
            if msg.message_type.is_empty() {
                msg.message_type = detect_message_type(&msg.text);
            }
            all_messages.push(msg);
        }
    }

    // Sort by timestamp ascending
    all_messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    all_messages
}

fn detect_message_type(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(t) = val.get("type").and_then(|v| v.as_str()) {
                return match t {
                    "task_assignment" => "task_assignment".to_string(),
                    "idle_notification" | "idle" => "idle".to_string(),
                    "shutdown_request" => "shutdown_request".to_string(),
                    "shutdown_approved" => "shutdown_approved".to_string(),
                    "shutdown_response" => "shutdown_response".to_string(),
                    other => other.to_string(),
                };
            }
        }
    }
    "direct".to_string()
}

fn read_team_tasks(claude_root: &Path, team_name: &str) -> Vec<TeamTask> {
    if !crate::provider_readonly::is_safe_component(team_name) {
        return Vec::new();
    }
    let tasks_dir = claude_root.join("tasks").join(team_name);

    if !crate::provider_readonly::is_real_directory(claude_root, &tasks_dir) {
        return Vec::new();
    }

    let entries = match crate::provider_readonly::read_directory_bounded(
        claude_root,
        &tasks_dir,
        MAX_TASK_FILES,
    ) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut tasks: Vec<TeamTask> = Vec::new();

    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Skip non-json, lock files, and highwatermark
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if name.starts_with('.') || name == ".lock" || name == ".highwatermark" {
            continue;
        }

        let content = match crate::provider_readonly::read_provider_text(claude_root, &path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        if let Ok(mut task) = serde_json::from_str::<TeamTask>(&content) {
            // If task ID is empty, derive from filename
            if task.id.is_empty() {
                task.id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
            }
            // Check if internal via metadata
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(meta) = val.get("metadata") {
                    if meta
                        .get("_internal")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        task.is_internal = true;
                    }
                }
            }
            tasks.push(task);
        }
    }

    // Sort by ID (numeric if possible)
    tasks.sort_by(|a, b| {
        let a_num = a.id.parse::<u64>().unwrap_or(u64::MAX);
        let b_num = b.id.parse::<u64>().unwrap_or(u64::MAX);
        a_num.cmp(&b_num)
    });

    tasks
}

/// Extract team name from a path that contains `.claude/teams/<team>/...`
/// or `.claude/tasks/<team>/...`
fn extract_team_name(claude_root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(claude_root).ok()?;
    let mut components = relative.components();
    let category = components.next()?.as_os_str().to_str()?;
    if category != "teams" && category != "tasks" {
        return None;
    }
    let team = components.next()?.as_os_str().to_str()?;
    if !crate::provider_readonly::is_safe_component(team) {
        return None;
    }
    Some(team.to_string())
}

fn is_safe_watcher_event(claude_root: &Path, path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if crate::provider_readonly::validate_real_directory_tree(claude_root, parent).is_err() {
        return false;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => !metadata.file_type().is_symlink(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

// ── Tauri Commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn list_teams() -> Result<Vec<TeamConfig>, String> {
    let claude_root =
        get_claude_root().ok_or_else(|| "Could not determine home directory".to_string())?;
    let teams_dir =
        get_teams_base_dir().ok_or_else(|| "Could not determine home directory".to_string())?;

    if !crate::provider_readonly::is_real_directory(&claude_root, &teams_dir) {
        return Ok(Vec::new());
    }

    let entries =
        crate::provider_readonly::read_directory_bounded(&claude_root, &teams_dir, MAX_TEAMS)?;

    let mut teams: Vec<TeamConfig> = Vec::new();

    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let Some(team_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !crate::provider_readonly::is_safe_component(&team_name) {
            continue;
        }
        let path = entry.path();
        if crate::provider_readonly::is_real_directory(&claude_root, &path) {
            if let Some(config) = read_team_config(&claude_root, &path) {
                teams.push(config);
            }
        }
    }

    // Sort by created_at descending (newest first)
    teams.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(teams)
}

#[tauri::command]
pub fn load_team_messages(team: String) -> Result<Vec<TeamMessage>, String> {
    if !crate::provider_readonly::is_safe_component(&team) {
        return Err("Invalid team name".to_string());
    }
    let claude_root =
        get_claude_root().ok_or_else(|| "Could not determine home directory".to_string())?;
    let teams_dir =
        get_teams_base_dir().ok_or_else(|| "Could not determine home directory".to_string())?;

    let team_dir = teams_dir.join(&team);
    if !crate::provider_readonly::is_real_directory(&claude_root, &team_dir) {
        return Err(format!("Team '{}' not found", team));
    }

    Ok(read_inbox_messages(&claude_root, &team_dir))
}

#[tauri::command]
pub fn load_team_tasks(team: String) -> Result<Vec<TeamTask>, String> {
    if !crate::provider_readonly::is_safe_component(&team) {
        return Err("Invalid team name".to_string());
    }
    let claude_root =
        get_claude_root().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(read_team_tasks(&claude_root, &team))
}

// ── File Watcher ──────────────────────────────────────────────────────

/// Start the provider-directory watcher after the user opens Teams.
pub fn start_watching_teams(
    app: &AppHandle,
    watcher_state: &TeamsWatcherState,
) -> Result<(), String> {
    let mut watcher_guard = watcher_state
        .watcher
        .lock()
        .map_err(|_| "Teams watcher state is unavailable".to_string())?;
    if watcher_guard.is_some() {
        return Ok(());
    }

    let claude_root =
        get_claude_root().ok_or_else(|| "Could not determine home directory".to_string())?;
    let teams_dir =
        get_teams_base_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let tasks_dir =
        get_tasks_base_dir().ok_or_else(|| "Could not determine home directory".to_string())?;

    // Provider-owned Claude directories are read-only in Community Edition.
    // If neither source exists there is nothing to watch.
    let watch_teams = crate::provider_readonly::is_real_directory(&claude_root, &teams_dir);
    let watch_tasks = crate::provider_readonly::is_real_directory(&claude_root, &tasks_dir);
    if !watch_teams && !watch_tasks {
        return Ok(());
    }

    // Snapshot existing teams
    let mut initial_teams: Vec<String> = Vec::new();
    if watch_teams {
        if let Ok(entries) =
            crate::provider_readonly::read_directory_bounded(&claude_root, &teams_dir, MAX_TEAMS)
        {
            for entry in entries {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_symlink()
                    || !file_type.is_dir()
                    || !crate::provider_readonly::is_real_directory(&claude_root, &entry.path())
                {
                    continue;
                }
                if let Some(name) = entry.file_name().to_str() {
                    if crate::provider_readonly::is_safe_component(name) {
                        initial_teams.push(name.to_string());
                    }
                }
            }
        }
    }
    {
        let mut known = watcher_state
            .known_teams
            .lock()
            .map_err(|e| e.to_string())?;
        *known = initial_teams.clone();
    }

    // Emit team-created for existing teams
    for team_name in &initial_teams {
        let _ = app.emit(
            "team-created",
            TeamCreatedEvent {
                name: team_name.clone(),
            },
        );
    }

    let app_clone = app.clone();
    let watched_claude_root = claude_root.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let event = match res {
            Ok(e) => e,
            Err(_) => return,
        };

        for event_path in &event.paths {
            if !is_safe_watcher_event(&watched_claude_root, event_path) {
                continue;
            }
            let path_str = event_path.to_string_lossy().to_string();

            // Determine if this is a teams or tasks path
            let is_teams_path =
                path_str.contains(".claude/teams") || path_str.contains(".claude\\teams");
            let is_tasks_path =
                path_str.contains(".claude/tasks") || path_str.contains(".claude\\tasks");

            if is_teams_path {
                if let Some(team_name) = extract_team_name(&watched_claude_root, event_path) {
                    let file_name = event_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");

                    if file_name == "config.json" {
                        match event.kind {
                            EventKind::Create(_) => {
                                let _ = app_clone.emit(
                                    "team-created",
                                    TeamCreatedEvent {
                                        name: team_name.clone(),
                                    },
                                );
                            }
                            EventKind::Modify(_) => {
                                let _ = app_clone.emit(
                                    "team-updated",
                                    TeamUpdatedEvent {
                                        name: team_name.clone(),
                                    },
                                );
                            }
                            _ => {}
                        }
                    }

                    // Check if path is inside inboxes/
                    let is_inbox = event_path
                        .parent()
                        .and_then(|p| p.file_name())
                        .and_then(|n| n.to_str())
                        == Some("inboxes");

                    if is_inbox {
                        let agent = event_path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = app_clone.emit(
                            "team-inbox-changed",
                            TeamInboxChangedEvent {
                                team: team_name,
                                agent,
                            },
                        );
                    }
                }
            }

            if is_tasks_path {
                if let Some(team_name) = extract_team_name(&watched_claude_root, event_path) {
                    let file_name = event_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");

                    // Only emit for json task files
                    if file_name.ends_with(".json") && !file_name.starts_with('.') {
                        let task_id = event_path
                            .file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_string();
                        let _ = app_clone.emit(
                            "team-task-changed",
                            TeamTaskChangedEvent {
                                team: team_name,
                                task_id,
                            },
                        );
                    }
                }
            }
        }
    })
    .map_err(|_| "Failed to create Teams watcher".to_string())?;

    // Watch both directories
    if watch_teams {
        watcher
            .watch(&teams_dir, RecursiveMode::Recursive)
            .map_err(|_| "Failed to watch Teams directory".to_string())?;
    }
    if watch_tasks {
        watcher
            .watch(&tasks_dir, RecursiveMode::Recursive)
            .map_err(|_| "Failed to watch Tasks directory".to_string())?;
    }

    *watcher_guard = Some(watcher);

    Ok(())
}

#[tauri::command]
pub fn watch_teams(
    app: AppHandle,
    watcher_state: State<'_, TeamsWatcherState>,
) -> Result<(), String> {
    start_watching_teams(&app, &watcher_state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_team_tree(temp: &tempfile::TempDir) -> (PathBuf, PathBuf) {
        let root = temp.path().join(".claude");
        let team = root.join("teams").join("team-1");
        std::fs::create_dir_all(team.join("inboxes")).expect("team inboxes");
        std::fs::create_dir_all(root.join("tasks").join("team-1")).expect("team tasks");
        (root, team)
    }

    #[test]
    fn reads_normal_team_data_and_rejects_traversal() {
        let temp = tempfile::tempdir().expect("temp dir");
        let (root, team) = create_team_tree(&temp);
        std::fs::write(
            team.join("config.json"),
            r#"{"name":"team-1","description":"demo","members":[]}"#,
        )
        .expect("config");
        std::fs::write(
            team.join("inboxes").join("agent-1.json"),
            r#"[{"from":"lead","text":"hello","timestamp":"1"}]"#,
        )
        .expect("inbox");
        std::fs::write(
            root.join("tasks").join("team-1").join("1.json"),
            r#"{"id":"1","subject":"task"}"#,
        )
        .expect("task");

        assert_eq!(
            read_team_config(&root, &team).expect("config").name,
            "team-1"
        );
        assert_eq!(read_inbox_messages(&root, &team).len(), 1);
        assert_eq!(read_team_tasks(&root, "team-1").len(), 1);
        assert!(read_team_tasks(&root, "../outside").is_empty());
        assert!(extract_team_name(&root, &root.join("teams").join("..").join("secret")).is_none());
    }

    #[test]
    fn skips_oversized_and_directory_team_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let (root, team) = create_team_tree(&temp);
        let oversized = team.join("config.json");
        let file = std::fs::File::create(&oversized).expect("oversized config");
        file.set_len(crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES + 1)
            .expect("extend config");
        assert!(read_team_config(&root, &team).is_none());

        let directory_inbox = team.join("inboxes").join("directory.json");
        std::fs::create_dir(&directory_inbox).expect("directory inbox");
        assert!(read_inbox_messages(&root, &team).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn skips_linked_and_fifo_team_files_without_mutating_provider_tree() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let (root, team) = create_team_tree(&temp);
        let outside = temp.path().join("outside.json");
        std::fs::write(&outside, r#"{"name":"leaked","members":[]}"#).expect("outside");
        let before = std::fs::read(&outside).expect("snapshot");

        symlink(&outside, team.join("config.json")).expect("config link");
        symlink(&outside, team.join("inboxes").join("linked.json")).expect("inbox link");
        symlink(
            &outside,
            root.join("tasks").join("team-1").join("linked.json"),
        )
        .expect("task link");
        let fifo = team.join("inboxes").join("fifo.json");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);

        assert!(read_team_config(&root, &team).is_none());
        assert!(read_inbox_messages(&root, &team).is_empty());
        assert!(read_team_tasks(&root, "team-1").is_empty());
        assert_eq!(std::fs::read(&outside).expect("outside after"), before);

        let linked_root = temp.path().join("linked-claude");
        symlink(&root, &linked_root).expect("root link");
        assert!(read_team_config(&linked_root, &linked_root.join("teams/team-1")).is_none());
    }
}
