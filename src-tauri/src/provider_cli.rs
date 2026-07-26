use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{OpenOptions, Permissions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CLAUDE_VERSION: &str = env!("CLAUDE_BINARY_VERSION");
const CODEX_VERSION: &str = env!("CODEX_BINARY_VERSION");
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_INSTALL_OUTPUT_BYTES: usize = 512 * 1024;
static INSTALL_LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderCli {
    Claude,
    Codex,
}

impl ProviderCli {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }

    pub(crate) fn env_var(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CLI_PATH",
            Self::Codex => "CODEX_CLI_PATH",
        }
    }

    pub(crate) fn version(self) -> &'static str {
        match self {
            Self::Claude => CLAUDE_VERSION,
            Self::Codex => CODEX_VERSION,
        }
    }

    fn directory_name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlatformPackage {
    platform: String,
    package_spec: String,
    package_relative_dir: PathBuf,
    executable_relative_path: PathBuf,
    package_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedProviderCli {
    pub(crate) path: PathBuf,
    pub(crate) version: Option<String>,
}

pub(crate) struct ProviderCliManager {
    claude_install: tokio::sync::Mutex<()>,
    codex_install: tokio::sync::Mutex<()>,
}

impl ProviderCliManager {
    pub(crate) fn new() -> Self {
        Self {
            claude_install: tokio::sync::Mutex::new(()),
            codex_install: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) async fn ensure(
        &self,
        app: &AppHandle,
        provider: ProviderCli,
        proxy_url: Option<&str>,
    ) -> Result<ResolvedProviderCli, String> {
        if let Some(resolved) = resolve_managed(provider)? {
            return Ok(resolved);
        }

        let _guard = match provider {
            ProviderCli::Claude => self.claude_install.lock().await,
            ProviderCli::Codex => self.codex_install.lock().await,
        };

        if let Some(resolved) = resolve_managed(provider)? {
            return Ok(resolved);
        }

        let runtime = crate::node_runtime::ensure_node_runtime_internal(app, proxy_url)
            .await
            .map_err(|error| {
                format!(
                    "{} CLI installation requires Node.js 20 or newer: {}",
                    provider.name(),
                    error
                )
            })?;
        let node_path = runtime.node_path.map(PathBuf::from).ok_or_else(|| {
            format!(
                "{} CLI installation requires a resolved Node.js executable",
                provider.name()
            )
        })?;
        let npm_path = runtime.npm_path.map(PathBuf::from).ok_or_else(|| {
            format!(
                "{} CLI installation requires a resolved npm executable",
                provider.name()
            )
        })?;
        let proxy = proxy_url.map(str::to_string);

        tokio::task::spawn_blocking(move || {
            install_provider(provider, &node_path, &npm_path, proxy.as_deref())
        })
        .await
        .map_err(|error| {
            format!(
                "{} CLI installation task failed: {}",
                provider.name(),
                error
            )
        })?
    }
}

impl Default for ProviderCliManager {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) async fn ensure_provider_cli(
    app: &AppHandle,
    provider: ProviderCli,
    proxy_url: Option<&str>,
) -> Result<String, String> {
    let manager = app.state::<ProviderCliManager>();
    let resolved = manager.ensure(app, provider, proxy_url).await?;
    Ok(resolved.path.to_string_lossy().to_string())
}

fn current_platform_package(provider: ProviderCli) -> Result<PlatformPackage, String> {
    platform_package(
        provider,
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(target_env = "musl") {
            "musl"
        } else {
            ""
        },
    )
}

fn platform_package(
    provider: ProviderCli,
    os: &str,
    arch: &str,
    target_env: &str,
) -> Result<PlatformPackage, String> {
    let normalized_arch = match arch {
        "aarch64" | "arm64" => "arm64",
        "x86_64" | "x64" => "x64",
        _ => return Err(format!("Unsupported provider CLI platform: {os}/{arch}")),
    };
    let platform = match os {
        "macos" | "darwin" => format!("darwin-{normalized_arch}"),
        "windows" | "win32" => format!("win32-{normalized_arch}"),
        "linux" => match provider {
            ProviderCli::Claude if target_env == "musl" => {
                format!("linux-{normalized_arch}-musl")
            }
            _ => format!("linux-{normalized_arch}"),
        },
        _ => return Err(format!("Unsupported provider CLI platform: {os}/{arch}")),
    };

    match provider {
        ProviderCli::Claude => {
            let version = provider.version();
            let package_name = format!("@anthropic-ai/claude-agent-sdk-{platform}");
            Ok(PlatformPackage {
                package_spec: format!("{package_name}@{version}"),
                package_relative_dir: PathBuf::from("node_modules")
                    .join("@anthropic-ai")
                    .join(format!("claude-agent-sdk-{platform}")),
                executable_relative_path: PathBuf::from(if os == "windows" || os == "win32" {
                    "claude.exe"
                } else {
                    "claude"
                }),
                package_version: version.to_string(),
                platform,
            })
        }
        ProviderCli::Codex => {
            let version = provider.version();
            let triple = match (os, normalized_arch) {
                ("macos" | "darwin", "arm64") => "aarch64-apple-darwin",
                ("macos" | "darwin", "x64") => "x86_64-apple-darwin",
                ("windows" | "win32", "arm64") => "aarch64-pc-windows-msvc",
                ("windows" | "win32", "x64") => "x86_64-pc-windows-msvc",
                ("linux", "arm64") => "aarch64-unknown-linux-musl",
                ("linux", "x64") => "x86_64-unknown-linux-musl",
                _ => return Err(format!("Unsupported provider CLI platform: {os}/{arch}")),
            };
            let executable = if os == "windows" || os == "win32" {
                "codex.exe"
            } else {
                "codex"
            };
            Ok(PlatformPackage {
                package_spec: format!("@openai/codex@{version}-{platform}"),
                package_relative_dir: PathBuf::from("node_modules").join("@openai").join("codex"),
                executable_relative_path: PathBuf::from("vendor")
                    .join(triple)
                    .join("bin")
                    .join(executable),
                package_version: format!("{version}-{platform}"),
                platform,
            })
        }
    }
}

fn cli_root() -> Result<PathBuf, String> {
    Ok(crate::bytro_home::home_dir()?.join("cli"))
}

fn provider_root(provider: ProviderCli) -> Result<PathBuf, String> {
    Ok(cli_root()?.join(provider.directory_name()))
}

fn version_root(provider: ProviderCli) -> Result<PathBuf, String> {
    Ok(provider_root(provider)?.join(provider.version()))
}

fn verified_executable(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    let metadata = std::fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

fn private_installed(provider: ProviderCli) -> Result<Option<ResolvedProviderCli>, String> {
    private_installed_at(&cli_root()?, provider)
}

fn private_installed_at(
    root: &Path,
    provider: ProviderCli,
) -> Result<Option<ResolvedProviderCli>, String> {
    let package = current_platform_package(provider)?;
    let version_dir = root
        .join(provider.directory_name())
        .join(provider.version());
    let expected = version_dir
        .join(&package.package_relative_dir)
        .join(&package.executable_relative_path);
    let Some(executable) = verified_executable(&expected) else {
        return Ok(None);
    };
    let canonical_root = std::fs::canonicalize(&version_dir).map_err(|error| {
        format!(
            "Failed to validate {} CLI installation root: {}",
            provider.name(),
            error
        )
    })?;
    if !executable.starts_with(&canonical_root) {
        return Err(format!(
            "Refusing {} CLI executable outside the private installation",
            provider.name()
        ));
    }
    Ok(Some(ResolvedProviderCli {
        path: executable,
        version: Some(provider.version().to_string()),
    }))
}

pub(crate) fn resolve_managed(
    provider: ProviderCli,
) -> Result<Option<ResolvedProviderCli>, String> {
    if let Ok(configured) = std::env::var(provider.env_var()) {
        if let Some(path) = verified_executable(Path::new(configured.trim())) {
            return Ok(Some(ResolvedProviderCli {
                path,
                version: None,
            }));
        }
    }

    if let Some(installed) = private_installed(provider)? {
        return Ok(Some(installed));
    }

    Ok(None)
}

fn install_provider(
    provider: ProviderCli,
    node_path: &Path,
    npm_path: &Path,
    proxy_url: Option<&str>,
) -> Result<ResolvedProviderCli, String> {
    let package = current_platform_package(provider)?;
    let provider_dir = provider_root(provider)?;
    crate::bytro_home::ensure_private_dir(&cli_root()?)?;
    crate::bytro_home::ensure_private_dir(&provider_dir)?;

    let final_dir = version_root(provider)?;
    let staging_dir = provider_dir.join(format!(
        ".install-{}-{}",
        provider.version(),
        uuid::Uuid::new_v4()
    ));
    crate::bytro_home::ensure_private_dir(&staging_dir)?;

    append_install_log(&format!(
        "provider={} version={} platform={} stage=start",
        provider.name(),
        provider.version(),
        package.platform
    ));

    let result = (|| {
        let mut command = npm_install_command(node_path, npm_path)?;
        command.args([
            "install",
            "--prefix",
            staging_dir.to_string_lossy().as_ref(),
            "--no-save",
            "--no-package-lock",
            "--no-audit",
            "--no-fund",
            "--ignore-scripts",
            package.package_spec.as_str(),
        ]);
        if let Some(proxy) = proxy_url.filter(|value| {
            let value = value.trim().to_ascii_lowercase();
            value.starts_with("http://") || value.starts_with("https://")
        }) {
            command
                .env("HTTP_PROXY", proxy)
                .env("HTTPS_PROXY", proxy)
                .env("http_proxy", proxy)
                .env("https_proxy", proxy);
        }

        let output = run_command_with_timeout(command, INSTALL_TIMEOUT)?;
        append_install_log(&format!(
            "provider={} version={} platform={} stage=npm {}",
            provider.name(),
            provider.version(),
            package.platform,
            summarize_output(&output)
        ));
        if !output.status.success() {
            return Err(format!(
                "{} CLI installation failed during npm install",
                provider.name()
            ));
        }

        verify_package_version(&staging_dir, &package, provider)?;
        let executable = staging_dir
            .join(&package.package_relative_dir)
            .join(&package.executable_relative_path);
        let executable = verified_executable(&executable).ok_or_else(|| {
            format!(
                "{} CLI installation completed but the executable was not found",
                provider.name()
            )
        })?;
        let canonical_staging = std::fs::canonicalize(&staging_dir)
            .map_err(|error| format!("Failed to validate staging directory: {error}"))?;
        if !executable.starts_with(&canonical_staging) {
            return Err(format!(
                "Refusing {} CLI executable outside the staging directory",
                provider.name()
            ));
        }

        let version_output = crate::sidecar::cli_tools::run_verified_version_probe(
            &executable,
            Duration::from_secs(10),
        )?;
        if !version_output.status.success() {
            return Err(format!(
                "{} CLI installation failed executable verification",
                provider.name()
            ));
        }

        if final_dir.exists() {
            remove_private_install_dir(&provider_dir, &final_dir)?;
        }
        std::fs::rename(&staging_dir, &final_dir).map_err(|error| {
            format!(
                "Failed to activate {} CLI installation: {}",
                provider.name(),
                error
            )
        })?;
        private_installed(provider)?.ok_or_else(|| {
            format!(
                "{} CLI installation could not be resolved after activation",
                provider.name()
            )
        })
    })();

    if staging_dir.exists() {
        let _ = remove_private_install_dir(&provider_dir, &staging_dir);
    }
    append_install_log(&format!(
        "provider={} version={} platform={} stage=finish success={}",
        provider.name(),
        provider.version(),
        package.platform,
        result.is_ok()
    ));
    result
}

fn npm_install_command(node_path: &Path, npm_path: &Path) -> Result<Command, String> {
    if !node_path.is_absolute() || !npm_path.is_absolute() {
        return Err(
            "Provider CLI installation requires absolute Node.js and npm paths".to_string(),
        );
    }

    #[cfg(windows)]
    {
        let npm_cli = npm_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");
        if npm_cli.is_file() {
            let mut command = Command::new(node_path);
            command.arg(npm_cli);
            return Ok(command);
        }
    }

    Ok(Command::new(npm_path))
}

fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start npm install: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "npm stdout was unavailable".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "npm stderr was unavailable".to_string())?;
    let stdout_reader = std::thread::spawn(move || drain_bounded(&mut stdout));
    let stderr_reader = std::thread::spawn(move || drain_bounded(&mut stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("Provider CLI npm install timed out".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("Provider CLI npm install wait failed: {error}"));
            }
        }
    };
    Ok(Output {
        status,
        stdout: stdout_reader.join().unwrap_or_default(),
        stderr: stderr_reader.join().unwrap_or_default(),
    })
}

