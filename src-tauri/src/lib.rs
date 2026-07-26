use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

const TRAY_ID: &str = "main-tray";
const TRAY_RECENT_LIMIT: i64 = 30;
const TRAY_VISIBLE_RECENT_COUNT: usize = 3;
const TRAY_CONVERSATION_PREFIX: &str = "conversation:";

mod anthropic;
pub mod bytro_home;
pub mod constants;
mod deploy;
mod fs_utils;
mod git;
mod memory;
mod node_runtime;
mod notch_window;
mod oauth;
mod ollama;
mod outputs;
mod port_monitor;
mod preview;
mod project_scripts;
mod provider_cli;
mod provider_readonly;
mod pty;
mod sidecar;
mod teams;
mod theme_macos;
mod vc_runtime;
mod voice;
pub mod window_manager;

#[derive(Clone, serde::Serialize)]
struct TrayOpenConversationPayload {
    conversation_id: String,
    workspace_id: Option<String>,
}

struct AppLifecycleState {
    is_quitting: AtomicBool,
}

impl AppLifecycleState {
    fn new() -> Self {
        Self {
            is_quitting: AtomicBool::new(false),
        }
    }
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_windows_reparse_point(metadata)
}

fn ensure_secure_local_data_dir(
    trusted_base: &std::path::Path,
    dir: &std::path::Path,
) -> std::io::Result<()> {
    use std::path::Component;

    let relative = dir
        .strip_prefix(trusted_base)
        .map_err(|_| std::io::Error::other("local data directory is outside its trusted base"))?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(std::io::Error::other(
            "local data directory contains an unsafe component",
        ));
    }

    let base_metadata = match std::fs::metadata(trusted_base) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(trusted_base)?;
            std::fs::metadata(trusted_base)?
        }
        Err(error) => return Err(error),
    };
    if !base_metadata.is_dir() {
        return Err(std::io::Error::other(
            "trusted local data base is not a directory",
        ));
    }

    let mut current = trusted_base.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(std::io::Error::other(
                "local data directory contains an unsafe component",
            ));
        };
        current.push(segment);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if is_link_or_reparse(&metadata) || !metadata.is_dir() => {
                return Err(std::io::Error::other(
                    "local data path traverses a link or non-directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)?;
                let metadata = std::fs::symlink_metadata(&current)?;
                if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                    return Err(std::io::Error::other(
                        "created local data path is not a real directory",
                    ));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) => return Err(error),
        }
    }

    // Revalidate after creation so a swapped intermediate link is not accepted.
    let mut current = trusted_base.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(std::io::Error::other(
                "local data directory contains an unsafe component",
            ));
        };
        current.push(segment);
        let metadata = std::fs::symlink_metadata(&current)?;
        if is_link_or_reparse(&metadata) || !metadata.is_dir() {
            return Err(std::io::Error::other(
                "local data path changed to a link or non-directory",
            ));
        }
    }

    #[cfg(unix)]
    if dir != trusted_base {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    if dir != trusted_base {
        bytro_home::harden_windows_private_acl(dir, true).map_err(std::io::Error::other)?;
    }
    Ok(())
}

