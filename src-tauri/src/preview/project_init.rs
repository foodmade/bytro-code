use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

/// China npm mirror — significantly faster for users in mainland China.
/// Name of the file storing the package.json hash inside the cache directory.
const CACHE_HASH_FILE: &str = ".pkg-hash";

/// Cache format version — bump this to invalidate all existing caches.
/// v2: preserves symlinks in node_modules/.bin (critical for macOS/Linux).
/// v3: invalidates caches created before dependency integrity checks.
const CACHE_VERSION: &str = "3";
const CACHE_VERSION_FILE: &str = ".cache-version";

#[derive(Debug, Clone)]
pub(crate) struct PreviewDependencyIssue {
    pub message: String,
    pub missing_rollup_package: Option<String>,
}

/// On Windows, find the npm-cli.js entry point by scanning PATH for nodejs dirs.
/// Returns (node_exe, cli_js_path) so we can run `node <cli_js> install` directly
/// instead of going through cmd.exe /C which silently fails in GUI processes.
#[cfg(windows)]
pub(crate) fn find_pm_cli(pm: &str) -> Option<(String, PathBuf)> {
    let cli_relative = match pm {
        "npm" => "node_modules/npm/bin/npm-cli.js",
        "pnpm" => return None, // pnpm has a native .exe on newer versions
        "yarn" => "node_modules/yarn/bin/yarn.js",
        _ => return None,
    };

    let path_var = std::env::var("PATH").ok()?;
    for dir in path_var.split(';') {
        let candidate = PathBuf::from(dir).join(cli_relative);
        if candidate.exists() {
            // node.exe should be in the same directory
            let node_exe = PathBuf::from(dir).join("node.exe");
            let exe = if node_exe.exists() {
                node_exe.to_string_lossy().to_string()
            } else {
                "node".to_string() // fallback to PATH lookup
            };
            return Some((exe, candidate));
        }
    }
    None
}

