use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::port_monitor::PortMonitor;
use tauri::{AppHandle, Emitter, State};

const BUFFER_MAX_BYTES: usize = 4096;

/// GNU LS_COLORS — file-type colorization rules (Xshell-inspired palette).
/// Compiled at build time via concat!() — zero runtime cost.
const LS_COLORS_VAL: &str = concat!(
    // ── File-type indicators ──
    "rs=0:",       // reset
    "di=1;34:",    // directory -> bold blue
    "ln=1;36:",    // symbolic link -> bold cyan
    "pi=33;40:",   // named pipe -> yellow on black bg
    "so=1;35:",    // socket -> bold magenta
    "do=1;35:",    // door -> bold magenta
    "bd=1;33;40:", // block device -> bold yellow on black bg
    "cd=1;33;40:", // char device -> bold yellow on black bg
    "or=1;31;40:", // orphan symlink -> bold red on black bg
    "mi=1;31;40:", // missing target -> bold red on black bg
    "su=37;41:",   // setuid -> white on red bg
    "sg=30;43:",   // setgid -> black on yellow bg
    "tw=30;42:",   // sticky + other-writable dir -> black on green bg
    "ow=34;42:",   // other-writable dir -> blue on green bg
    "st=37;44:",   // sticky dir -> white on blue bg
    "ex=1;32:",    // executable -> bold green
    // ── Archives / Compressed (red 0;31) ──
    "*.tar=0;31:",
    "*.tgz=0;31:",
    "*.zip=0;31:",
    "*.gz=0;31:",
    "*.bz2=0;31:",
    "*.xz=0;31:",
    "*.zst=0;31:",
    "*.7z=0;31:",
    "*.rar=0;31:",
    "*.deb=0;31:",
    "*.rpm=0;31:",
    "*.jar=0;31:",
    "*.dmg=0;31:",
    "*.iso=0;31:",
    "*.msi=0;31:",
    "*.cab=0;31:",
    // ── Images (magenta 0;35) ──
    "*.jpg=0;35:",
    "*.jpeg=0;35:",
    "*.png=0;35:",
    "*.gif=0;35:",
    "*.bmp=0;35:",
    "*.svg=0;35:",
    "*.ico=0;35:",
    "*.webp=0;35:",
    "*.tif=0;35:",
    "*.tiff=0;35:",
    "*.heic=0;35:",
    "*.avif=0;35:",
    // ── Video (bold magenta 1;35) ──
    "*.mp4=1;35:",
    "*.mkv=1;35:",
    "*.avi=1;35:",
    "*.mov=1;35:",
    "*.wmv=1;35:",
    "*.flv=1;35:",
    "*.webm=1;35:",
    "*.m4v=1;35:",
    // ── Audio (cyan 0;36) ──
    "*.mp3=0;36:",
    "*.flac=0;36:",
    "*.wav=0;36:",
    "*.ogg=0;36:",
    "*.aac=0;36:",
    "*.m4a=0;36:",
    "*.opus=0;36:",
    "*.wma=0;36:",
    // ── Documents (underline + white 4;37) ──
    "*.pdf=4;37:",
    "*.doc=4;37:",
    "*.docx=4;37:",
    "*.xls=4;37:",
    "*.xlsx=4;37:",
    "*.ppt=4;37:",
    "*.pptx=4;37:",
    "*.md=4;37:",
    "*.txt=4;37:",
    "*.csv=4;37:",
    // ── Config / data (underline + white 4;37) ──
    "*.json=4;37:",
    "*.yaml=4;37:",
    "*.yml=4;37:",
    "*.toml=4;37:",
    "*.xml=4;37:",
    "*.ini=4;37:",
    "*.conf=4;37:",
    // ── Source code (green 0;32 — plain, not bold, to distinguish from executables) ──
    "*.rs=0;32:",
    "*.ts=0;32:",
    "*.tsx=0;32:",
    "*.js=0;32:",
    "*.jsx=0;32:",
    "*.py=0;32:",
    "*.go=0;32:",
    "*.c=0;32:",
    "*.cpp=0;32:",
    "*.h=0;32:",
    "*.java=0;32:",
    "*.swift=0;32:",
    "*.rb=0;32:",
    "*.php=0;32:",
    "*.cs=0;32:",
    "*.sh=0;32:",
    "*.html=0;32:",
    "*.css=0;32:",
    "*.scss=0;32:",
    "*.vue=0;32:",
    "*.dart=0;32:",
    "*.zig=0;32:",
    "*.sql=0;32:",
    // ── Backup / temp (dimmed via bright-black 90) ──
    "*~=90:",
    "*.bak=90:",
    "*.old=90:",
    "*.orig=90:",
    "*.swp=90:",
    "*.tmp=90:",
    "*.log=90:",
    "*.DS_Store=90:"
);