fn drain_bounded(reader: &mut impl Read) -> Vec<u8> {
    let mut captured = Vec::new();
    let mut chunk = [0_u8; 8192];
    while let Ok(count) = reader.read(&mut chunk) {
        if count == 0 {
            break;
        }
        let remaining = MAX_INSTALL_OUTPUT_BYTES.saturating_sub(captured.len());
        if remaining > 0 {
            captured.extend_from_slice(&chunk[..count.min(remaining)]);
        }
    }
    captured
}

#[derive(Deserialize)]
struct InstalledPackage {
    version: String,
}

fn verify_package_version(
    staging_dir: &Path,
    package: &PlatformPackage,
    provider: ProviderCli,
) -> Result<(), String> {
    let package_json = staging_dir
        .join(&package.package_relative_dir)
        .join("package.json");
    let content = std::fs::read_to_string(&package_json).map_err(|error| {
        format!(
            "{} CLI installation package metadata is unavailable: {}",
            provider.name(),
            error
        )
    })?;
    let installed: InstalledPackage = serde_json::from_str(&content).map_err(|error| {
        format!(
            "{} CLI installation package metadata is invalid: {}",
            provider.name(),
            error
        )
    })?;
    if installed.version != package.package_version {
        return Err(format!(
            "{} CLI installation version mismatch",
            provider.name()
        ));
    }
    Ok(())
}

