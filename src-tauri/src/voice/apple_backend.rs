#![cfg(target_os = "macos")]

use super::types::{TranscriptionResult, WhisperStatus, WhisperStatusInfo};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSArray, NSError, NSString, NSURL};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tempfile::{Builder as TempBuilder, NamedTempFile};

type TranscriptionSender = Sender<Result<String, String>>;
type SharedTranscriptionSender = Arc<Mutex<Option<TranscriptionSender>>>;

const AUTH_NOT_DETERMINED: i64 = 0;
const AUTH_DENIED: i64 = 1;
const AUTH_RESTRICTED: i64 = 2;
const AUTH_AUTHORIZED: i64 = 3;

const AF_NO_SPEECH_CODE: i64 = 1110;
const MIN_SAMPLES_16K: usize = 8000;
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(120);

struct AppleVoiceState {
    status: WhisperStatus,
}

pub struct VoiceManager {
    state: Mutex<AppleVoiceState>,
}

impl VoiceManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(AppleVoiceState {
                status: WhisperStatus::NotReady,
            }),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, AppleVoiceState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            log::warn!("[voice/apple] Mutex was poisoned, recovering");
            poisoned.into_inner()
        })
    }

    fn get_info(&self) -> WhisperStatusInfo {
        let status = { self.lock_state().status.clone() };
        WhisperStatusInfo {
            status,
            model_path: None,
            model_exists_on_disk: true,
        }
    }

    fn set_status(&self, status: WhisperStatus, app: &AppHandle) {
        {
            let mut s = self.lock_state();
            s.status = status;
        }
        let info = self.get_info();
        let _ = app.emit("whisper-status", &info);
    }
}

fn iso_to_bcp47(lang: Option<&str>) -> String {
    match lang.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("zh") | Some("zh-cn") | Some("zh-hans") | Some("zh-hans-cn") => "zh-CN".into(),
        Some("zh-tw") | Some("zh-hant") | Some("zh-hant-tw") => "zh-TW".into(),
        Some("zh-hk") | Some("zh-hant-hk") => "zh-HK".into(),
        Some("en") | Some("en-us") => "en-US".into(),
        Some("en-gb") => "en-GB".into(),
        Some("ja") | Some("ja-jp") => "ja-JP".into(),
        Some("ko") | Some("ko-kr") => "ko-KR".into(),
        Some("fr") => "fr-FR".into(),
        Some("de") => "de-DE".into(),
        Some("es") => "es-ES".into(),
        Some("it") => "it-IT".into(),
        Some("ru") => "ru-RU".into(),
        Some("pt") => "pt-BR".into(),
        Some("auto") | None | Some("") => system_preferred_locale(),
        Some(other) => other.to_string(),
    }
}

fn system_preferred_locale() -> String {
    autoreleasepool(|_| unsafe {
        let arr: *mut NSArray<NSString> = msg_send![class!(NSLocale), preferredLanguages];
        if arr.is_null() {
            return "en-US".to_string();
        }
        let count: usize = msg_send![arr, count];
        if count == 0 {
            return "en-US".to_string();
        }
        let first: *mut NSString = msg_send![arr, objectAtIndex: 0usize];
        if first.is_null() {
            return "en-US".to_string();
        }
        let s = (*first).to_string();
        normalize_preferred(&s)
    })
}

fn normalize_preferred(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("zh-hans") || lower == "zh-cn" || lower == "zh" {
        return "zh-CN".into();
    }
    if lower.starts_with("zh-hant") || lower == "zh-tw" {
        return "zh-TW".into();
    }
    if lower.starts_with("en") {
        return "en-US".into();
    }
    s.to_string()
}