/// BSD LSCOLORS for macOS `ls -G` colorization (22-char format).
const BSD_LSCOLORS: &str = "ExGxfxdxCxegedabagacad";

// ─── Events ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOutputEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

// ─── Session ─────────────────────────────────────────────────

struct PtySessionInner {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    /// 子进程 PID，用于 Windows 上 taskkill 杀进程树
    child_pid: Option<u32>,
    /// 共享的停止信号，reader 线程会轮询此标志
    shutdown: Arc<AtomicBool>,
    /// reader 线程句柄，用于等待线程退出
    reader_handle: Option<std::thread::JoinHandle<()>>,
}

impl PtySessionInner {
    /// 优雅地关闭会话：发送停止信号 → kill 进程树 → 等待 reader 线程结束
    fn shutdown(&mut self) {
        log::info!("[PTY shutdown] start, child_pid={:?}", self.child_pid);

        // 1. 通知 reader 线程停止
        self.shutdown.store(true, Ordering::SeqCst);

        // 2. 在 Windows 上用 taskkill /T /F 杀整个进程树（包括子进程如 node/vite），
        //    否则子进程会变成孤儿进程继续占用端口
        #[cfg(windows)]
        if let Some(pid) = self.child_pid {
            use std::os::windows::process::CommandExt;
            log::info!("[PTY shutdown] running taskkill /T /F /PID {}", pid);
            let result = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
            match result {
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    log::info!(
                        "[PTY shutdown] taskkill exit={}, stdout={}, stderr={}",
                        output.status,
                        stdout.trim(),
                        stderr.trim()
                    );
                }
                Err(e) => {
                    log::error!("[PTY shutdown] taskkill failed to execute: {}", e);
                }
            }
        }

        #[cfg(windows)]
        if self.child_pid.is_none() {
            log::warn!("[PTY shutdown] child_pid is None, taskkill skipped!");
        }

        // 3. 回退：显式 kill 子进程，确保 reader 线程的 read() 调用能返回
        log::info!("[PTY shutdown] calling child.kill()");
        let _ = self.child.kill();

        // 4. 等待 reader 线程退出，避免无限阻塞
        log::info!("[PTY shutdown] waiting for reader thread");
        if let Some(handle) = self.reader_handle.take() {
            let _ = handle.join();
        }
        log::info!("[PTY shutdown] done");
    }
}

/// 当 PtySessionInner 被 Drop 时，自动触发 shutdown
impl Drop for PtySessionInner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ─── Manager ─────────────────────────────────────────────────

pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySessionInner>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// 当 PtyManager 被 Drop 时（应用退出），自动清理所有会话
impl Drop for PtyManager {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            let session_ids: Vec<String> = sessions.keys().cloned().collect();
            log::info!(
                "PtyManager dropping, cleaning up {} sessions: {:?}",
                session_ids.len(),
                session_ids
            );
            // HashMap::clear() 会 drop 所有 value → 触发 PtySessionInner::drop()
            sessions.clear();
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────

fn get_default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        // Prefer PowerShell for better interactive experience (ls, tab completion, etc.)
        // Try pwsh (PowerShell 7+) first, then fall back to Windows PowerShell 5.1 (always available on Win10+)
        if std::process::Command::new("pwsh")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
        {
            "pwsh".to_string()
        } else {
            "powershell.exe".to_string()
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn get_default_cwd() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// Decode PTY output bytes to a UTF-8 string.
/// Returns (decoded_string, bytes_consumed). When the buffer ends with an
/// incomplete multi-byte UTF-8 sequence, only the valid prefix is returned
/// and the caller should preserve `buf[consumed..]` for the next read.
/// On Windows, falls back to GBK for truly invalid UTF-8 (e.g. legacy tools
/// or the transient period before shell UTF-8 initialization takes effect).
fn decode_pty_output(buf: &[u8]) -> (String, usize) {
    match std::str::from_utf8(buf) {
        Ok(s) => (s.to_string(), buf.len()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();

            // error_len() == None means incomplete multi-byte sequence at the tail.
            // Return the valid prefix; caller preserves the remainder for next read.
            if e.error_len().is_none() {
                if valid_up_to > 0 {
                    let valid = std::str::from_utf8(&buf[..valid_up_to]).unwrap();
                    return (valid.to_string(), valid_up_to);
                }
                // Entire buffer is an incomplete sequence (1-3 bytes) — preserve all
                return (String::new(), 0);
            }

            // Truly invalid UTF-8 — try GBK on Windows
            #[cfg(windows)]
            {
                let (decoded, _, _) = encoding_rs::GBK.decode(buf);
                return (decoded.into_owned(), buf.len());
            }

            #[cfg(not(windows))]
            (String::from_utf8_lossy(buf).into_owned(), buf.len())
        }
    }
}

fn flush_buffer(app: &AppHandle, session_id: &str, buf: &mut Vec<u8>) {
    if buf.is_empty() {
        return;
    }
    let (data, consumed) = decode_pty_output(buf);
    if !data.is_empty() {
        let _ = app.emit(
            "pty-output",
            PtyOutputEvent {
                session_id: session_id.to_string(),
                data,
            },
        );
    }
    if consumed < buf.len() {
        // Preserve incomplete trailing multi-byte sequence for next read
        let remaining = buf[consumed..].to_vec();
        buf.clear();
        buf.extend_from_slice(&remaining);
    } else {
        buf.clear();
    }
}

/// Force-flush all remaining bytes (used at EOF/shutdown when no more data will arrive).
fn flush_buffer_final(app: &AppHandle, session_id: &str, buf: &mut Vec<u8>) {
    if buf.is_empty() {
        return;
    }
    let data = String::from_utf8_lossy(buf).into_owned();
    let _ = app.emit(
        "pty-output",
        PtyOutputEvent {
            session_id: session_id.to_string(),
            data,
        },
    );
    buf.clear();
}

/// 创建 reader 线程，返回 JoinHandle 以便后续 join
fn spawn_reader_thread(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    shutdown: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name(format!("pty-reader-{}", &session_id[..8]))
        .spawn(move || {
            let mut raw_buf = [0u8; 8192];
            let mut acc_buf = Vec::with_capacity(BUFFER_MAX_BYTES);

            loop {
                // 在每次 read 前检查停止信号
                if shutdown.load(Ordering::SeqCst) {
                    log::debug!(
                        "Reader thread for session {} received shutdown signal",
                        session_id
                    );
                    flush_buffer_final(&app, &session_id, &mut acc_buf);
                    break;
                }

                match reader.read(&mut raw_buf) {
                    Ok(0) => {
                        // EOF：子进程已退出
                        flush_buffer_final(&app, &session_id, &mut acc_buf);
                        if !shutdown.load(Ordering::SeqCst) {
                            let _ = app.emit(
                                "pty-exit",
                                PtyExitEvent {
                                    session_id: session_id.clone(),
                                    exit_code: None,
                                },
                            );
                        }
                        break;
                    }
                    Ok(n) => {
                        acc_buf.extend_from_slice(&raw_buf[..n]);

                        // 每次 read 后立即刷新，避免交互输入延迟。
                        // read() 是阻塞调用，如果不立即刷新，缓冲区中的数据
                        // 会卡到下一次 read 返回才发送，导致输入字符丢失/延迟显示。
                        // raw_buf 8192 字节的 read 本身已提供高吞吐场景下的自然批量效果。
                        flush_buffer(&app, &session_id, &mut acc_buf);
                    }
                    Err(e) => {
                        log::debug!("Reader thread for session {} read error: {}", session_id, e);
                        flush_buffer_final(&app, &session_id, &mut acc_buf);
                        if !shutdown.load(Ordering::SeqCst) {
                            let _ = app.emit(
                                "pty-exit",
                                PtyExitEvent {
                                    session_id: session_id.clone(),
                                    exit_code: None,
                                },
                            );
                        }
                        break;
                    }
                }
            }
            log::debug!("Reader thread for session {} exited cleanly", session_id);
        })
        .expect("Failed to spawn PTY reader thread")
}

// ─── Tauri Commands ──────────────────────────────────────────

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    pty_manager: State<'_, PtyManager>,
    port_monitor: State<'_, PortMonitor>,
    shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let shell_path = shell.unwrap_or_else(get_default_shell);
    let working_dir = cwd.unwrap_or_else(get_default_cwd);
    let pty_rows = rows.unwrap_or(24);
    let pty_cols = cols.unwrap_or(80);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&shell_path);
    let shell_lower = shell_path.to_lowercase();

