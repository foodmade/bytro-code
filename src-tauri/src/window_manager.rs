use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindowBuilder};

// ---------------------------------------------------------------------------
// WindowInfo — metadata for each tracked window
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub window_label: String,
    pub workspace_id: Option<String>,
}

// ---------------------------------------------------------------------------
// WindowManager — central registry for all workspace windows
// ---------------------------------------------------------------------------

pub struct WindowManager {
    windows: Mutex<HashMap<String, WindowInfo>>,
}

impl Default for WindowManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowManager {
    pub fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Register a new window (or update an existing one).
    pub fn register_window(&self, label: &str, workspace_id: Option<String>) {
        let mut map = self.windows.lock().unwrap();
        map.insert(
            label.to_string(),
            WindowInfo {
                window_label: label.to_string(),
                workspace_id,
            },
        );
    }

    /// Remove a window from the registry.
    pub fn unregister_window(&self, label: &str) {
        let mut map = self.windows.lock().unwrap();
        map.remove(label);
    }

    /// Find the window label that is bound to a given workspace.
    pub fn find_window_for_workspace(&self, workspace_id: &str) -> Option<String> {
        let map = self.windows.lock().unwrap();
        map.values()
            .find(|info| info.workspace_id.as_deref() == Some(workspace_id))
            .map(|info| info.window_label.clone())
    }

    /// Number of registered windows.
    pub fn window_count(&self) -> usize {
        let map = self.windows.lock().unwrap();
        map.len()
    }

    /// Return the label of the most recently registered window (used by
    /// single-instance to focus *some* window when the user re-launches the
    /// app without a specific target).
    pub fn most_recent_window(&self) -> Option<String> {
        let map = self.windows.lock().unwrap();
        // The "main" window takes priority; fall back to any window.
        if map.contains_key("main") {
            return Some("main".to_string());
        }
        map.keys().next().cloned()
    }
}

// ---------------------------------------------------------------------------
// Helper — emit an event to the window bound to a workspace
// ---------------------------------------------------------------------------

pub fn emit_to_workspace<S: Serialize + Clone>(
    app: &AppHandle,
    workspace_id: &str,
    event: &str,
    payload: S,
) {
    let mgr = app.state::<WindowManager>();
    if let Some(label) = mgr.find_window_for_workspace(workspace_id) {
        // Tauri v2: emit_to(label) delivers only to listeners registered via
        // getCurrentWebviewWindow().listen() on the matching window.
        let _ = app.emit_to(&label, event, payload);
        return;
    }
    // Fallback: broadcast to all windows if no specific match found.
    let _ = app.emit(event, payload);
}

// ---------------------------------------------------------------------------
// Auto-size a window to ~88 % of the screen (same logic as the main window)
// ---------------------------------------------------------------------------

fn auto_size_window(window: &tauri::WebviewWindow) {
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

    #[cfg(target_os = "windows")]
    {
        let _ = window.set_shadow(true);
    }
}

// ---------------------------------------------------------------------------
// Tauri command — create (or focus) a workspace window
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn create_workspace_window(
    app: AppHandle,
    workspace_id: String,
    workspace_name: Option<String>,
) -> Result<String, String> {
    let mgr = app.state::<WindowManager>();
    log::info!(
        "[window-manager] create_workspace_window requested workspace_id={} workspace_name={:?} window_count={}",
        workspace_id,
        workspace_name,
        mgr.window_count()
    );

    // If this workspace already has an open window, just focus it.
    if let Some(existing_label) = mgr.find_window_for_workspace(&workspace_id) {
        log::info!(
            "[window-manager] workspace already bound to window label={} workspace_id={}",
            existing_label,
            workspace_id
        );
        if let Some(window) = app.get_webview_window(&existing_label) {
            let _ = window.set_focus();
            return Ok(existing_label);
        }
        // Window was closed but not cleaned up — remove stale entry.
        log::warn!(
            "[window-manager] removing stale window binding label={} workspace_id={}",
            existing_label,
            workspace_id
        );
        mgr.unregister_window(&existing_label);
    }

    // Generate a unique window label.
    let short_id = &uuid::Uuid::new_v4().to_string()[..8];
    let label = format!("workspace-{}", short_id);

    // Build the URL with a workspace_id query parameter so the React app
    // knows which workspace to open on mount.
    let url = "index.html";

    let title = workspace_name
        .as_deref()
        .map(|n| format!("{} - {}", crate::constants::APP_NAME, n))
        .unwrap_or_else(|| crate::constants::APP_NAME.to_string());

    // Windows: hide native decorations (custom TopBar provides title bar)
    // macOS/Linux: use native title bar
    #[cfg(target_os = "windows")]
    let decorations = false;
    #[cfg(not(target_os = "windows"))]
    let decorations = true;

    let window = WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(1540.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .decorations(decorations)
        .center()
        .build()
        .map_err(|e| {
            log::warn!(
                "[window-manager] failed to create window workspace_id={} label={} error={}",
                workspace_id,
                label,
                e
            );
            format!("Failed to create window: {}", e)
        })?;

    #[cfg(target_os = "macos")]
    if let Some(t) = crate::theme_macos::read_persisted_theme(&app) {
        let tauri_theme = match t.as_str() {
            "dark" => Some(tauri::Theme::Dark),
            "light" => Some(tauri::Theme::Light),
            _ => None,
        };
        if let Some(tt) = tauri_theme {
            let _ = window.set_theme(Some(tt));
        }
        let _ = crate::theme_macos::set_native_theme(window.clone(), Some(t));
    }

    auto_size_window(&window);

    // Register in WindowManager.
    mgr.register_window(&label, Some(workspace_id));
    log::info!(
        "[window-manager] window created label={} workspace_name={:?}",
        label,
        workspace_name
    );

    Ok(label)
}

// ---------------------------------------------------------------------------
// Tauri command — update the workspace binding for a window
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn update_window_workspace(
    window: tauri::Window,
    wm: State<'_, WindowManager>,
    workspace_id: String,
    workspace_name: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    log::info!(
        "[window-manager] update_window_workspace label={} workspace_id={} workspace_name={:?}",
        label,
        workspace_id,
        workspace_name
    );
    wm.register_window(&label, Some(workspace_id));
    if let Some(name) = workspace_name {
        let _ = window.set_title(&format!("{} - {}", crate::constants::APP_NAME, name));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri command — query which workspace this window is bound to
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_window_workspace(
    window: tauri::Window,
    wm: State<'_, WindowManager>,
) -> Result<Option<String>, String> {
    let label = window.label();
    let map = wm.windows.lock().map_err(|e| e.to_string())?;
    let workspace_id = map.get(label).and_then(|info| info.workspace_id.clone());
    log::info!(
        "[window-manager] get_window_workspace label={} resolved_workspace_id={:?}",
        label,
        workspace_id
    );
    Ok(workspace_id)
}