/// Initialize preview project: copy template + npm install
#[tauri::command]
pub async fn init_preview_project(
    target_dir: String,
    project_name: String,
    app: AppHandle,
) -> Result<String, String> {
    // Validate project name
    if project_name.is_empty()
        || project_name.contains('/')
        || project_name.contains('\\')
        || project_name.contains("..")
        || project_name.contains('\0')
        || project_name.starts_with('.')
    {
        return Err(
            "Invalid project name. Must not contain /, \\, .., null bytes, or start with a dot."
                .to_string(),
        );
    }

    // Validate target_dir is absolute and exists
    let target_base = PathBuf::from(&target_dir);
    if !target_base.is_absolute() {
        return Err("Target directory must be an absolute path".to_string());
    }
    if !target_base.exists() {
        return Err(format!("Target directory does not exist: {}", target_dir));
    }

    let target = target_base.join(&project_name);

    if target.exists() {
        return Err(format!("Directory already exists: {}", target.display()));
    }

    // Get template path
    // Dev mode: use CARGO_MANIFEST_DIR to locate the template in the source tree.
    // Production: use Tauri's resource_dir() which bundles files from tauri.conf.json.
    let template_dir = if cfg!(dev) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/preview-template")
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Failed to get resource dir: {}", e))?;
        resource_dir.join("preview-template")
    };

    if !template_dir.exists() || !template_dir.join("package.json").exists() {
        return Err(format!(
            "Preview template not found or incomplete at: {}",
            template_dir.display()
        ));
    }

    // Write lock file
    let lock_file = target.join(".bytro-init-lock");
    tokio::fs::create_dir_all(&target)
        .await
        .map_err(|e| format!("Failed to create project dir: {}", e))?;
    tokio::fs::write(&lock_file, "initializing")
        .await
        .map_err(|e| format!("Failed to write lock file: {}", e))?;

    let _ = app.emit("preview-init-log", "Copying project template...");

    // Recursive copy (skip node_modules)
    copy_dir_recursive(&template_dir, &target)
        .await
        .map_err(|e| format!("Failed to copy template: {}", e))?;

    // Ensure PATH includes Node.js
    crate::sidecar::cli_tools::extend_process_path_with_known_dirs();

    // Detect package manager
    let pm = detect_package_manager(&target);

    // Resolve the node executable — used both for npm-cli and postinstall scripts.
    #[cfg(windows)]
    let node_exe = find_pm_cli(&pm)
        .map(|(exe, _)| exe)
        .unwrap_or_else(|| "node".to_string());

    #[cfg(not(windows))]
    let node_exe = "node".to_string();

    // --- node_modules cache: copy from cache if available, else npm install + cache ---
    let cache_dir = get_nm_cache_dir(&app)?;
    let pkg_hash = hash_package_json(&target.join("package.json")).await;

    let cache_hit = if let Some(ref hash) = pkg_hash {
        check_cache_valid(&cache_dir, hash).await
    } else {
        false
    };

    if cache_hit {
        let _ = app.emit("preview-init-log", "Restoring cached node_modules...");
        let cached_nm = cache_dir.join("node_modules");
        let target_nm = target.join("node_modules");
        // Use copy_dir_all (not copy_dir_recursive) to preserve:
        //   1. Symlinks in .bin/ (critical for macOS/Linux)
        //   2. Nested node_modules inside packages
        if let Err(e) = copy_dir_all(&cached_nm, &target_nm).await {
            // Cache copy failed — fall back to npm install
            let _ = app.emit(
                "preview-init-log",
                &format!(
                    "Cache restore failed ({}), falling back to npm install...",
                    e
                ),
            );
            let _ = tokio::fs::remove_dir_all(&target_nm).await;
            run_full_install(&app, &pm, &node_exe, &target, &lock_file).await?;
            save_to_cache(&app, &target, &cache_dir, &pkg_hash).await;
        } else {
            let _ = app.emit("preview-init-log", "Dependencies restored from cache.");
        }
    } else {
        let _ = app.emit("preview-init-log", "Installing dependencies...");
        run_full_install(&app, &pm, &node_exe, &target, &lock_file).await?;
    }

    ensure_preview_dependencies_initialized(&app, &pm, &node_exe, &target, &lock_file).await?;
    save_to_cache(&app, &target, &cache_dir, &pkg_hash).await;

    // Remove lock file
    let _ = tokio::fs::remove_file(&lock_file).await;

    // Write preview marker so the app can distinguish build projects from imported ones
    let marker = target.join(".bytro-preview");
    let marker_content = format!(
        "{{\"type\":\"web-preview\",\"created_at\":\"{:?}\"}}",
        std::time::SystemTime::now()
    );
    let _ = tokio::fs::write(&marker, marker_content).await;

    let _ = app.emit("preview-init-log", "Project ready!");

    Ok(target.to_string_lossy().to_string())
}

/// Check whether a directory is a build-created web preview project
/// by looking for the `.bytro-preview` marker file.
#[tauri::command]
pub fn is_preview_project(project_path: String) -> bool {
    PathBuf::from(&project_path).join(".bytro-preview").exists()
}

/// Validate existing preview project
#[tauri::command]
pub async fn open_existing_preview_project(project_path: String) -> Result<bool, String> {
    let path = PathBuf::from(&project_path);

    // Validate path is absolute
    if !path.is_absolute() {
        return Err("Project path must be an absolute path".to_string());
    }

    // Check lock file
    if path.join(".bytro-init-lock").exists() {
        return Err("Project initialization was interrupted. Please re-initialize.".to_string());
    }

    // Check basic files
    let required_files = ["package.json", "vite.config.ts", "src/App.tsx"];
    for file in &required_files {
        if !path.join(file).exists() {
            return Err(format!("Missing required file: {}", file));
        }
    }

    // Check node_modules integrity
    let nm = path.join("node_modules");
    if !nm.exists() || !nm.join(".package-lock.json").exists() {
        return Err("node_modules is missing or incomplete. Run npm install first.".to_string());
    }

    Ok(true)
}