fn estimate_wav_duration_ms(bytes: &[u8]) -> u64 {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return 0;
    }
    let mut i = 12usize;
    let mut sample_rate: u32 = 16000;
    let mut bits_per_sample: u16 = 16;
    let mut channels: u16 = 1;
    let mut data_size: u32 = 0;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes([bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]]);
        if id == b"fmt " && i + 8 + 16 <= bytes.len() {
            channels = u16::from_le_bytes([bytes[i + 10], bytes[i + 11]]);
            sample_rate =
                u32::from_le_bytes([bytes[i + 12], bytes[i + 13], bytes[i + 14], bytes[i + 15]]);
            bits_per_sample = u16::from_le_bytes([bytes[i + 22], bytes[i + 23]]);
        } else if id == b"data" {
            data_size = size;
            break;
        }
        i = i.saturating_add(8 + size as usize);
    }
    if sample_rate == 0 || bits_per_sample == 0 || channels == 0 || data_size == 0 {
        return 0;
    }
    let bytes_per_sample_frame = (bits_per_sample as u32 / 8) * channels as u32;
    if bytes_per_sample_frame == 0 {
        return 0;
    }
    let total_frames = data_size / bytes_per_sample_frame;
    ((total_frames as u64) * 1000) / sample_rate as u64
}

fn estimate_wav_samples_16k(bytes: &[u8]) -> usize {
    let dur_ms = estimate_wav_duration_ms(bytes);
    ((dur_ms * 16000) / 1000) as usize
}

fn read_auth_status() -> i64 {
    autoreleasepool(|_| unsafe {
        let cls = class!(SFSpeechRecognizer);
        let raw: i64 = msg_send![cls, authorizationStatus];
        raw
    })
}

fn auth_status_to_whisper(raw: i64) -> WhisperStatus {
    match raw {
        AUTH_AUTHORIZED => WhisperStatus::Ready,
        AUTH_NOT_DETERMINED => WhisperStatus::NotReady,
        AUTH_DENIED | AUTH_RESTRICTED => WhisperStatus::Error {
            message: "speech_permission_denied".into(),
        },
        _ => WhisperStatus::Error {
            message: format!("speech_unknown_auth_status:{}", raw),
        },
    }
}

pub async fn whisper_get_status(app: AppHandle) -> Result<WhisperStatusInfo, String> {
    let manager = app.state::<VoiceManager>();
    let auth = read_auth_status();
    let live = auth_status_to_whisper(auth);
    {
        let mut s = manager.lock_state();
        if !matches!(s.status, WhisperStatus::Transcribing) {
            s.status = live;
        }
    }
    Ok(manager.get_info())
}

pub async fn whisper_ensure_model(
    app: AppHandle,
    _proxy_url: Option<String>,
) -> Result<WhisperStatusInfo, String> {
    let manager = app.state::<VoiceManager>();

    let current = read_auth_status();
    if current == AUTH_AUTHORIZED {
        manager.set_status(WhisperStatus::Ready, &app);
        return Ok(manager.get_info());
    }
    if current == AUTH_DENIED || current == AUTH_RESTRICTED {
        manager.set_status(
            WhisperStatus::Error {
                message: "speech_permission_denied".into(),
            },
            &app,
        );
        return Ok(manager.get_info());
    }

    manager.set_status(WhisperStatus::Loading, &app);

    let (tx, rx) = mpsc::channel::<i64>();
    let tx_arc: Arc<Mutex<Option<Sender<i64>>>> = Arc::new(Mutex::new(Some(tx)));

    tokio::task::spawn_blocking(move || {
        autoreleasepool(|_| unsafe {
            let tx_for_block = tx_arc.clone();
            let handler = RcBlock::new(move |status: i64| {
                if let Ok(mut guard) = tx_for_block.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(status);
                    }
                }
            });
            let cls = class!(SFSpeechRecognizer);
            let _: () = msg_send![cls, requestAuthorization: &*handler];
        });
    });

    let result = tokio::task::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(60))
            .map_err(|e| format!("speech_auth_timeout:{}", e))
    })
    .await
    .map_err(|e| format!("speech_auth_join_error:{}", e))?;

    match result {
        Ok(code) => {
            manager.set_status(auth_status_to_whisper(code), &app);
        }
        Err(msg) => {
            manager.set_status(
                WhisperStatus::Error {
                    message: msg.clone(),
                },
                &app,
            );
        }
    }

    Ok(manager.get_info())
}

