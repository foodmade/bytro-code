#![cfg(not(target_os = "macos"))]

use super::types::{TranscriptionResult, WhisperStatus, WhisperStatusInfo};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

struct WhisperState {
    status: WhisperStatus,
    ctx: Option<Arc<WhisperContext>>,
    model_path: Option<PathBuf>,
}

pub struct VoiceManager {
    state: Mutex<WhisperState>,
}

impl VoiceManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(WhisperState {
                status: WhisperStatus::NotReady,
                ctx: None,
                model_path: None,
            }),
        }
    }

    /// Acquire the Mutex, recovering from poison if a prior holder panicked.
    fn lock_state(&self) -> std::sync::MutexGuard<'_, WhisperState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            log::warn!("[whisper] Mutex was poisoned, recovering");
            poisoned.into_inner()
        })
    }

    pub fn get_info(&self) -> WhisperStatusInfo {
        let (status, model_path) = {
            let state = self.lock_state();
            (
                state.status.clone(),
                state
                    .model_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
            )
        };
        let model_exists_on_disk = check_model_exists_on_disk();
        WhisperStatusInfo {
            status,
            model_path,
            model_exists_on_disk,
        }
    }

    fn set_status(&self, status: WhisperStatus, app: &AppHandle) {
        let (cloned_status, model_path) = {
            let mut state = self.lock_state();
            state.status = status;
            (
                state.status.clone(),
                state
                    .model_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
            )
        };
        let info = WhisperStatusInfo {
            status: cloned_status,
            model_path,
            model_exists_on_disk: check_model_exists_on_disk(),
        };
        let _ = app.emit("whisper-status", &info);
    }

    fn is_model_loaded(&self) -> bool {
        let state = self.lock_state();
        state.ctx.is_some()
    }
}

// ---------------------------------------------------------------------------
// Local model directory
// ---------------------------------------------------------------------------

const MODEL_FILENAME: &str = "ggml-base.bin";
const MODEL_SIZE_MIN: u64 = 100_000_000; // ~100MB sanity check

fn whisper_model_dir() -> Result<PathBuf, String> {
    let dir = crate::bytro_home::home_dir()?.join("whisper-models");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create local Whisper model directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Failed to secure local Whisper model directory: {error}"))?;
    }
    Ok(dir)
}