/// Detect project package manager
fn detect_package_manager(project_path: &Path) -> String {
    if project_path.join("pnpm-lock.yaml").exists() {
        "pnpm".to_string()
    } else if project_path.join("yarn.lock").exists() {
        "yarn".to_string()
    } else {
        "npm".to_string()
    }
}

fn extract_missing_rollup_package(output: &str) -> Option<String> {
    for marker in ["Cannot find module '", "Cannot find module \""] {
        if let Some(start) = output.find(marker) {
            let rest = &output[start + marker.len()..];
            let quote = if marker.ends_with('"') { '"' } else { '\'' };
            if let Some(end) = rest.find(quote) {
                let package = rest[..end].trim().to_string();
                if package.starts_with("@rollup/") {
                    return Some(package);
                }
            }
        }
    }

    None
}

async fn verify_preview_dependencies_with_output(
    node_exe: &str,
    project: &Path,
) -> Result<(), PreviewDependencyIssue> {
    let script = r#"
try {
  require.resolve('vite/package.json');
  require('rollup');
} catch (error) {
  const message = error && error.stack ? error.stack : String(error);
  console.error(message);
  process.exit(1);
}
"#;

    let output = Command::new(node_exe)
        .arg("-e")
        .arg(script)
        .current_dir(project)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| PreviewDependencyIssue {
            message: format!("Failed to verify preview dependencies: {}", e),
            missing_rollup_package: None,
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = [stderr.as_str(), stdout.as_str()]
        .iter()
        .copied()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let missing_rollup_package = extract_missing_rollup_package(&combined);
    let message = if let Some(pkg) = &missing_rollup_package {
        format!("Preview dependencies are incomplete: missing {}", pkg)
    } else if let Some(first_line) = combined.lines().find(|line| !line.trim().is_empty()) {
        format!(
            "Preview dependency verification failed: {}",
            first_line.trim()
        )
    } else {
        "Preview dependency verification failed for an unknown reason".to_string()
    };

    Err(PreviewDependencyIssue {
        message,
        missing_rollup_package,
    })
}

pub(crate) async fn verify_preview_dependencies(
    node_exe: &str,
    project: &Path,
) -> Result<(), PreviewDependencyIssue> {
    verify_preview_dependencies_with_output(node_exe, project).await
}

/// Run `<pm> install --ignore-scripts` with streamed output.
async fn run_install(
    app: &AppHandle,
    pm: &str,
    node_exe: &str,
    cwd: &Path,
) -> Result<std::process::ExitStatus, String> {
    #[cfg(not(windows))]
    let _ = node_exe;

    let mut cmd;

    #[cfg(windows)]
    {
        if let Some((_, cli_js)) = find_pm_cli(pm) {
            let _ = app.emit(
                "preview-init-log",
                &format!(
                    "Running: {} {} install --ignore-scripts",
                    node_exe,
                    cli_js.display()
                ),
            );
            cmd = Command::new(node_exe);
            cmd.arg(cli_js.to_string_lossy().as_ref())
                .args(["install", "--ignore-scripts"]);
        } else {
            let _ = app.emit(
                "preview-init-log",
                &format!("Running: cmd /C {} install --ignore-scripts", pm),
            );
            cmd = Command::new("cmd");
            cmd.args(["/C", pm, "install", "--ignore-scripts"]);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = app.emit(
            "preview-init-log",
            &format!("Running: {} install --ignore-scripts", pm),
        );
        cmd = Command::new(pm);
        cmd.args(["install", "--ignore-scripts"]);
    }

    cmd.current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {}: {}", pm, e))?;

    // Stream stdout
    let stdout_handle = child.stdout.take().map(|stdout| {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim_end_matches('\r').to_string();
                if !clean.is_empty() {
                    let _ = app_clone.emit("preview-init-log", &clean);
                }
            }
        })
    });

    // Stream stderr
    let stderr_handle = child.stderr.take().map(|stderr| {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim_end_matches('\r').to_string();
                if !clean.is_empty() {
                    let _ = app_clone.emit("preview-init-log", &format!("[stderr] {}", clean));
                }
            }
        })
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("{} install error: {}", pm, e))?;

    if let Some(h) = stdout_handle {
        let _ = h.await;
    }
    if let Some(h) = stderr_handle {
        let _ = h.await;
    }

    Ok(status)
}

