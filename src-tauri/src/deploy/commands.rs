use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::collector::{collect_dist_files, FilePayload};
use super::config::DeployConfig;
use super::uploader::{finalize_deployment, upload_chunk};

const MAX_UPLOAD_BATCH_ENCODED_BYTES: usize = 7 * 1024 * 1024;
const MAX_UPLOAD_BATCH_FILES: usize = 50;
const MAX_BUILD_OUTPUT_BYTES: usize = 512 * 1024;
const BUILD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BUILD_POLL_INTERVAL: Duration = Duration::from_millis(50);
const RESERVED_SITE_IDS: &[&str] = &["www", "api", "mail"];

#[derive(Debug, Clone, Serialize)]
pub struct DeployProgress {
    #[serde(rename = "operationId")]
    pub operation_id: String,
    pub stage: String,
    pub message: String,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeployResult {
    pub url: String,
    #[serde(rename = "siteId")]
    pub site_id: String,
    #[serde(rename = "operationId")]
    pub operation_id: String,
}

struct BuildOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn emit_progress(app: &AppHandle, operation_id: &str, stage: &str, message: &str, percent: u8) {
    let progress = DeployProgress {
        operation_id: operation_id.to_string(),
        stage: stage.to_string(),
        message: message.to_string(),
        percent,
    };
    let _ = app.emit("deploy-progress", &progress);
}

fn generate_site_id() -> String {
    format!("site-{}", uuid::Uuid::new_v4().simple())
}

fn generate_operation_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn normalize_operation_id(value: Option<String>) -> Result<String, String> {
    match value {
        None => Ok(generate_operation_id()),
        Some(value)
            if !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) =>
        {
            Ok(value)
        }
        Some(_) => Err(
            "operationId must contain 1-64 ASCII letters, numbers, hyphens, or underscores."
                .to_string(),
        ),
    }
}

