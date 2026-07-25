mod types;
pub use types::{TranscriptionResult, WhisperStatusInfo};

#[cfg(target_os = "macos")]
mod apple_backend;
#[cfg(target_os = "macos")]
pub use apple_backend::VoiceManager;

#[cfg(not(target_os = "macos"))]
mod whisper_backend;
#[cfg(not(target_os = "macos"))]
pub use whisper_backend::VoiceManager;

// ---------------------------------------------------------------------------
// Tauri command thin wrappers. Defined at the voice:: layer so that the
// `#[tauri::command]` macro emits its `__cmd__*` companion item in this same
// module — that's what `tauri::generate_handler!` looks up via `voice::fn_name`.
// ---------------------------------------------------------------------------

use tauri::AppHandle;

#[tauri::command]
pub async fn whisper_get_status(app: AppHandle) -> Result<WhisperStatusInfo, String> {
    #[cfg(target_os = "macos")]
    {
        apple_backend::whisper_get_status(app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        whisper_backend::whisper_get_status(app).await
    }
}

#[tauri::command]
pub async fn whisper_ensure_model(
    app: AppHandle,
    proxy_url: Option<String>,
) -> Result<WhisperStatusInfo, String> {
    #[cfg(target_os = "macos")]
    {
        apple_backend::whisper_ensure_model(app, proxy_url).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        whisper_backend::whisper_ensure_model(app, proxy_url).await
    }
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    audio_data: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    #[cfg(target_os = "macos")]
    {
        apple_backend::transcribe_audio(app, audio_data, language).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        whisper_backend::transcribe_audio(app, audio_data, language).await
    }
}