async fn run_pm_command(
    app: &AppHandle,
    event_name: &str,
    pm: &str,
    node_exe: &str,
    cwd: &Path,
    args: &[String],
) -> Result<std::process::ExitStatus, String> {
    #[cfg(not(windows))]
    let _ = node_exe;

    let mut cmd;

    #[cfg(windows)]
    {
        if let Some((_, cli_js)) = find_pm_cli(pm) {
            let rendered_args = args.join(" ");
            let _ = app.emit(
                event_name,
                &format!(
                    "Running: {} {} {}",
                    node_exe,
                    cli_js.display(),
                    rendered_args
                ),
            );
            cmd = Command::new(node_exe);
            cmd.arg(cli_js.to_string_lossy().as_ref()).args(args);
        } else {
            let rendered_args = args.join(" ");
            let _ = app.emit(
                event_name,
                &format!("Running: cmd /C {} {}", pm, rendered_args),
            );
            cmd = Command::new("cmd");
            cmd.args(["/C", pm]).args(args);
        }
    }

    #[cfg(not(windows))]
    {
        let rendered_args = args.join(" ");
        let _ = app.emit(event_name, &format!("Running: {} {}", pm, rendered_args));
        cmd = Command::new(pm);
        cmd.args(args);
    }

    cmd.current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {} {}: {}", pm, args.join(" "), e))?;

    let stdout_handle = child.stdout.take().map(|stdout| {
        let app_clone = app.clone();
        let event_name = event_name.to_string();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim_end_matches('\r').to_string();
                if !clean.is_empty() {
                    let _ = app_clone.emit(&event_name, &clean);
                }
            }
        })
    });

    let stderr_handle = child.stderr.take().map(|stderr| {
        let app_clone = app.clone();
        let event_name = event_name.to_string();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim_end_matches('\r').to_string();
                if !clean.is_empty() {
                    let _ = app_clone.emit(&event_name, &format!("[stderr] {}", clean));
                }
            }
        })
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("{} {} error: {}", pm, args.join(" "), e))?;

    if let Some(h) = stdout_handle {
        let _ = h.await;
    }
    if let Some(h) = stderr_handle {
        let _ = h.await;
    }

    Ok(status)
}