    // Set environment variables for the PTY shell:
    // - TERM/COLORTERM: identify as xterm-256color so the shell correctly
    //   interprets control characters (backspace, arrows, etc.) and enables
    //   color support. Without TERM, macOS zsh falls back to "dumb" mode
    //   where backspace (\x7f) is not recognized as an erase character.
    // - POSIX locale vars: ensure UTF-8 encoding.
    // - Python vars: force UTF-8 I/O for Python subprocesses.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    // File-type colorization for ls/tree/fd/eza and other tools.
    // User's shell RC (e.g. eval $(dircolors ...)) naturally overrides these.
    cmd.env("LS_COLORS", LS_COLORS_VAL);
    cmd.env("CLICOLOR", "1");
    cmd.env("LSCOLORS", BSD_LSCOLORS);

    // Strip env vars that break the user's shell-managed Node toolchain.
    // - `npm_config_prefix` makes nvm refuse to load (`nvm is not compatible with
    //   the "npm_config_prefix" environment variable`), so the PTY ends up with
    //   whatever stale node the previous `nvm use` left in PATH (often older
    //   than what Vite needs). Removing it lets the user's `.zshrc`/`.bashrc`
    //   activate the nvm version they actually picked.
    // - `npm_config_globalconfig` / `npm_config_userconfig` can pin npm to
    //   app-internal config files; let the user's npm find its own.
    for key in [
        "npm_config_prefix",
        "NPM_CONFIG_PREFIX",
        "npm_config_globalconfig",
        "NPM_CONFIG_GLOBALCONFIG",
        "npm_config_userconfig",
        "NPM_CONFIG_USERCONFIG",
    ] {
        cmd.env_remove(key);
    }

