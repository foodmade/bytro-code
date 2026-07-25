//! Port monitor: detects newly opened TCP LISTEN ports by PTY child processes.
//!
//! Uses the Windows `GetExtendedTcpTable` API (or `/proc/net/tcp` on Linux,
//! `lsof` on macOS) to periodically scan for new LISTEN ports belonging to
//! a tracked process tree. Emits `pty-port-detected` Tauri events when a new
//! port is found.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Interval between port scans.
const SCAN_INTERVAL: Duration = Duration::from_secs(2);

/// Ignore ports below this threshold (system/well-known ports).
const MIN_PORT: u16 = 1024;

// ─── Events ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortDetectedEvent {
    pub session_id: String,
    pub port: u16,
    pub url: String,
}

// ─── Tracked session info ────────────────────────────────────

struct TrackedSession {
    _pid: u32,
    shutdown: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

// ─── Manager ─────────────────────────────────────────────────

pub struct PortMonitor {
    sessions: Mutex<HashMap<String, TrackedSession>>,
}

impl PortMonitor {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Start monitoring ports for a PTY session's child process.
    pub fn start_watching(&self, app: AppHandle, session_id: String, pid: u32) {
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = Arc::clone(&shutdown);
        let sid = session_id.clone();

        let handle = std::thread::Builder::new()
            .name(format!(
                "port-mon-{}",
                &session_id[..8.min(session_id.len())]
            ))
            .spawn(move || {
                port_scan_loop(app, sid, pid, shutdown_clone);
            })
            .expect("Failed to spawn port monitor thread");

        let mut sessions = self.sessions.lock().expect("PortMonitor lock poisoned");
        sessions.insert(
            session_id,
            TrackedSession {
                _pid: pid,
                shutdown,
                handle: Some(handle),
            },
        );
    }

    /// Stop monitoring a specific session.
    pub fn stop_watching(&self, session_id: &str) {
        let mut sessions = self.sessions.lock().expect("PortMonitor lock poisoned");
        if let Some(mut tracked) = sessions.remove(session_id) {
            tracked.shutdown.store(true, Ordering::SeqCst);
            if let Some(handle) = tracked.handle.take() {
                // Don't join — let it exit on its own to avoid blocking
                drop(handle);
            }
        }
    }
}

impl Drop for PortMonitor {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, tracked) in sessions.drain() {
                tracked.shutdown.store(true, Ordering::SeqCst);
            }
        }
    }
}

// ─── Scan loop ───────────────────────────────────────────────

fn port_scan_loop(app: AppHandle, session_id: String, root_pid: u32, shutdown: Arc<AtomicBool>) {
    let mut known_ports: HashSet<u16> = HashSet::new();

    // Capture the initial global port snapshot to avoid reporting pre-existing ports
    if let Ok(initial) = get_all_listen_ports() {
        for (port, _) in &initial {
            known_ports.insert(*port);
        }
    }

    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }

        std::thread::sleep(SCAN_INTERVAL);

        if shutdown.load(Ordering::SeqCst) {
            break;
        }

        // Get the full process tree under root_pid
        let child_pids = get_process_tree(root_pid);

        // Get all LISTEN ports with their PIDs (IPv4 + IPv6)
        let listen_ports = match get_all_listen_ports() {
            Ok(ports) => ports,
            Err(_) => continue,
        };

        // Find new ports belonging to our process tree
        for (port, pid) in &listen_ports {
            if *port < MIN_PORT || known_ports.contains(port) {
                continue;
            }

            if child_pids.contains(pid) || *pid == root_pid {
                known_ports.insert(*port);
                let url = format!("http://localhost:{}", port);
                let _ = app.emit(
                    "pty-port-detected",
                    PortDetectedEvent {
                        session_id: session_id.clone(),
                        port: *port,
                        url,
                    },
                );
            }
        }
    }
}

// ─── Platform: Windows ───────────────────────────────────────

#[cfg(target_os = "windows")]
pub(crate) fn get_all_listen_ports() -> Result<Vec<(u16, u32)>, String> {
    let mut result = get_listen_ports_ipv4()?;
    // Also scan IPv6 — many dev servers (Vite, Next.js, etc.) bind to [::1] by default
    match get_listen_ports_ipv6() {
        Ok(v6_ports) => {
            // Deduplicate: if the same (port, pid) already exists from IPv4, skip it
            for entry in v6_ports {
                if !result.contains(&entry) {
                    result.push(entry);
                }
            }
        }
        Err(e) => {
            log::debug!("[PortDebug] IPv6 port scan failed (non-fatal): {}", e);
        }
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
fn get_listen_ports_ipv4() -> Result<Vec<(u16, u32)>, String> {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    let mut buf_size: u32 = 0;

    // First call to get required buffer size
    unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut buf_size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }

    if buf_size == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; buf_size as usize];

    let ret = unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr() as *mut _,
            &mut buf_size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };

    if ret != 0 {
        return Err(format!(
            "GetExtendedTcpTable (IPv4) failed with code {}",
            ret
        ));
    }

    let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let num_entries = table.dwNumEntries as usize;
    let rows_ptr = table.table.as_ptr();
    let mut result = Vec::with_capacity(num_entries);

    for i in 0..num_entries {
        let row = unsafe { &*rows_ptr.add(i) };
        let port = (row.dwLocalPort & 0xFFFF) as u16;
        let port = u16::from_be(port);
        let pid = row.dwOwningPid;
        result.push((port, pid));
    }

    Ok(result)
}