/// Install npm packages into the preview project.
/// Accepts a list of package names (e.g. ["axios", "lodash@4"]).
/// Streams install output to vite-log events.
#[tauri::command]
pub async fn install_preview_packages(
    project_path: String,
    packages: Vec<String>,
    app: AppHandle,
) -> Result<(), String> {
    if packages.is_empty() {
        return Ok(());
    }

    let project = PathBuf::from(&project_path);
    if !project.is_absolute() || !project.join("package.json").exists() {
        return Err("Invalid project path".to_string());
    }

    crate::sidecar::cli_tools::extend_process_path_with_known_dirs();

    let pm = detect_package_manager(&project);
    let pkg_list = packages.join(" ");
    let _ = app.emit("vite-log", &format!("Installing: {} ...", pkg_list));

    let mut cmd;

    #[cfg(windows)]
    {
        let node_exe = find_pm_cli(&pm)
            .map(|(exe, _)| exe)
            .unwrap_or_else(|| "node".to_string());

        if let Some((_, cli_js)) = find_pm_cli(&pm) {
            cmd = Command::new(&node_exe);
            cmd.arg(cli_js.to_string_lossy().as_ref()).arg("install");
            for pkg in &packages {
                cmd.arg(pkg);
            }
        } else {
            cmd = Command::new("cmd");
            cmd.args(["/C", &pm, "install"]);
            for pkg in &packages {
                cmd.arg(pkg);
            }
        }
    }

    #[cfg(not(windows))]
    {
        cmd = Command::new(&pm);
        cmd.arg("install");
        for pkg in &packages {
            cmd.arg(pkg);
        }
    }

    cmd.current_dir(&project)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run {} install: {}", pm, e))?;

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim_end_matches('\r').to_string();
                if !clean.is_empty() {
                    let _ = app_clone.emit("vite-log", &clean);
                }
            }
        });
    }

    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let clean = line.trim_end_matches('\r').to_string();
                if !clean.is_empty() {
                    let _ = app_clone.emit("vite-error", &clean);
                }
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("{} install error: {}", pm, e))?;

    if status.success() {
        let _ = app.emit("vite-log", &format!("Installed: {}", pkg_list));
        Ok(())
    } else {
        Err(format!(
            "{} install failed with exit code {}",
            pm,
            status.code().unwrap_or(-1)
        ))
    }
}

/// Run the full npm install + esbuild postinstall sequence.
async fn run_full_install(
    app: &AppHandle,
    pm: &str,
    node_exe: &str,
    target: &Path,
    lock_file: &Path,
) -> Result<(), String> {
    let install_result = run_install(app, pm, node_exe, target).await?;
    if !install_result.success() {
        let _ = tokio::fs::remove_file(lock_file).await;
        return Err(format!(
            "{} install failed with exit code {}",
            pm,
            install_result.code().unwrap_or(-1)
        ));
    }

    run_esbuild_postinstall(app, node_exe, target, "preview-init-log").await?;
    Ok(())
}

async fn run_esbuild_postinstall(
    app: &AppHandle,
    node_exe: &str,
    target: &Path,
    event_name: &str,
) -> Result<(), String> {
    // Run critical postinstall scripts that download platform-specific binaries.
    let esbuild_install = target.join("node_modules/esbuild/install.js");
    if esbuild_install.exists() {
        let _ = app.emit(event_name, "Running esbuild postinstall...");
        let ps = Command::new(node_exe)
            .arg(esbuild_install.to_string_lossy().as_ref())
            .current_dir(target)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .map_err(|e| format!("esbuild postinstall failed: {}", e))?;
        if !ps.status.success() {
            let stderr = String::from_utf8_lossy(&ps.stderr);
            let _ = app.emit(event_name, &format!("[esbuild] {}", stderr));
        }
    }

    Ok(())
}

async fn clean_install_artifacts(project: &Path, pm: &str) {
    let _ = tokio::fs::remove_dir_all(project.join("node_modules")).await;

    let lock_file = match pm {
        "pnpm" => "pnpm-lock.yaml",
        "yarn" => "yarn.lock",
        _ => "package-lock.json",
    };
    let _ = tokio::fs::remove_file(project.join(lock_file)).await;
}

pub(crate) async fn repair_missing_optional_dependency(
    app: &AppHandle,
    project: &Path,
    pm: &str,
    node_exe: &str,
    missing_pkg: &str,
    event_name: &str,
) -> Result<(), String> {
    let args = match pm {
        "pnpm" => vec![
            "add".to_string(),
            "--save-dev".to_string(),
            missing_pkg.to_string(),
        ],
        "yarn" => vec![
            "add".to_string(),
            "--dev".to_string(),
            missing_pkg.to_string(),
        ],
        _ => vec![
            "install".to_string(),
            "--no-save".to_string(),
            missing_pkg.to_string(),
        ],
    };

    let _ = app.emit(
        event_name,
        &format!("Repairing missing optional dependency: {}", missing_pkg),
    );
    let status = run_pm_command(app, event_name, pm, node_exe, project, &args).await?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to repair missing optional dependency {} with {}",
            missing_pkg, pm
        ))
    }
}