pub async fn transcribe_audio(
    app: AppHandle,
    audio_data: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let manager = app.state::<VoiceManager>();

    let auth = read_auth_status();
    if auth != AUTH_AUTHORIZED {
        return Err("speech_permission_denied".into());
    }

    let wav_bytes = BASE64
        .decode(audio_data.as_bytes())
        .map_err(|e| format!("audio_decode_failed:{}", e))?;

    let approx_samples = estimate_wav_samples_16k(&wav_bytes);
    if approx_samples > 0 && approx_samples < MIN_SAMPLES_16K {
        return Err("recording_too_short".into());
    }
    let duration_ms = estimate_wav_duration_ms(&wav_bytes);

    // 必须带 .wav 扩展名，否则 AVFoundation 无法识别文件格式，
    // SFSpeechURLRecognitionRequest 会报 AVFoundationErrorDomain -11828 (Cannot Open)。
    let mut tmp: NamedTempFile = TempBuilder::new()
        .prefix("bytro-voice-")
        .suffix(".wav")
        .tempfile()
        .map_err(|e| format!("tempfile_create_failed:{}", e))?;
    {
        use std::io::Write as _;
        tmp.write_all(&wav_bytes)
            .map_err(|e| format!("tempfile_write_failed:{}", e))?;
        tmp.flush().ok();
    }
    let path_str = tmp
        .path()
        .to_str()
        .ok_or_else(|| "tempfile_path_not_utf8".to_string())?
        .to_string();

    let locale_bcp47 = iso_to_bcp47(language.as_deref());
    let app_for_state = app.clone();
    manager.set_status(WhisperStatus::Transcribing, &app_for_state);

    let t_start = Instant::now();
    let blocking_result = tokio::task::spawn_blocking({
        let locale_bcp47 = locale_bcp47.clone();
        let path_str = path_str.clone();
        move || apple_transcribe_blocking(&path_str, &locale_bcp47)
    })
    .await
    .map_err(|e| format!("speech_join_error:{}", e))?;

    drop(tmp);

    let processing_ms = t_start.elapsed().as_millis() as u64;

    match blocking_result {
        Ok(text) => {
            manager.set_status(WhisperStatus::Ready, &app_for_state);
            Ok(TranscriptionResult {
                text,
                language: locale_bcp47,
                duration_ms,
                processing_ms,
            })
        }
        Err(msg) => {
            manager.set_status(
                WhisperStatus::Error {
                    message: msg.clone(),
                },
                &app_for_state,
            );
            Err(msg)
        }
    }
}