fn check_model_exists_on_disk() -> bool {
    let Ok(dir) = whisper_model_dir() else {
        return false;
    };
    let dest = dir.join(MODEL_FILENAME);
    if let Ok(meta) = std::fs::metadata(&dest) {
        meta.len() >= MODEL_SIZE_MIN
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// WAV parsing & PCM conversion
// ---------------------------------------------------------------------------

fn parse_wav_to_f32(wav_bytes: &[u8]) -> Result<Vec<f32>, String> {
    if wav_bytes.len() < 44 {
        return Err("WAV data too short".into());
    }
    if &wav_bytes[0..4] != b"RIFF" || &wav_bytes[8..12] != b"WAVE" {
        return Err("Not a valid WAV file".into());
    }

    let mut offset = 12;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut num_channels: u16 = 0;
    let mut data_start: usize = 0;
    let mut data_size: usize = 0;

    while offset + 8 <= wav_bytes.len() {
        let chunk_id = &wav_bytes[offset..offset + 4];
        let chunk_size =
            u32::from_le_bytes(wav_bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;

        if chunk_id == b"fmt " {
            if chunk_size < 16 || offset + 8 + chunk_size > wav_bytes.len() {
                return Err("Invalid fmt chunk".into());
            }
            let fmt_data = &wav_bytes[offset + 8..];
            let audio_format = u16::from_le_bytes(fmt_data[0..2].try_into().unwrap());
            if audio_format != 1 {
                return Err(format!(
                    "Unsupported audio format: {} (expected PCM=1)",
                    audio_format
                ));
            }
            num_channels = u16::from_le_bytes(fmt_data[2..4].try_into().unwrap());
            sample_rate = u32::from_le_bytes(fmt_data[4..8].try_into().unwrap());
            bits_per_sample = u16::from_le_bytes(fmt_data[14..16].try_into().unwrap());
        } else if chunk_id == b"data" {
            data_start = offset + 8;
            data_size = chunk_size;
            break;
        }

        offset += 8 + chunk_size;
        if !chunk_size.is_multiple_of(2) {
            offset += 1;
        }
    }

    if data_start == 0 || sample_rate == 0 {
        return Err("Missing fmt or data chunk".into());
    }

    if bits_per_sample != 16 {
        return Err(format!(
            "Unsupported bits per sample: {} (expected 16)",
            bits_per_sample
        ));
    }

    let actual_data_end = (data_start + data_size).min(wav_bytes.len());
    let pcm_data = &wav_bytes[data_start..actual_data_end];
    let sample_count = pcm_data.len() / 2;

    let mono_samples: Vec<f32> = if num_channels == 1 {
        (0..sample_count)
            .map(|i| {
                let s = i16::from_le_bytes(pcm_data[i * 2..i * 2 + 2].try_into().unwrap());
                s as f32 / 32768.0
            })
            .collect()
    } else {
        let frames = sample_count / num_channels as usize;
        (0..frames)
            .map(|f| {
                let mut sum = 0.0f32;
                for ch in 0..num_channels as usize {
                    let idx = (f * num_channels as usize + ch) * 2;
                    if idx + 1 < pcm_data.len() {
                        let s = i16::from_le_bytes(pcm_data[idx..idx + 2].try_into().unwrap());
                        sum += s as f32 / 32768.0;
                    }
                }
                sum / num_channels as f32
            })
            .collect()
    };

    if sample_rate == 16000 {
        Ok(mono_samples)
    } else {
        Ok(resample(&mono_samples, sample_rate, 16000))
    }
}

fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let output_len = (samples.len() as f64 / ratio) as usize;
    (0..output_len)
        .map(|i| {
            let src_pos = i as f64 * ratio;
            let idx = src_pos as usize;
            let frac = src_pos - idx as f64;
            let s0 = samples[idx.min(samples.len() - 1)];
            let s1 = samples[(idx + 1).min(samples.len() - 1)];
            s0 + (s1 - s0) * frac as f32
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

pub async fn whisper_get_status(app: AppHandle) -> Result<WhisperStatusInfo, String> {
    let manager = app.state::<VoiceManager>();
    Ok(manager.get_info())
}

pub async fn whisper_ensure_model(
    app: AppHandle,
    _proxy_url: Option<String>,
) -> Result<WhisperStatusInfo, String> {
    let manager = app.state::<VoiceManager>();

    {
        let state = manager.lock_state();
        if state.ctx.is_some() {
            return Ok(WhisperStatusInfo {
                status: WhisperStatus::Ready,
                model_path: state
                    .model_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string()),
                model_exists_on_disk: true,
            });
        }
    }

    let model_path = whisper_model_dir()?.join(MODEL_FILENAME);
    let model_ready = std::fs::metadata(&model_path)
        .map(|metadata| metadata.len() >= MODEL_SIZE_MIN)
        .unwrap_or(false);
    if !model_ready {
        let message = format!(
            "Whisper model is not installed. Place a local {} file (at least {} bytes) at {}.",
            MODEL_FILENAME,
            MODEL_SIZE_MIN,
            model_path.display()
        );
        manager.set_status(
            WhisperStatus::Error {
                message: message.clone(),
            },
            &app,
        );
        return Err(message);
    }

    manager.set_status(WhisperStatus::Loading, &app);
    let path_clone = model_path.clone();
    let ctx = tokio::task::spawn_blocking(move || {
        let params = WhisperContextParameters::default();
        WhisperContext::new_with_params(&path_clone.to_string_lossy(), params)
            .map_err(|e| format!("Failed to load Whisper model: {}", e))
    })
    .await
    .map_err(|e| {
        let msg = format!("Model loading task panicked: {}", e);
        manager.set_status(
            WhisperStatus::Error {
                message: msg.clone(),
            },
            &app,
        );
        msg
    })?
    .inspect_err(|e| {
        manager.set_status(WhisperStatus::Error { message: e.clone() }, &app);
    })?;

    {
        let mut state = manager.lock_state();
        state.ctx = Some(Arc::new(ctx));
        state.model_path = Some(model_path);
        state.status = WhisperStatus::Ready;
    }

    let info = manager.get_info();
    let _ = app.emit("whisper-status", &info);
    Ok(info)
}

pub async fn transcribe_audio(
    app: AppHandle,
    audio_data: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let manager = app.state::<VoiceManager>();

    if !manager.is_model_loaded() {
        return Err("Whisper model not loaded. Call whisper_ensure_model first.".into());
    }

    manager.set_status(WhisperStatus::Transcribing, &app);

    let start = std::time::Instant::now();

    let wav_bytes = BASE64
        .decode(&audio_data)
        .map_err(|e| format!("Failed to decode base64 audio: {}", e))?;

    let samples = parse_wav_to_f32(&wav_bytes)?;
    let audio_duration_ms = (samples.len() as f64 / 16000.0 * 1000.0) as u64;

    if samples.len() < 8000 {
        manager.set_status(WhisperStatus::Ready, &app);
        return Err("Recording too short (minimum 0.5 seconds)".into());
    }

    let ctx = {
        let state = manager.lock_state();
        state.ctx.clone().ok_or("Whisper context not available")?
    };

    let lang = language.clone().unwrap_or_default();
    let result = tokio::task::spawn_blocking(move || {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

        if !lang.is_empty() && lang != "auto" {
            params.set_language(Some(&lang));
        } else {
            params.set_language(None);
        }

        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_suppress_non_speech_tokens(true);

        let mut state = ctx
            .create_state()
            .map_err(|e| format!("Failed to create whisper state: {}", e))?;

        state
            .full(params, &samples)
            .map_err(|e| format!("Whisper inference failed: {}", e))?;

        let num_segments = state
            .full_n_segments()
            .map_err(|e| format!("Failed to get segments: {}", e))?;
        let mut text = String::new();
        let mut detected_lang = String::from("unknown");

        if let Ok(lang_id) = state.full_lang_id_from_state() {
            if let Some(lang_str) = whisper_rs::get_lang_str(lang_id) {
                detected_lang = lang_str.to_string();
            }
        }

        for i in 0..num_segments {
            if let Ok(segment_text) = state.full_get_segment_text(i) {
                text.push_str(&segment_text);
            }
        }

        Ok::<(String, String), String>((text.trim().to_string(), detected_lang))
    })
    .await
    .map_err(|e| format!("Transcription task panicked: {}", e))?;

    manager.set_status(WhisperStatus::Ready, &app);

    match result {
        Ok((text, detected_language)) => {
            let processing_ms = start.elapsed().as_millis() as u64;
            Ok(TranscriptionResult {
                text,
                language: detected_language,
                duration_ms: audio_duration_ms,
                processing_ms,
            })
        }
        Err(e) => {
            manager.set_status(WhisperStatus::Error { message: e.clone() }, &app);
            Err(e)
        }
    }
}