async fn ensure_preview_dependencies_initialized(
    app: &AppHandle,
    pm: &str,
    node_exe: &str,
    target: &Path,
    lock_file: &Path,
) -> Result<(), String> {
    match verify_preview_dependencies(node_exe, target).await {
        Ok(()) => Ok(()),
        Err(issue) => {
            let _ = app.emit(
                "preview-init-log",
                &format!(
                    "Detected incomplete preview dependencies: {}",
                    issue.message
                ),
            );
            let _ = app.emit(
                "preview-init-log",
                "Clearing install artifacts and reinstalling dependencies...",
            );
            clean_install_artifacts(target, pm).await;
            run_full_install(app, pm, node_exe, target, lock_file).await?;

            match verify_preview_dependencies(node_exe, target).await {
                Ok(()) => Ok(()),
                Err(reinstall_issue) => {
                    if let Some(missing_pkg) = reinstall_issue.missing_rollup_package.clone() {
                        repair_missing_optional_dependency(
                            app,
                            target,
                            pm,
                            node_exe,
                            &missing_pkg,
                            "preview-init-log",
                        )
                        .await?;
                        verify_preview_dependencies(node_exe, target)
                            .await
                            .map_err(|final_issue| final_issue.message)
                    } else {
                        Err(reinstall_issue.message)
                    }
                }
            }
        }
    }
}

pub(crate) async fn ensure_preview_dependencies_before_start(
    app: &AppHandle,
    pm: &str,
    node_exe: &str,
    project: &Path,
) -> Result<(), String> {
    match verify_preview_dependencies(node_exe, project).await {
        Ok(()) => Ok(()),
        Err(issue) => {
            let _ = app.emit(
                "vite-log",
                &format!(
                    "Detected incomplete preview dependencies: {}",
                    issue.message
                ),
            );
            let Some(missing_pkg) = issue.missing_rollup_package else {
                return Err(issue.message);
            };

            repair_missing_optional_dependency(
                app,
                project,
                pm,
                node_exe,
                &missing_pkg,
                "vite-log",
            )
            .await?;
            verify_preview_dependencies(node_exe, project)
                .await
                .map_err(|final_issue| final_issue.message)
        }
    }
}

// ---------------------------------------------------------------------------
// node_modules cache helpers
// ---------------------------------------------------------------------------

/// Get the cache directory path: <app_data>/nm-cache
fn get_nm_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(data_dir.join("nm-cache"))
}

/// Compute a simple hash of the package.json `dependencies` + `devDependencies` fields.
/// Returns None if the file cannot be read.
async fn hash_package_json(pkg_path: &Path) -> Option<String> {
    let content = tokio::fs::read(pkg_path).await.ok()?;
    // Use a simple FNV-like hash of the full file content.
    // We don't need cryptographic strength — just cache invalidation.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in &content {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("{:016x}", hash))
}

/// Check whether the cache directory has a valid node_modules matching the given hash
/// AND was created with the current cache format version (symlink-safe).
async fn check_cache_valid(cache_dir: &Path, expected_hash: &str) -> bool {
    // Reject caches from older format versions (e.g. pre-symlink-fix)
    let version_file = cache_dir.join(CACHE_VERSION_FILE);
    match tokio::fs::read_to_string(&version_file).await {
        Ok(v) if v.trim() == CACHE_VERSION => {}
        _ => return false,
    }

    let hash_file = cache_dir.join(CACHE_HASH_FILE);
    if let Ok(stored) = tokio::fs::read_to_string(&hash_file).await {
        if stored.trim() == expected_hash {
            // Also verify node_modules dir actually exists
            return cache_dir.join("node_modules").exists();
        }
    }
    false
}