fn is_valid_site_id(site_id: &str) -> bool {
    let bytes = site_id.as_bytes();
    if !(2..=64).contains(&bytes.len()) || RESERVED_SITE_IDS.contains(&site_id) {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    if !bytes[bytes.len() - 1].is_ascii_lowercase() && !bytes[bytes.len() - 1].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn upload_batches(files: &[FilePayload]) -> Result<Vec<&[FilePayload]>, String> {
    let mut batches = Vec::new();
    let mut start = 0;
    let mut encoded_bytes: usize = 0;

    for (index, file) in files.iter().enumerate() {
        let file_bytes = file.content.len();
        if file_bytes > MAX_UPLOAD_BATCH_ENCODED_BYTES {
            return Err(format!(
                "File is too large for a preview upload batch: {}",
                file.path
            ));
        }
        if index > start
            && (index - start >= MAX_UPLOAD_BATCH_FILES
                || encoded_bytes.saturating_add(file_bytes) > MAX_UPLOAD_BATCH_ENCODED_BYTES)
        {
            batches.push(&files[start..index]);
            start = index;
            encoded_bytes = 0;
        }
        encoded_bytes = encoded_bytes.saturating_add(file_bytes);
    }

    if start < files.len() {
        batches.push(&files[start..]);
    }
    Ok(batches)
}

#[tauri::command]
pub async fn deploy_preview_site(
    project_path: String,
    site_id: Option<String>,
    operation_id: Option<String>,
    app: AppHandle,
) -> Result<DeployResult, String> {
    let operation_id = normalize_operation_id(operation_id)?;
    let site_id = match site_id {
        Some(site_id) if is_valid_site_id(&site_id) => site_id,
        Some(_) => return Err("Invalid preview site ID.".to_string()),
        None => generate_site_id(),
    };
    let deployment_id = uuid::Uuid::new_v4().simple().to_string();
    let project = PathBuf::from(&project_path);
    if !project.is_dir() {
        return Err("The preview project directory does not exist.".to_string());
    }

    let config = DeployConfig::load()?;
    config.validate()?;

    crate::sidecar::cli_tools::extend_process_path_with_known_dirs();

    emit_progress(
        &app,
        &operation_id,
        "building",
        "Detecting package manager...",
        5,
    );
    let package_manager = if project.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if project.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    };
    emit_progress(
        &app,
        &operation_id,
        "building",
        &format!("Running {package_manager} run build..."),
        10,
    );

    let build_output = tokio::task::spawn_blocking({
        let project_path = project_path.clone();
        let package_manager = package_manager.to_string();
        move || run_build(&project_path, &package_manager)
    })
    .await
    .map_err(|_| "The preview build task stopped unexpectedly.".to_string())??;

    if !build_output.status.success() {
        let stderr = String::from_utf8_lossy(&build_output.stderr);
        let stdout = String::from_utf8_lossy(&build_output.stdout);
        return Err(format!(
            "Build failed (exit code {:?}):\n{}\n{}",
            build_output.status.code(),
            stdout,
            stderr
        ));
    }

    emit_progress(&app, &operation_id, "building", "Build completed", 25);
    emit_progress(
        &app,
        &operation_id,
        "collecting",
        "Collecting dist files...",
        30,
    );

    let dist_path = project.join("dist").to_string_lossy().to_string();
    let files = collect_dist_files(&dist_path)?;
    let batches = upload_batches(&files)?;
    emit_progress(
        &app,
        &operation_id,
        "collecting",
        &format!("Collected {} files", files.len()),
        35,
    );

    let total_batches = batches.len();
    for (index, batch) in batches.into_iter().enumerate() {
        let batch_number = index + 1;
        let progress_percent = 40 + ((batch_number as f64 / total_batches as f64) * 50.0) as u8;
        emit_progress(
            &app,
            &operation_id,
            "uploading",
            &format!(
                "Uploading batch {batch_number}/{total_batches} ({} files)...",
                batch.len()
            ),
            progress_percent.min(90),
        );
        upload_chunk(&config, &site_id, &deployment_id, batch).await?;
    }

    emit_progress(
        &app,
        &operation_id,
        "finalizing",
        "Activating the completed deployment...",
        95,
    );
    let deploy_url = finalize_deployment(&config, &site_id, &deployment_id).await?;

    emit_progress(
        &app,
        &operation_id,
        "done",
        &format!("Deployed to {deploy_url}"),
        100,
    );

    Ok(DeployResult {
        url: deploy_url,
        site_id,
        operation_id,
    })
}

fn read_bounded<R: Read>(reader: &mut R, limit: usize) -> Vec<u8> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    let mut truncated = false;

    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        let remaining = limit.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&chunk[..read.min(remaining)]);
        }
        if read > remaining {
            truncated = true;
        }
    }

    if truncated {
        output.extend_from_slice(b"\n[output truncated]\n");
    }
    output
}