fn harden_local_file(
    trusted_base: &std::path::Path,
    path: &std::path::Path,
    create_contents: Option<&[u8]>,
) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        ensure_secure_local_data_dir(trusted_base, parent)?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if is_link_or_reparse(&metadata) || !metadata.is_file() => {
            return Err(std::io::Error::other(
                "local data file is a link or non-regular file",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let Some(contents) = create_contents else {
                return Ok(());
            };
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            let mut file = options.open(path)?;
            file.write_all(contents)?;
            file.sync_all()?;
        }
        Err(error) => return Err(error),
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(std::io::Error::other(
            "opened local data file is not regular",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    bytro_home::harden_windows_private_acl(path, false).map_err(std::io::Error::other)?;
    Ok(())
}

fn harden_settings_store_at(
    trusted_base: &std::path::Path,
    dir: &std::path::Path,
) -> std::io::Result<()> {
    ensure_secure_local_data_dir(trusted_base, dir)?;
    harden_local_file(trusted_base, &dir.join("settings.json"), Some(b"{}"))
}

fn harden_local_data_permissions(app: &tauri::AppHandle) -> std::io::Result<()> {
    let mut data_dirs = Vec::<(std::path::PathBuf, std::path::PathBuf)>::new();
    if let Some(base) = dirs::data_dir() {
        data_dirs.push((base.clone(), base.join(constants::APP_BUNDLE_ID)));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        if !data_dirs.iter().any(|(_, existing)| existing == &dir) {
            let base = dirs::data_dir()
                .filter(|base| dir.starts_with(base))
                .or_else(|| dir.parent().map(std::path::Path::to_path_buf))
                .ok_or_else(|| std::io::Error::other("app data directory has no trusted base"))?;
            data_dirs.push((base, dir));
        }
    }

    for (base, dir) in data_dirs {
        harden_settings_store_at(&base, &dir)?;
        for name in ["memory.db", "memory.db-wal", "memory.db-shm"] {
            harden_local_file(&base, &dir.join(name), None)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn harden_settings_store(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let base = dirs::data_dir()
        .filter(|base| dir.starts_with(base))
        .or_else(|| dir.parent().map(std::path::Path::to_path_buf))
        .ok_or_else(|| "app data directory has no trusted base".to_string())?;
    harden_settings_store_at(&base, &dir).map_err(|e| e.to_string())
}

fn show_and_focus_tray_windows(
    app: &tauri::AppHandle,
    preferred_label: Option<&str>,
) -> Option<String> {
    let windows = app.webview_windows();
    if windows.is_empty() {
        return None;
    }

    for window in windows.values() {
        let _ = window.show();
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
    }

    let focus_label = preferred_label
        .filter(|label| windows.contains_key(*label))
        .map(ToOwned::to_owned)
        .or_else(|| {
            app.try_state::<window_manager::WindowManager>()
                .and_then(|mgr| mgr.most_recent_window())
        })
        .or_else(|| {
            if windows.contains_key("main") {
                Some("main".to_string())
            } else {
                windows.keys().next().cloned()
            }
        });

    if let Some(label) = focus_label {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_focus();
        }
        Some(label)
    } else {
        None
    }
}

fn restore_tray_windows(app: &tauri::AppHandle) {
    let _ = show_and_focus_tray_windows(app, None);
}

fn hide_tray_windows(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
}

fn tray_menu_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return "New chat".to_string();
    }

    const MAX_CHARS: usize = 64;
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }

    let mut label = trimmed.chars().take(MAX_CHARS).collect::<String>();
    label.push('…');
    label
}

fn tray_recent_conversations(app: &tauri::AppHandle) -> Vec<memory::models::ConversationSummary> {
    let Some(db) = app.try_state::<memory::db::MemoryDb>() else {
        return Vec::new();
    };

    match db.with_conn(|conn| {
        memory::repository::list_conversations(conn, TRAY_RECENT_LIMIT, 0, None, false)
    }) {
        Ok(conversations) => conversations,
        Err(err) => {
            log::warn!("[tray] failed to load recent conversations: {}", err);
            Vec::new()
        }
    }
}

fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

    let conversations = tray_recent_conversations(app);
    let mut menu = MenuBuilder::new(app);

    let app_title = MenuItem::with_id(app, "app-title", constants::APP_NAME, false, None::<&str>)?;
    let recent_title = MenuItem::with_id(app, "recent-title", "Recent", false, None::<&str>)?;

    menu = menu.item(&app_title).separator().item(&recent_title);

    if conversations.is_empty() {
        let empty = MenuItem::with_id(app, "recent-empty", "暂无最近会话", false, None::<&str>)?;
        menu = menu.item(&empty);
    } else {
        for conversation in conversations.iter().take(TRAY_VISIBLE_RECENT_COUNT) {
            menu = menu.text(
                format!("{TRAY_CONVERSATION_PREFIX}{}", conversation.id),
                tray_menu_title(&conversation.title),
            );
        }

        if conversations.len() > TRAY_VISIBLE_RECENT_COUNT {
            let mut more = SubmenuBuilder::with_id(app, "more", "More");
            for conversation in conversations.iter().skip(TRAY_VISIBLE_RECENT_COUNT) {
                more = more.text(
                    format!("{TRAY_CONVERSATION_PREFIX}{}", conversation.id),
                    tray_menu_title(&conversation.title),
                );
            }
            menu = menu.item(&more.build()?);
        }
    }

    menu.separator()
        .text("show", "显示所有窗口")
        .text("hide", "隐藏")
        .text("quit", "退出")
        .build()
}

pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    match build_tray_menu(app) {
        Ok(menu) => {
            if let Err(err) = tray.set_menu(Some(menu)) {
                log::warn!("[tray] failed to refresh menu: {}", err);
            }
        }
        Err(err) => log::warn!("[tray] failed to build menu: {}", err),
    }
}