fn remove_private_install_dir(parent: &Path, target: &Path) -> Result<(), String> {
    if target.parent() != Some(parent) {
        return Err("Refusing to remove a Provider CLI path outside its managed root".to_string());
    }
    let metadata = std::fs::symlink_metadata(target)
        .map_err(|error| format!("Failed to inspect Provider CLI directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Refusing to remove a non-directory Provider CLI path".to_string());
    }
    std::fs::remove_dir_all(target)
        .map_err(|error| format!("Failed to remove Provider CLI directory: {error}"))
}

fn summarize_output(output: &Output) -> String {
    let status = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let stdout_hash = Sha256::digest(&output.stdout);
    let stderr_hash = Sha256::digest(&output.stderr);
    format!(
        "exit={} stdout_len={} stdout_sha256={:x} stderr_len={} stderr_sha256={:x}",
        status,
        output.stdout.len(),
        stdout_hash,
        output.stderr.len(),
        stderr_hash
    )
}

fn append_install_log(message: &str) {
    let _guard = INSTALL_LOG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Ok(log_dir) = crate::bytro_home::home_dir().map(|root| root.join("logs")) else {
        return;
    };
    if crate::bytro_home::ensure_private_dir(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("provider-cli-install.log");
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return;
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let Ok(mut file) = options.open(&path) else {
        return;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(Permissions::from_mode(0o600));
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{timestamp}] {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_supported_provider_packages() {
        let claude =
            platform_package(ProviderCli::Claude, "macos", "aarch64", "").expect("claude package");
        assert_eq!(
            claude.package_spec,
            format!(
                "@anthropic-ai/claude-agent-sdk-darwin-arm64@{}",
                CLAUDE_VERSION
            )
        );
        assert_eq!(claude.executable_relative_path, PathBuf::from("claude"));

        let claude_musl = platform_package(ProviderCli::Claude, "linux", "x86_64", "musl")
            .expect("claude musl package");
        assert!(claude_musl.package_spec.contains("linux-x64-musl"));

        let codex =
            platform_package(ProviderCli::Codex, "windows", "x86_64", "").expect("codex package");
        assert_eq!(
            codex.package_spec,
            format!("@openai/codex@{}-win32-x64", CODEX_VERSION)
        );
        assert_eq!(
            codex.executable_relative_path,
            PathBuf::from("vendor")
                .join("x86_64-pc-windows-msvc")
                .join("bin")
                .join("codex.exe")
        );
    }

    #[test]
    fn rejects_unknown_architectures() {
        let error = platform_package(ProviderCli::Codex, "linux", "riscv64", "")
            .expect_err("unsupported platform");
        assert!(error.contains("linux/riscv64"));
    }

    #[test]
    fn install_output_capture_is_bounded_while_draining_the_reader() {
        let input = vec![b'x'; MAX_INSTALL_OUTPUT_BYTES + 17_000];
        let mut cursor = std::io::Cursor::new(input);
        let captured = drain_bounded(&mut cursor);

        assert_eq!(captured.len(), MAX_INSTALL_OUTPUT_BYTES);
        assert_eq!(
            cursor.position(),
            (MAX_INSTALL_OUTPUT_BYTES + 17_000) as u64
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_only_executables_inside_private_install_root() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("bytro-provider-cli-test-{}", uuid::Uuid::new_v4()));
        let package = current_platform_package(ProviderCli::Claude).expect("platform package");
        let executable = root
            .join("claude")
            .join(CLAUDE_VERSION)
            .join(&package.package_relative_dir)
            .join(&package.executable_relative_path);
        std::fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("create package");
        std::fs::write(&executable, b"#!/bin/sh\nexit 0\n").expect("write executable");
        std::fs::set_permissions(&executable, Permissions::from_mode(0o700))
            .expect("make executable");

        let resolved = private_installed_at(&root, ProviderCli::Claude)
            .expect("resolve")
            .expect("installed");
        assert_eq!(
            resolved.path,
            std::fs::canonicalize(&executable).expect("canonical executable")
        );
        assert_eq!(resolved.version.as_deref(), Some(CLAUDE_VERSION));

        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