fn apple_transcribe_blocking(path: &str, locale_bcp47: &str) -> Result<String, String> {
    autoreleasepool(|_| unsafe {
        let locale_id = NSString::from_str(locale_bcp47);
        let locale_cls = class!(NSLocale);
        let locale_alloc: *mut AnyObject = msg_send![locale_cls, alloc];
        let locale: *mut AnyObject = msg_send![locale_alloc, initWithLocaleIdentifier: &*locale_id];
        if locale.is_null() {
            return Err(format!("speech_locale_unsupported:{}", locale_bcp47));
        }
        let _locale_owned: Retained<AnyObject> =
            Retained::from_raw(locale).ok_or_else(|| "speech_locale_retain_failed".to_string())?;

        let recognizer_cls = class!(SFSpeechRecognizer);
        let recog_alloc: *mut AnyObject = msg_send![recognizer_cls, alloc];
        let recognizer: *mut AnyObject = msg_send![recog_alloc, initWithLocale: locale];
        if recognizer.is_null() {
            return Err(format!("speech_locale_unsupported:{}", locale_bcp47));
        }
        let recognizer_owned: Retained<AnyObject> = Retained::from_raw(recognizer)
            .ok_or_else(|| "speech_recognizer_retain_failed".to_string())?;

        let available: Bool = msg_send![&*recognizer_owned, isAvailable];
        if !available.as_bool() {
            return Err("speech_recognizer_unavailable".into());
        }

        let on_device: Bool = msg_send![&*recognizer_owned, supportsOnDeviceRecognition];
        if !on_device.as_bool() {
            return Err(format!(
                "speech_on_device_recognition_unsupported:{}",
                locale_bcp47
            ));
        }

        let path_ns = NSString::from_str(path);
        let url: Retained<NSURL> = NSURL::fileURLWithPath(&path_ns);

        let req_cls = class!(SFSpeechURLRecognitionRequest);
        let req_alloc: *mut AnyObject = msg_send![req_cls, alloc];
        let request: *mut AnyObject = msg_send![req_alloc, initWithURL: &*url];
        if request.is_null() {
            return Err("speech_request_init_failed".into());
        }
        let request_owned: Retained<AnyObject> = Retained::from_raw(request)
            .ok_or_else(|| "speech_request_retain_failed".to_string())?;

        let _: () = msg_send![&*request_owned, setShouldReportPartialResults: Bool::NO];
        let _: () = msg_send![&*request_owned, setRequiresOnDeviceRecognition: Bool::YES];

        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let tx_arc: SharedTranscriptionSender = Arc::new(Mutex::new(Some(tx)));

        let handler_tx = tx_arc.clone();
        let handler = RcBlock::new(
            move |result_ptr: *mut AnyObject, error_ptr: *mut AnyObject| {
                let outcome = extract_outcome(result_ptr, error_ptr);
                let is_terminal = match &outcome {
                    Ok(_) => {
                        if !result_ptr.is_null() {
                            let is_final: Bool = msg_send![result_ptr, isFinal];
                            is_final.as_bool()
                        } else {
                            true
                        }
                    }
                    Err(_) => true,
                };
                if !is_terminal {
                    return;
                }
                if let Ok(mut guard) = handler_tx.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(outcome);
                    }
                }
            },
        );

        let task: *mut AnyObject = msg_send![
            &*recognizer_owned,
            recognitionTaskWithRequest: &*request_owned,
            resultHandler: &*handler
        ];
        if task.is_null() {
            return Err("speech_task_init_failed".into());
        }
        // `recognitionTaskWithRequest:resultHandler:` 不属于 new/init/alloc/copy/mutableCopy 家族，
        // 返回的是 autoreleased 对象（+0）。用 Retained::from_raw 会误认为 +1 owned，
        // 导致 Retained drop 与 autoreleasepool drain 各释放一次，触发 double-release 崩溃。
        // 这里必须用 Retained::retain，额外 retain 一次以匹配 Retained 的 drop。
        let _task_owned: Retained<AnyObject> =
            Retained::retain(task).ok_or_else(|| "speech_task_retain_failed".to_string())?;

        match rx.recv_timeout(TRANSCRIBE_TIMEOUT) {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => Err("speech_timeout".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("speech_channel_closed".into()),
        }
    })
}

unsafe fn extract_outcome(
    result_ptr: *mut AnyObject,
    error_ptr: *mut AnyObject,
) -> Result<String, String> {
    if !error_ptr.is_null() {
        let err = error_ptr as *mut NSError;
        let code: i64 = msg_send![err, code];
        let domain_ptr: *mut NSString = msg_send![err, domain];
        let domain = if domain_ptr.is_null() {
            "".to_string()
        } else {
            (*domain_ptr).to_string()
        };

        if code == AF_NO_SPEECH_CODE && domain.contains("AFAssistantErrorDomain") {
            return Ok(String::new());
        }

        let desc_ptr: *mut NSString = msg_send![err, localizedDescription];
        let desc = if desc_ptr.is_null() {
            String::new()
        } else {
            (*desc_ptr).to_string()
        };
        return Err(format!(
            "speech_error:{}:{}:{}",
            domain,
            code,
            if desc.is_empty() { "-" } else { &desc }
        ));
    }

    if result_ptr.is_null() {
        return Ok(String::new());
    }

    let best: *mut AnyObject = msg_send![result_ptr, bestTranscription];
    if best.is_null() {
        return Ok(String::new());
    }
    let formatted: *mut NSString = msg_send![best, formattedString];
    if formatted.is_null() {
        return Ok(String::new());
    }
    Ok((*formatted).to_string())
}
