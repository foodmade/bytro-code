use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WhisperStatus {
    NotReady,
    Loading,
    Ready,
    Transcribing,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatusInfo {
    pub status: WhisperStatus,
    pub model_path: Option<String>,
    pub model_exists_on_disk: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub language: String,
    pub duration_ms: u64,
    pub processing_ms: u64,
}