fn open_tray_conversation(app: &tauri::AppHandle, conversation_id: &str) {
    let conversation = app.try_state::<memory::db::MemoryDb>().and_then(|db| {
        db.with_conn(|conn| memory::repository::get_conversation(conn, conversation_id))
            .ok()
            .flatten()
    });

    let workspace_id = conversation.as_ref().and_then(|c| c.workspace_id.clone());
    let preferred_label = workspace_id.as_deref().and_then(|id| {
        app.try_state::<window_manager::WindowManager>()
            .and_then(|mgr| mgr.find_window_for_workspace(id))
    });

    let focused_label = show_and_focus_tray_windows(app, preferred_label.as_deref());
    let payload = TrayOpenConversationPayload {
        conversation_id: conversation_id.to_string(),
        workspace_id,
    };

    if let Some(label) = focused_label {
        let _ = app.emit_to(&label, "tray-open-conversation", payload);
    } else {
        let _ = app.emit("tray-open-conversation", payload);
    }
}

fn setup_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let handle = app.handle().clone();
    let menu = build_tray_menu(&handle)?;

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ID);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    } else {
        log::warn!("[tray] default window icon is unavailable");
    }

    tray_builder
        .tooltip(constants::APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(conversation_id) = id.strip_prefix(TRAY_CONVERSATION_PREFIX) {
                open_tray_conversation(app, conversation_id);
                return;
            }

            match id {
                "show" => restore_tray_windows(app),
                "hide" => hide_tray_windows(app),
                "quit" => {
                    if let Some(state) = app.try_state::<AppLifecycleState>() {
                        state.is_quitting.store(true, Ordering::SeqCst);
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_tray_windows(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set a process-level AppUserModelID so that ALL windows (including
    // dynamically created workspace windows) share the same taskbar group.
    // Without this, packaged builds show a separate taskbar icon per window
    // because the NSIS/WIX shortcut AUMID doesn't match the default one.
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let app_id: Vec<u16> = constants::APP_BUNDLE_ID
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
        }
    }

    // single-instance MUST be the first plugin registered so it can
    // intercept the second launch before deep-link or any other plugin runs.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the most recently used window (instead of hard-coding "main").
            restore_tray_windows(app);
        }));
    }

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    builder
        .manage(AppLifecycleState::new())
        .manage(window_manager::WindowManager::new())
        .manage(vc_runtime::VcRuntimeManager::new())
        .manage(pty::PtyManager::new())
        .manage(port_monitor::PortMonitor::new())
        .manage(fs_utils::FsWatcherState::new())
        .manage(memory::db::MemoryDb::new().expect("Failed to initialize memory database"))
        .manage(sidecar::SidecarManager::new())
        .manage(node_runtime::NodeRuntimeManager::new())
        .manage(provider_cli::ProviderCliManager::new())
        .manage(teams::TeamsWatcherState::new())
        .manage(voice::VoiceManager::new())
        .manage(oauth::OAuthManager::new())
        .manage(sidecar::mcp_oauth::McpOAuthManager::new())
        .manage(preview::dev_server::DevServerState::default())
        .manage(preview::proxy::PreviewProxyState::new())
        .invoke_handler(tauri::generate_handler![
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            fs_utils::read_dir_entries,
            fs_utils::read_file_content,
            fs_utils::read_file_base64,
            fs_utils::write_file_content,
            fs_utils::append_diagnostics_log,
            fs_utils::write_file_binary,
            fs_utils::revert_tool_edit,
            fs_utils::create_file,
            fs_utils::path_exists,
            fs_utils::get_home_dir,
            fs_utils::create_dir,
            fs_utils::delete_entry,
            fs_utils::copy_entry,
            fs_utils::rename_entry,
            fs_utils::get_cwd,
            fs_utils::search_files,
            fs_utils::watch_dir,
            fs_utils::unwatch_dir,
            harden_settings_store,
            outputs::get_default_outputs_dir,
            outputs::ensure_outputs_dir,
            outputs::pick_outputs_dir,
            sidecar::chat::stream_chat,
            sidecar::chat::respond_tool_confirmation,
            sidecar::chat::respond_ask_user_question,
            sidecar::chat::send_user_input,
            sidecar::chat::abort_chat,
            sidecar::chat::rewind_files,
            sidecar::chat::kill_session,
            sidecar::teams_chat::stream_teams_chat,
            sidecar::session::start_orchestration,
            sidecar::session::init_session,
            sidecar::slash_commands::scan_slash_commands,
            sidecar::slash_commands::resolve_slash_command,
            sidecar::cli_tools::check_cli_tools,
            sidecar::cli_tools::detect_cli_paths,
            sidecar::credential_scanner::scan_local_credentials,
            vc_runtime::check_vc_runtime,
            vc_runtime::ensure_vc_runtime,
            ollama::check_ollama_status,
            ollama::ollama_list_local_models,
            ollama::ollama_search_models,
            ollama::ollama_pull_model,
            ollama::ollama_delete_model,
            ollama::get_ollama_registry_mirror,
            ollama::start_ollama,
            ollama::stop_ollama,
            sidecar::mcp::load_mcp_servers,
            sidecar::mcp::save_mcp_servers,
            sidecar::mcp::search_mcp_marketplace,
            sidecar::mcp::verify_mcp_server,
            sidecar::mcp::list_mcp_tools,
            sidecar::mcp_oauth::mcp_auth_inspect,
            sidecar::mcp_oauth::mcp_oauth_start,
            sidecar::mcp_oauth::mcp_oauth_complete,
            sidecar::mcp_oauth::mcp_oauth_get_status,
            sidecar::mcp_oauth::mcp_oauth_sign_out,
            sidecar::skills::scan_installed_skills,
            sidecar::skills::get_skill_detail,
            sidecar::skills::remove_skill,
            sidecar::skills::scan_repo_skills,
            sidecar::skills::search_marketplace_skills,
            sidecar::skills::install_skill_from_repo,
            sidecar::skills::update_skill,
            sidecar::skills::set_skill_disabled,
            sidecar::skills::save_skill_content,
            anthropic::test_proxy,
            anthropic::test_connection,
            anthropic::test_openai_connection,
            anthropic::test_gemini_connection,
            anthropic::fetch_remote_models,
            anthropic::generate_title,
            anthropic::generate_conversation_summary,
            anthropic::generate_idea_summary,
            anthropic::generate_commit_message,
            anthropic::ai_code_review,
            anthropic::ai_code_review_stream,
            memory::commands::create_conversation,
            memory::commands::fork_conversation,
            memory::commands::list_conversations,
            memory::commands::get_conversation_messages,
            memory::commands::get_latest_messages,
            memory::commands::save_message,
            memory::commands::get_message_count,
            memory::commands::delete_conversation,
            memory::commands::rename_conversation,
            memory::commands::update_conversation_model,
            memory::commands::pin_conversation,
            memory::commands::set_conversation_archived,
            memory::commands::search_memory,
            memory::commands::get_memory_context,
            memory::commands::get_conversation,
            memory::commands::get_conversation_summary,
            memory::commands::update_conversation_session,
            memory::commands::save_conversation_todos,
            memory::commands::get_conversation_todos,
            memory::commands::save_conversation_usage,
            memory::commands::save_conversation_context_usage,
            memory::commands::get_conversation_usage,
            memory::commands::get_aggregate_usage,
            memory::commands::create_workspace,
            memory::commands::list_workspaces,
            memory::commands::get_workspace,
            memory::commands::delete_workspace,
            memory::commands::rename_workspace,
            memory::commands::pin_workspace,
            memory::commands::open_workspace,
            memory::commands::count_orphaned_conversations,
            memory::commands::assign_orphaned_conversations,
            memory::commands::set_conversation_message_source,
            memory::commands::sync_conversation_from_jsonl,
            memory::commands::save_health_check_result,
            memory::commands::get_last_health_check_result,
            memory::commands::list_health_check_results,
            memory::commands::create_idea,
            memory::commands::get_idea,
            memory::commands::list_ideas,
            memory::commands::update_idea,
            memory::commands::update_idea_status,
            memory::commands::update_idea_summary,
            memory::commands::link_idea_discussion,
            memory::commands::link_idea_conversation,
            memory::commands::delete_idea,
            memory::commands::search_ideas,
            memory::commands::count_ideas_by_status,
            memory::commands::update_idea_sort_orders,
            memory::commands::update_idea_checklist,
            memory::commands::update_idea_planned_date,
            memory::commands::update_idea_images,
            memory::commands::complete_idea,
            memory::commands::uncomplete_idea,
            memory::commands::save_idea_image,
            memory::commands::delete_idea_image,
            memory::commands::get_idea_image_path,
            memory::commands::read_idea_image_base64,
            memory::commands::get_git_file_changes,
            memory::commands::upsert_session_activity,
            memory::commands::get_unsynced_activity,
            memory::commands::mark_activity_synced,
            memory::commands::get_local_heatmap,
            memory::commands::detect_tech_stack,
            memory::commands::get_storage_stats,
            memory::commands::get_storage_stats_database,
            memory::commands::get_storage_stats_jsonl,
            memory::commands::get_storage_stats_codex,
            memory::commands::get_storage_stats_temp,
            memory::commands::clear_old_conversations,
            memory::commands::clear_all_conversations,
            memory::commands::vacuum_database,
            memory::commands::clear_activity_data,
            memory::commands::clear_temp_files,
            memory::commands::set_last_used_model,
            memory::commands::get_last_used_model,
            git::commands::get_workspace_stats,
            git::commands::get_git_info,
            git::commands::get_git_status,
            git::commands::get_git_diff,
            git::commands::get_file_diff,
            git::commands::get_diff_contents,
            git::commands::get_git_log,
            git::commands::get_file_diff_in_commit,
            git::commands::get_commit_detail,
            git::commands::get_git_branches,
            git::commands::get_git_stash_list,
            git::commands::git_stage_files,
            git::commands::git_unstage_files,
            git::commands::git_discard_files,
            git::commands::git_rm_cached,
            git::commands::git_commit,
            git::commands::git_create_branch,
            git::commands::git_switch_branch,
            git::commands::git_fetch,
            git::commands::git_pull,
            git::commands::git_push,
            git::commands::git_get_remote_url,
            git::commands::git_stash_save,
            git::commands::git_stash_pop,
            git::commands::git_checkpoint_create,
            git::commands::git_checkpoint_restore,
            git::commands::git_checkpoint_list,
            git::commands::git_checkpoint_migrate,
            git::commands::git_checkpoint_cleanup,
            git::commands::git_create_tag,
            git::commands::git_create_branch_from_commit,
            git::commands::git_checkout_commit,
            git::commands::git_reset_to_commit,
            git::commands::git_archive_commit,
            git::commands::git_format_patch,
            git::commands::git_clone_repo,
            git::commands::git_check_repo_access,
            git::commands::git_check_repo_access_details,
            git::commands::git_test_token,
            git::commands::revert_file_from_diff,
            teams::list_teams,
            teams::load_team_messages,
            teams::load_team_tasks,
            teams::watch_teams,
            node_runtime::check_node_runtime,
            node_runtime::ensure_node_runtime,
            node_runtime::detect_node_runtime,
            node_runtime::get_node_runtime_status,
            voice::whisper_get_status,
            voice::whisper_ensure_model,
            voice::transcribe_audio,
            preview::project_init::init_preview_project,
            preview::project_init::is_preview_project,
            preview::project_init::open_existing_preview_project,
            preview::project_init::install_preview_packages,
            project_scripts::scan_project_run_shortcuts,
            preview::dev_server::start_dev_server,
            preview::dev_server::stop_dev_server,
            preview::dev_server::get_dev_server_status,
            preview::dev_server::restart_dev_server,
            preview::proxy::register_preview_session,
            preview::proxy::unregister_preview_session,
            preview::proxy::get_preview_proxy_status,
            deploy::commands::deploy_preview_site,
            oauth::commands::oauth_start,
            oauth::commands::oauth_cancel,
            oauth::commands::oauth_submit_code,
            oauth::commands::oauth_get_token,
            oauth::commands::oauth_refresh,
            oauth::commands::oauth_sign_out,
            oauth::commands::oauth_get_usage,
            sidecar::codex_auth::codex_auth_start,
            sidecar::codex_auth::codex_auth_read,
            sidecar::codex_auth::codex_auth_cancel,
            sidecar::codex_auth::codex_auth_sign_out,
            theme_macos::set_native_theme,
            window_manager::create_workspace_window,
            window_manager::update_window_workspace,
            window_manager::get_window_workspace,
            notch_window::get_notch_metrics,
            notch_window::show_notch_overlay,
            notch_window::set_notch_overlay_bounds,
            notch_window::hide_notch_overlay,
            notch_window::set_notch_overlay_ignore_mouse,
            notch_window::set_notch_collapse_watch,
            notch_window::abort_active_stream,
            notch_window::focus_main_window,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            harden_local_data_permissions(&handle)?;

            setup_system_tray(app)?;

            // Initialize the isolated Bytro Community home (~/.bytro-community/).
            // Creates and permission-hardens only Bytro-managed directories.
            if let Err(e) = bytro_home::init() {
                eprintln!("[bytro_home] Initialization failed: {}", e);
            }

            // Community Edition installs the pinned provider SDK platform
            // packages from npm into ~/.bytro-community/cli. Startup is
            // best-effort; every real provider entry point also awaits the
            // same manager, so an early network failure remains retryable.
            let provider_cli_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if node_runtime::detect_node_runtime_internal(&provider_cli_handle)
                    .await
                    .is_err()
                {
                    return;
                }
                let claude = provider_cli::ensure_provider_cli(
                    &provider_cli_handle,
                    provider_cli::ProviderCli::Claude,
                    None,
                );
                let codex = provider_cli::ensure_provider_cli(
                    &provider_cli_handle,
                    provider_cli::ProviderCli::Codex,
                    None,
                );
                let (claude_result, codex_result) = tokio::join!(claude, codex);
                if let Err(error) = claude_result {
                    log::warn!("[provider-cli] Claude startup preparation failed: {error}");
                }
                if let Err(error) = codex_result {
                    log::warn!("[provider-cli] Codex startup preparation failed: {error}");
                }
            });

            // Register the initial "main" window in the WindowManager so that
            // single-instance focus and event routing work correctly.
            {
                let mgr = app.state::<window_manager::WindowManager>();
                mgr.register_window("main", None);
            }

            // Apply persisted theme to the window as early as possible so
            // the native title bar (Liquid Glass on macOS Tahoe) starts with
            // the correct appearance instead of flashing light then switching.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let theme_str = theme_macos::read_persisted_theme(app.handle());
                if let Some(t) = theme_str.as_deref() {
                    let tauri_theme = match t {
                        "dark" => Some(tauri::Theme::Dark),
                        "light" => Some(tauri::Theme::Light),
                        _ => None,
                    };
                    if let Some(tt) = tauri_theme {
                        let _ = window.set_theme(Some(tt));
                    }
                    let _ = theme_macos::set_native_theme(window.clone(), Some(t.to_string()));
                }
            }

            // Size the main window on startup.
            if let Some(window) = app.get_webview_window("main") {
                // macOS: 默认在主屏上最大化窗口(非全屏)。maximize 会占据屏幕
                // 可用工作区(扣除菜单栏与 Dock),而不是进入 fullscreen。窗口
                // 默认创建在主显示器上,因此这里就是「主屏最大化」。
                #[cfg(target_os = "macos")]
                {
                    let _ = window.maximize();
                }

                // 其他平台: 按屏幕分辨率的 88% 自适应并居中。
                #[cfg(not(target_os = "macos"))]
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let screen_size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = screen_size.width as f64 / scale;
                    let logical_h = screen_size.height as f64 / scale;

                    let win_w = (logical_w * 0.88).clamp(900.0, 1920.0);
                    let win_h = (logical_h * 0.88).clamp(600.0, 1200.0);

                    let _ = window.set_size(tauri::LogicalSize::new(win_w, win_h));
                    let _ = window.center();
                }

                // Windows: transparent windows lose their DWM shadow by default,
                // making the window look flat and disconnected in non-fullscreen
                // mode.  Re-enable the shadow so edges look native.
                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_shadow(true);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let is_quitting = window
                    .try_state::<AppLifecycleState>()
                    .map(|state| state.is_quitting.load(Ordering::SeqCst))
                    .unwrap_or(false);

                if !is_quitting {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }

                // Unregister window from the WindowManager.
                if let Some(mgr) = window.try_state::<window_manager::WindowManager>() {
                    mgr.unregister_window(window.label());
                }

                // Clean up file watcher for this window
                if let Some(watcher_state) = window.try_state::<fs_utils::FsWatcherState>() {
                    watcher_state.remove_watcher(window.label());
                }

                // Kill dev server when the window is closed (fires before RunEvent::Exit)
                let state = window.state::<preview::dev_server::DevServerState>();
                state.kill_if_running();

                // Drain the preview proxy server (graceful shutdown)
                if let Some(proxy_state) = window.try_state::<preview::proxy::PreviewProxyState>() {
                    proxy_state.shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                restore_tray_windows(app);
                return;
            }

            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                // Kill dev server so orphan Vite processes don't linger after app close
                let state = app.state::<preview::dev_server::DevServerState>();
                state.kill_if_running();
            }
        });
}