#[cfg(target_os = "windows")]
fn get_listen_ports_ipv6() -> Result<Vec<(u16, u32)>, String> {
    use std::ptr;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET6;

    let mut buf_size: u32 = 0;

    unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut buf_size,
            0,
            AF_INET6 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }

    if buf_size == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; buf_size as usize];

    let ret = unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr() as *mut _,
            &mut buf_size,
            0,
            AF_INET6 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };

    if ret != 0 {
        return Err(format!(
            "GetExtendedTcpTable (IPv6) failed with code {}",
            ret
        ));
    }

    let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID) };
    let num_entries = table.dwNumEntries as usize;
    let rows_ptr = table.table.as_ptr();
    let mut result = Vec::with_capacity(num_entries);

    for i in 0..num_entries {
        let row = unsafe { &*rows_ptr.add(i) };
        let port = (row.dwLocalPort & 0xFFFF) as u16;
        let port = u16::from_be(port);
        let pid = row.dwOwningPid;
        result.push((port, pid));
    }

    Ok(result)
}

#[cfg(target_os = "windows")]
fn get_process_tree(root_pid: u32) -> HashSet<u32> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    let mut tree = HashSet::new();
    tree.insert(root_pid);

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        return tree;
    }

    let mut entry: PROCESSENTRY32 = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<PROCESSENTRY32>() as u32;

    // Collect all processes
    let mut all_processes: Vec<(u32, u32)> = Vec::new();
    unsafe {
        if Process32First(snapshot, &mut entry) != 0 {
            all_processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
            while Process32Next(snapshot, &mut entry) != 0 {
                all_processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
        }
        windows_sys::Win32::Foundation::CloseHandle(snapshot);
    }

    // BFS to find all descendants
    let mut changed = true;
    while changed {
        changed = false;
        for &(pid, ppid) in &all_processes {
            if tree.contains(&ppid) && !tree.contains(&pid) {
                tree.insert(pid);
                changed = true;
            }
        }
    }

    tree
}

#[cfg(target_os = "windows")]
use std::mem;

// ─── Platform: macOS / Linux ─────────────────────────────────

#[cfg(not(target_os = "windows"))]
pub(crate) fn get_all_listen_ports() -> Result<Vec<(u16, u32)>, String> {
    // Use `lsof` on macOS, parse `/proc/net/tcp` on Linux
    #[cfg(target_os = "linux")]
    {
        get_listen_ports_linux()
    }
    #[cfg(target_os = "macos")]
    {
        get_listen_ports_macos()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "linux")]
fn get_listen_ports_linux() -> Result<Vec<(u16, u32)>, String> {
    use std::fs;

    let content = fs::read_to_string("/proc/net/tcp")
        .map_err(|e| format!("Failed to read /proc/net/tcp: {}", e))?;

    let mut result = Vec::new();

    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }

        // State 0A = LISTEN
        let state = fields[3];
        if state != "0A" {
            continue;
        }

        // Parse local address: hex_ip:hex_port
        if let Some(port_hex) = fields[1].split(':').nth(1) {
            if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                // UID is in field 7, inode in field 9
                // We need PID — read /proc/*/fd/* to map inode → PID
                // For simplicity, use field index if available or default to 0
                let inode = fields
                    .get(9)
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let pid = inode_to_pid(inode).unwrap_or(0);
                result.push((port, pid));
            }
        }
    }

    Ok(result)
}

#[cfg(target_os = "linux")]
fn inode_to_pid(target_inode: u64) -> Option<u32> {
    use std::fs;

    if target_inode == 0 {
        return None;
    }

    let proc_dir = fs::read_dir("/proc").ok()?;
    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Ok(pid) = name_str.parse::<u32>() {
            let fd_dir = format!("/proc/{}/fd", pid);
            if let Ok(fds) = fs::read_dir(&fd_dir) {
                for fd_entry in fds.flatten() {
                    if let Ok(link) = fs::read_link(fd_entry.path()) {
                        let link_str = link.to_string_lossy();
                        if link_str.contains(&format!("socket:[{}]", target_inode)) {
                            return Some(pid);
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn get_listen_ports_macos() -> Result<Vec<(u16, u32)>, String> {
    let output = std::process::Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-nP", "-Fn"])
        .output()
        .map_err(|e| format!("Failed to run lsof: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();
    let mut current_pid: u32 = 0;

    for line in stdout.lines() {
        if let Some(pid_str) = line.strip_prefix('p') {
            current_pid = pid_str.parse().unwrap_or(0);
        } else if let Some(name) = line.strip_prefix('n') {
            // Format: *:PORT or 127.0.0.1:PORT or [::1]:PORT
            if let Some(port_str) = name.rsplit(':').next() {
                if let Ok(port) = port_str.parse::<u16>() {
                    result.push((port, current_pid));
                }
            }
        }
    }

    Ok(result)
}

#[cfg(not(target_os = "windows"))]
fn get_process_tree(root_pid: u32) -> HashSet<u32> {
    let mut tree = HashSet::new();
    tree.insert(root_pid);

    // Use `ps` to get all PID/PPID pairs
    let output = match std::process::Command::new("ps")
        .args(["-eo", "pid,ppid"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return tree,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut all_processes: Vec<(u32, u32)> = Vec::new();

    for line in stdout.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 2 {
            if let (Ok(pid), Ok(ppid)) = (fields[0].parse(), fields[1].parse()) {
                all_processes.push((pid, ppid));
            }
        }
    }

    // BFS to find all descendants
    let mut changed = true;
    while changed {
        changed = false;
        for &(pid, ppid) in &all_processes {
            if tree.contains(&ppid) && !tree.contains(&pid) {
                tree.insert(pid);
                changed = true;
            }
        }
    }

    tree
}