/// Save the current project's node_modules to the cache directory.
async fn save_to_cache(
    app: &AppHandle,
    project: &Path,
    cache_dir: &Path,
    pkg_hash: &Option<String>,
) {
    let Some(hash) = pkg_hash else { return };
    let source_nm = project.join("node_modules");
    if !source_nm.exists() {
        return;
    }

    let _ = app.emit(
        "preview-init-log",
        "Caching node_modules for future projects...",
    );

    // Remove old cache
    let cached_nm = cache_dir.join("node_modules");
    let _ = tokio::fs::remove_dir_all(&cached_nm).await;
    let _ = tokio::fs::create_dir_all(cache_dir).await;

    // Copy node_modules to cache (include everything, don't skip node_modules)
    if let Err(e) = copy_dir_all(&source_nm, &cached_nm).await {
        log::warn!("Failed to cache node_modules: {}", e);
        let _ = tokio::fs::remove_dir_all(&cached_nm).await;
        return;
    }

    // Write hash file + cache version marker
    let _ = tokio::fs::write(cache_dir.join(CACHE_HASH_FILE), hash).await;
    let _ = tokio::fs::write(cache_dir.join(CACHE_VERSION_FILE), CACHE_VERSION).await;
    let _ = app.emit("preview-init-log", "node_modules cached.");
}

/// Recursive directory copy — copies everything including node_modules.
/// Used for caching where we DO want to copy node_modules.
/// Preserves symbolic links (critical for node_modules/.bin on macOS/Linux).
async fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;

    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let file_type = entry.file_type().await?;

        if file_type.is_symlink() {
            copy_symlink(&src_path, &dst_path).await?;
        } else if file_type.is_dir() {
            Box::pin(copy_dir_all(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }

    Ok(())
}

/// Recursive directory copy — skips node_modules and .git.
/// Used for copying the template to the project directory.
/// Preserves symbolic links.
async fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;

    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Skip node_modules and .git
        if name == "node_modules" || name == ".git" {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&file_name);
        let file_type = entry.file_type().await?;

        if file_type.is_symlink() {
            copy_symlink(&src_path, &dst_path).await?;
        } else if file_type.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }

    Ok(())
}

/// Copy a symbolic link by reading its target and recreating it at the destination.
/// On Unix, creates a real symlink. On Windows, falls back to file copy since
/// npm uses .cmd shims instead of symlinks on Windows.
async fn copy_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    let target = tokio::fs::read_link(src).await?;

    #[cfg(unix)]
    {
        tokio::fs::symlink(&target, dst).await?;
    }

    #[cfg(windows)]
    {
        // Windows rarely uses symlinks in node_modules; fall back to file copy.
        // Check if the link target is a directory to use the right copy method.
        let resolved = if target.is_relative() {
            src.parent().unwrap_or(src).join(&target)
        } else {
            target
        };
        if resolved.is_dir() {
            Box::pin(copy_dir_all(&resolved, dst)).await?;
        } else {
            tokio::fs::copy(src, dst).await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extract_missing_rollup_package;

    #[test]
    fn extracts_rollup_package_from_single_quoted_error() {
        let output = "Error: Cannot find module '@rollup/rollup-darwin-arm64'";
        assert_eq!(
            extract_missing_rollup_package(output).as_deref(),
            Some("@rollup/rollup-darwin-arm64")
        );
    }

    #[test]
    fn extracts_rollup_package_from_double_quoted_error() {
        let output = "Error: Cannot find module \"@rollup/rollup-linux-x64-gnu\"";
        assert_eq!(
            extract_missing_rollup_package(output).as_deref(),
            Some("@rollup/rollup-linux-x64-gnu")
        );
    }

    #[test]
    fn ignores_non_rollup_missing_modules() {
        let output = "Error: Cannot find module 'react'";
        assert_eq!(extract_missing_rollup_package(output), None);
    }
}
