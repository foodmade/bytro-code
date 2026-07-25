use tauri::{AppHandle, Manager};

use super::protocol::SidecarCommand;
use super::SidecarManager;

fn send_codex_auth_command(app: AppHandle, cmd: SidecarCommand) -> Result<(), String> {
    let mgr = app.state::<SidecarManager>();
    mgr.ensure_running("", "", "", "", None, &app)?;
    mgr.send_command(&cmd)
}

#[tauri::command]
pub fn codex_auth_start(
    app: AppHandle,
    request_id: String,
    profile_id: String,
) -> Result<(), String> {
    send_codex_auth_command(
        app,
        SidecarCommand::CodexAuthStart {
            id: request_id,
            profile_id,
        },
    )
}

#[tauri::command]
pub fn codex_auth_read(
    app: AppHandle,
    request_id: String,
    profile_id: String,
    refresh_token: Option<bool>,
) -> Result<(), String> {
    send_codex_auth_command(
        app,
        SidecarCommand::CodexAuthRead {
            id: request_id,
            profile_id,
            refresh_token,
        },
    )
}

#[tauri::command]
pub fn codex_auth_cancel(
    app: AppHandle,
    request_id: String,
    profile_id: String,
    login_id: String,
) -> Result<(), String> {
    send_codex_auth_command(
        app,
        SidecarCommand::CodexAuthCancel {
            id: request_id,
            profile_id,
            login_id,
        },
    )
}

#[tauri::command]
pub fn codex_auth_sign_out(
    app: AppHandle,
    request_id: String,
    profile_id: String,
) -> Result<(), String> {
    send_codex_auth_command(
        app,
        SidecarCommand::CodexAuthSignOut {
            id: request_id,
            profile_id,
        },
    )
}