    #[cfg(windows)]
    {
        if shell_lower.contains("powershell") || shell_lower.contains("pwsh") {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(concat!(
                "try { ",
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ",
                "[Console]::InputEncoding  = [System.Text.Encoding]::UTF8; ",
                "$OutputEncoding = [System.Text.Encoding]::UTF8; ",
                "if ($PSStyle) { ",
                "$PSStyle.FileInfo.Directory = \"`e[1;34m\"; ",
                "$PSStyle.FileInfo.SymbolicLink = \"`e[1;36m\"; ",
                "$PSStyle.FileInfo.Executable = \"`e[1;32m\"; ",
                "foreach ($x in @('.zip','.tar','.gz','.7z','.rar')) { ",
                "$PSStyle.FileInfo.Extension.Remove($x); ",
                "$PSStyle.FileInfo.Extension.Add($x, \"`e[0;31m\") ",
                "} ",
                "} ",
                "} catch {}",
            ));
        } else if shell_lower.contains("cmd") {
            cmd.arg("/K");
            cmd.arg("chcp 65001 >nul");
        }
        // Git Bash / MSYS2: LS_COLORS env var is sufficient.
    }

    #[cfg(not(windows))]
    {
        if shell_lower.contains("powershell") || shell_lower.contains("pwsh") {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(concat!(
                "try { ",
                "if ($PSStyle) { ",
                "$PSStyle.FileInfo.Directory = \"`e[1;34m\"; ",
                "$PSStyle.FileInfo.SymbolicLink = \"`e[1;36m\"; ",
                "$PSStyle.FileInfo.Executable = \"`e[1;32m\"; ",
                "} ",
                "} catch {}",
            ));
        }
    }

    cmd.cwd(&working_dir);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Capture child PID before moving child into session
    let child_pid = child.process_id();

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let reader_handle = spawn_reader_thread(
        app.clone(),
        session_id.clone(),
        reader,
        Arc::clone(&shutdown),
    );

    let session = PtySessionInner {
        master: pair.master,
        writer,
        child,
        child_pid,
        shutdown,
        reader_handle: Some(reader_handle),
    };

    {
        let mut sessions = pty_manager.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(session_id.clone(), session);
    }

    // Start port monitoring for this session's child process
    if let Some(pid) = child_pid {
        log::info!(
            "PTY session {} spawned (shell={}, cwd={}, PID={}), starting port monitor",
            &session_id[..8],
            shell_path,
            working_dir,
            pid
        );
        port_monitor.start_watching(app, session_id.clone(), pid);
    } else {
        log::warn!(
            "PTY session {} spawned but child PID is None, port monitoring skipped",
            &session_id[..8]
        );
    }

    Ok(session_id)
}

#[tauri::command]
pub fn write_pty(
    pty_manager: State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = pty_manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;

    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    pty_manager: State<'_, PtyManager>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = pty_manager.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn kill_pty(
    pty_manager: State<'_, PtyManager>,
    port_monitor: State<'_, PortMonitor>,
    session_id: String,
) -> Result<(), String> {
    log::info!(
        "[kill_pty] called for session {}",
        &session_id[..8.min(session_id.len())]
    );

    // Stop port monitoring first
    port_monitor.stop_watching(&session_id);
    let mut sessions = pty_manager.sessions.lock().map_err(|e| e.to_string())?;

    let session_count = sessions.len();
    let has_session = sessions.contains_key(&session_id);
    log::info!(
        "[kill_pty] sessions_count={}, has_target={}",
        session_count,
        has_session
    );

    let session = sessions.remove(&session_id).ok_or_else(|| {
        log::error!("[kill_pty] Session not found: {}", session_id);
        format!("Session not found: {}", session_id)
    })?;

    log::info!(
        "[kill_pty] session removed, child_pid={:?}, spawning kill thread",
        session.child_pid
    );

    // Spawn a background thread for shutdown to avoid blocking the IPC thread.
    // shutdown() calls handle.join() which can block indefinitely on Windows
    // if the reader thread is stuck in a blocking read() call.
    let sid = session_id.clone();
    std::thread::Builder::new()
        .name(format!(
            "pty-kill-{}",
            &session_id[..8.min(session_id.len())]
        ))
        .spawn(move || {
            // `session` is moved into this thread; Drop will call shutdown()
            drop(session);
            log::info!("[kill_pty] PTY session {} killed and cleaned up", sid);
        })
        .map_err(|e| format!("Failed to spawn kill thread: {}", e))?;

    Ok(())
}
