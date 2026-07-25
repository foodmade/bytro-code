use tauri::{AppHandle, Manager};

use super::protocol::SidecarCommand;
use super::SidecarManager;

async fn send_codex_auth_command(
    app: AppHandle,
    build: impl FnOnce(String) -> SidecarCommand,
) -> Result<(), String> {
    let codex_binary_path = crate::provider_cli::ensure_provider_cli(
        &app,
        crate::provider_cli::ProviderCli::Codex,
        None,
    )
    .await?;
    let mgr = app.state::<SidecarManager>();
    mgr.ensure_running("", "", "", "", None, &app)?;
    mgr.send_command(&build(codex_binary_path))
}

#[tauri::command]
pub async fn codex_auth_start(
    app: AppHandle,
    request_id: String,
    profile_id: String,
) -> Result<(), String> {
    send_codex_auth_command(app, |codex_binary_path| SidecarCommand::CodexAuthStart {
        id: request_id,
        profile_id,
        codex_binary_path,
    })
    .await
}

#[tauri::command]
pub async fn codex_auth_read(
    app: AppHandle,
    request_id: String,
    profile_id: String,
    refresh_token: Option<bool>,
) -> Result<(), String> {
    send_codex_auth_command(app, |codex_binary_path| SidecarCommand::CodexAuthRead {
        id: request_id,
        profile_id,
        refresh_token,
        codex_binary_path,
    })
    .await
}

#[tauri::command]
pub async fn codex_auth_cancel(
    app: AppHandle,
    request_id: String,
    profile_id: String,
    login_id: String,
) -> Result<(), String> {
    send_codex_auth_command(app, |codex_binary_path| SidecarCommand::CodexAuthCancel {
        id: request_id,
        profile_id,
        login_id,
        codex_binary_path,
    })
    .await
}

#[tauri::command]
pub async fn codex_auth_sign_out(
    app: AppHandle,
    request_id: String,
    profile_id: String,
) -> Result<(), String> {
    send_codex_auth_command(app, |codex_binary_path| SidecarCommand::CodexAuthSignOut {
        id: request_id,
        profile_id,
        codex_binary_path,
    })
    .await
}