#[cfg(test)]
mod local_data_permissions_tests {
    use super::*;

    #[test]
    fn settings_store_is_created_private_and_existing_content_persists() {
        let temp = tempfile::tempdir().expect("temp dir");
        let trusted_base = temp.path().join("trusted");
        std::fs::create_dir(&trusted_base).expect("trusted base");
        let data_dir = trusted_base.join("app-data");
        harden_settings_store_at(&trusted_base, &data_dir).expect("create settings store");
        let settings = data_dir.join("settings.json");
        assert_eq!(std::fs::read(&settings).expect("settings"), b"{}");

        std::fs::write(&settings, br#"{"bytro-settings":"persisted"}"#).expect("persist settings");
        harden_settings_store_at(&trusted_base, &data_dir).expect("reharden settings");
        assert_eq!(
            std::fs::read(&settings).expect("persisted settings"),
            br#"{"bytro-settings":"persisted"}"#
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&data_dir)
                    .expect("data metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&settings)
                    .expect("settings metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn settings_store_rejects_symlink_and_nonregular_targets() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let trusted_base = temp.path().join("trusted");
        std::fs::create_dir(&trusted_base).expect("trusted base");
        let data_dir = trusted_base.join("app-data");
        std::fs::create_dir(&data_dir).expect("data dir");
        let outside = temp.path().join("outside.json");
        std::fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, data_dir.join("settings.json")).expect("settings link");

        assert!(harden_settings_store_at(&trusted_base, &data_dir).is_err());
        assert_eq!(std::fs::read(&outside).expect("outside after"), b"outside");

        std::fs::remove_file(data_dir.join("settings.json")).expect("remove link");
        std::fs::create_dir(data_dir.join("settings.json")).expect("directory target");
        assert!(harden_settings_store_at(&trusted_base, &data_dir).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn settings_store_rejects_linked_intermediate_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let trusted_base = temp.path().join("trusted");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&trusted_base).expect("trusted base");
        std::fs::create_dir(&outside).expect("outside");
        symlink(&outside, trusted_base.join("linked")).expect("intermediate link");

        let data_dir = trusted_base.join("linked").join("app-data");
        assert!(harden_settings_store_at(&trusted_base, &data_dir).is_err());
        assert!(std::fs::symlink_metadata(outside.join("app-data")).is_err());
    }
}