fn run_build(project_path: &str, package_manager: &str) -> Result<BuildOutput, String> {
    let mut diagnostics = Vec::<String>::new();
    let bin_dir = PathBuf::from(project_path)
        .join("node_modules")
        .join(".bin");
    diagnostics.push(format!("[diag] project_path: {project_path}"));
    diagnostics.push(format!(
        "[diag] node_modules/.bin exists: {}",
        bin_dir.exists()
    ));

    #[cfg(windows)]
    {
        let tsc_cmd = bin_dir.join("tsc.cmd");
        diagnostics.push(format!("[diag] tsc.cmd exists: {}", tsc_cmd.exists()));
    }

    #[cfg(windows)]
    let find_result = crate::preview::project_init::find_pm_cli(package_manager);
    #[cfg(windows)]
    {
        match &find_result {
            Some((node_exe, cli_js)) => diagnostics.push(format!(
                "[diag] find_pm_cli: node_exe={}, cli_js={}",
                node_exe,
                cli_js.display()
            )),
            None => diagnostics.push("[diag] find_pm_cli: None (fallback to cmd /C)".to_string()),
        }
    }

    #[cfg(windows)]
    let mut command = {
        if let Some((node_exe, cli_js)) = find_result {
            let mut command = std::process::Command::new(&node_exe);
            command.args([cli_js.to_string_lossy().as_ref(), "run", "build"]);
            diagnostics.push(format!(
                "[diag] command: {} {} run build",
                node_exe,
                cli_js.display()
            ));
            command
        } else {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", package_manager, "run", "build"]);
            diagnostics.push(format!(
                "[diag] command: cmd /C {package_manager} run build"
            ));
            command
        }
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = std::process::Command::new(package_manager);
        command.args(["run", "build"]);
        command
    };

    command
        .current_dir(project_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(windows)]
    {
        if bin_dir.exists() {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let filtered: Vec<&str> = current_path
                .split(';')
                .filter(|entry| {
                    let entry = entry.to_lowercase();
                    !entry.contains("target\\debug\\build")
                        && !entry.contains("target\\release\\build")
                        && !entry.contains("target/debug/build")
                        && !entry.contains("target/release/build")
                })
                .collect();
            let new_path = format!("{};{}", bin_dir.to_string_lossy(), filtered.join(";"));
            command.env("PATH", &new_path);
            diagnostics.push(format!(
                "[diag] PATH total length (original): {}",
                current_path.len()
            ));
            diagnostics.push(format!(
                "[diag] PATH total length (filtered): {}",
                new_path.len()
            ));
        }
    }

    let diagnostics = diagnostics.join("\n");
    log::info!("deploy build diagnostics:\n{diagnostics}");

    let mut child = command
        .spawn()
        .map_err(|_| format!("Failed to start the build command.\n{diagnostics}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture build stdout.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture build stderr.".to_string())?;
    let stdout_reader = thread::spawn(move || read_bounded(&mut stdout, MAX_BUILD_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_bounded(&mut stderr, MAX_BUILD_OUTPUT_BYTES));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= BUILD_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Build timed out after {} seconds.",
                    BUILD_TIMEOUT.as_secs()
                ));
            }
            Ok(None) => thread::sleep(BUILD_POLL_INTERVAL),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Failed while waiting for the build command.".to_string());
            }
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "Failed to collect build stdout.".to_string())?;
    let mut stderr = stderr_reader
        .join()
        .map_err(|_| "Failed to collect build stderr.".to_string())?;
    if !status.success() {
        let mut combined = diagnostics.into_bytes();
        combined.push(b'\n');
        combined.append(&mut stderr);
        stderr = combined;
    }

    Ok(BuildOutput {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, encoded_size: usize) -> FilePayload {
        FilePayload {
            path: path.to_string(),
            content: "a".repeat(encoded_size),
            content_type: "text/plain".to_string(),
        }
    }

    #[test]
    fn upload_batches_are_limited_by_encoded_bytes() {
        let files = vec![
            file("one.txt", 4 * 1024 * 1024),
            file("two.txt", 4 * 1024 * 1024),
            file("three.txt", 1024),
        ];
        let batches = upload_batches(&files).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(batches[1].len(), 2);
    }

    #[test]
    fn upload_batches_are_limited_by_file_count() {
        let files = (0..51)
            .map(|index| file(&format!("{index}.txt"), 1))
            .collect::<Vec<_>>();
        let batches = upload_batches(&files).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), MAX_UPLOAD_BATCH_FILES);
        assert_eq!(batches[1].len(), 1);
    }

    #[test]
    fn bounded_output_discards_excess_data() {
        let source = vec![b'x'; 32];
        let mut cursor = std::io::Cursor::new(source);
        let output = read_bounded(&mut cursor, 8);
        assert!(output.starts_with(b"xxxxxxxx"));
        assert!(output.ends_with(b"[output truncated]\n"));
    }

    #[test]
    fn generated_and_existing_ids_are_validated() {
        assert!(is_valid_site_id(&generate_site_id()));
        assert!(is_valid_site_id("site-one"));
        assert!(!is_valid_site_id("api"));
        assert!(!is_valid_site_id("../site"));
        assert!(normalize_operation_id(Some("operation-1".to_string())).is_ok());
        assert!(normalize_operation_id(Some("invalid operation".to_string())).is_err());
    }
}
