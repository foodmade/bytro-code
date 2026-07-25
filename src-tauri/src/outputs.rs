//! AI-generated artifact directory management.
//!
//! Provides a single, app-managed directory where every AI-generated artifact
//! (images from the OpenAI gpt-image MCP, user-exported assets, files written via
//! Write/Bash by the agent, …) is expected to land. Decoupling this from the
//! user's workspace path stops generated content from leaking into source
//! repos and gives packaged builds a deterministic location to scope the asset
//! protocol against.
//!
//! Resolution rules:
//!   - A custom directory is trusted only after the native Rust folder picker
//!     selected, validated, and persisted its canonical path.
//!   - Frontend-provided paths must exactly match either that Rust-owned record
//!     or the default `<app_data_dir>/outputs` directory.
//!   - Filesystem roots, the user's home directory, non-directories, and paths
//!     containing symlink components are never granted asset-protocol access.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const OUTPUTS_SELECTION_FILE: &str = "outputs-directory.json";
const MAX_SELECTION_FILE_BYTES: u64 = 16 * 1024;

#[derive(Debug, Deserialize, Serialize)]
struct OutputsSelection {
    path: PathBuf,
}

/// Compute the default outputs directory: `<app_data_dir>/outputs`.
pub fn default_outputs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    Ok(base.join("outputs"))
}

/// Recursively create `path`. No-op if it already exists.
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|e| format!("Unable to create outputs directory ({:?})", e.kind()))
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|_| "Home directory is unavailable".to_string())
}

fn selection_file(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data directory is unavailable".to_string())?;
    ensure_dir(&app_data)?;
    Ok(app_data.join(OUTPUTS_SELECTION_FILE))
}

fn validate_existing_directory(path: &Path, home: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Outputs directory must be absolute".to_string());
    }

    for component in path.ancestors() {
        let metadata = std::fs::symlink_metadata(component)
            .map_err(|_| "Outputs directory is unavailable".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Symlinked outputs directories are not allowed".to_string());
        }
    }

    let metadata =
        std::fs::metadata(path).map_err(|_| "Outputs directory is unavailable".to_string())?;
    if !metadata.is_dir() {
        return Err("Outputs path must be a directory".to_string());
    }

    let canonical =
        std::fs::canonicalize(path).map_err(|_| "Outputs directory is unavailable".to_string())?;
    if canonical.parent().is_none() {
        return Err("Filesystem root cannot be used as the outputs directory".to_string());
    }

    let canonical_home =
        std::fs::canonicalize(home).map_err(|_| "Home directory is unavailable".to_string())?;
    if canonical == canonical_home {
        return Err("Home directory cannot be used as the outputs directory".to_string());
    }

    Ok(canonical)
}

fn read_selected_directory(record_path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match std::fs::symlink_metadata(record_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Outputs directory authorization is unavailable".to_string()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_SELECTION_FILE_BYTES
    {
        return Err("Outputs directory authorization is invalid".to_string());
    }

    let file = std::fs::File::open(record_path)
        .map_err(|_| "Outputs directory authorization is unavailable".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_SELECTION_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Outputs directory authorization is unavailable".to_string())?;
    if bytes.len() as u64 > MAX_SELECTION_FILE_BYTES {
        return Err("Outputs directory authorization is invalid".to_string());
    }
    let selection: OutputsSelection = serde_json::from_slice(&bytes)
        .map_err(|_| "Outputs directory authorization is invalid".to_string())?;
    Ok(Some(selection.path))
}

fn persist_selected_directory(record_path: &Path, canonical: &Path) -> Result<(), String> {
    let parent = record_path
        .parent()
        .ok_or_else(|| "Outputs directory authorization is unavailable".to_string())?;
    ensure_dir(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Outputs directory authorization could not be saved".to_string())?;
    serde_json::to_writer(
        &mut temporary,
        &OutputsSelection {
            path: canonical.to_path_buf(),
        },
    )
    .map_err(|_| "Outputs directory authorization could not be saved".to_string())?;
    temporary
        .flush()
        .map_err(|_| "Outputs directory authorization could not be saved".to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Outputs directory authorization could not be saved".to_string())?;
    temporary
        .persist(record_path)
        .map_err(|_| "Outputs directory authorization could not be saved".to_string())?;
    Ok(())
}

fn resolve_allowed_directory(
    default_dir: &Path,
    selected_dir: Option<&Path>,
    override_path: Option<&str>,
    home: &Path,
) -> Result<PathBuf, String> {
    let canonical_default = validate_existing_directory(default_dir, home)?;
    let requested = match override_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => validate_existing_directory(Path::new(path), home)?,
        None => return Ok(canonical_default),
    };
    if requested == canonical_default {
        return Ok(requested);
    }

    let selected = selected_dir
        .ok_or_else(|| "Outputs directory was not approved by the native picker".to_string())?;
    let canonical_selected = validate_existing_directory(selected, home)?;
    if requested != canonical_selected {
        return Err("Outputs directory was not approved by the native picker".to_string());
    }
    Ok(requested)
}

/// Resolve the effective outputs directory for a request.
///
/// The frontend value is untrusted. Empty values use the default; non-empty
/// values must exactly match the canonical path persisted by the native picker.
pub fn resolve_effective(app: &AppHandle, override_path: Option<&str>) -> Result<PathBuf, String> {
    let default = default_outputs_dir(app)?;
    ensure_dir(&default)?;
    let selected = read_selected_directory(&selection_file(app)?)?;
    resolve_allowed_directory(
        &default,
        selected.as_deref(),
        override_path,
        &home_dir(app)?,
    )
}

/// Grant the asset protocol read access to a directory at runtime so the
/// frontend can render images from it via `convertFileSrc`. Idempotent.
pub fn allow_asset_access(app: &AppHandle, path: &Path) {
    if let Some(window) = app.webview_windows().values().next() {
        let scope = window.asset_protocol_scope();
        if scope.allow_directory(path, true).is_err() {
            log::warn!("outputs: asset scope allow_directory failed");
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns the platform-default outputs directory, creating it if needed.
#[tauri::command]
pub fn get_default_outputs_dir(app: AppHandle) -> Result<String, String> {
    let dir = resolve_effective(&app, None)?;
    allow_asset_access(&app, &dir);
    Ok(dir.to_string_lossy().to_string())
}

/// Registers an already approved directory with the asset protocol scope.
/// This command never authorizes or creates an arbitrary frontend path.
#[tauri::command]
pub fn ensure_outputs_dir(app: AppHandle, path: String) -> Result<String, String> {
    let resolved = resolve_effective(&app, Some(&path))?;
    allow_asset_access(&app, &resolved);
    Ok(resolved.to_string_lossy().to_string())
}

/// Opens a native folder picker. Returns `None` if the user cancels.
#[tauri::command]
pub async fn pick_outputs_dir(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    app.dialog().file().pick_folder(move |result| {
        let chosen = result.and_then(|p| p.into_path().ok());
        let _ = tx.send(chosen);
    });
    let picked = rx
        .await
        .map_err(|e| format!("dialog channel closed: {e}"))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let canonical = validate_existing_directory(&path, &home_dir(&app)?)?;
    persist_selected_directory(&selection_file(&app)?, &canonical)?;
    allow_asset_access(&app, &canonical);
    Ok(Some(canonical.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_directories() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(temp.path()).expect("canonical tempdir");
        let home = root.join("home");
        let default = root.join("app-data").join("outputs");
        let custom = root.join("custom");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&default).expect("default");
        std::fs::create_dir_all(&custom).expect("custom");
        (temp, home, default, custom)
    }

    #[test]
    fn rejects_unapproved_arbitrary_directory() {
        let (_temp, home, default, custom) = setup_directories();
        let requested = custom.to_string_lossy();

        let error = resolve_allowed_directory(&default, None, Some(&requested), &home)
            .expect_err("unapproved path must fail");

        assert!(error.contains("not approved"));
    }

    #[test]
    fn accepts_only_exact_native_picker_record() {
        let (_temp, home, default, custom) = setup_directories();
        let requested = custom.to_string_lossy();

        let resolved = resolve_allowed_directory(&default, Some(&custom), Some(&requested), &home)
            .expect("approved path");

        assert_eq!(resolved, std::fs::canonicalize(custom).unwrap());
    }

    #[test]
    fn rejects_home_root_and_non_directory_paths() {
        let (_temp, home, default, _custom) = setup_directories();
        let file = default
            .parent()
            .expect("default parent")
            .join("not-a-directory");
        std::fs::write(&file, b"x").expect("file");
        let canonical_default = std::fs::canonicalize(&default).unwrap();
        let filesystem_root = canonical_default
            .ancestors()
            .last()
            .expect("filesystem root");

        assert!(validate_existing_directory(&home, &home)
            .expect_err("home must fail")
            .contains("Home directory"));
        assert!(validate_existing_directory(filesystem_root, &home)
            .expect_err("root must fail")
            .contains("root"));
        assert!(validate_existing_directory(&file, &home)
            .expect_err("file must fail")
            .contains("directory"));
        assert!(resolve_allowed_directory(&default, None, None, &home).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_leaf_and_parent_components() {
        use std::os::unix::fs::symlink;

        let (temp, home, _default, custom) = setup_directories();
        let leaf_link = temp.path().join("custom-link");
        symlink(&custom, &leaf_link).expect("leaf symlink");
        assert!(validate_existing_directory(&leaf_link, &home)
            .expect_err("leaf symlink must fail")
            .contains("Symlinked"));

        let real_parent = temp.path().join("real-parent");
        let linked_parent = temp.path().join("linked-parent");
        let nested = real_parent.join("nested");
        std::fs::create_dir_all(&nested).expect("nested");
        symlink(&real_parent, &linked_parent).expect("parent symlink");
        assert!(
            validate_existing_directory(&linked_parent.join("nested"), &home)
                .expect_err("parent symlink must fail")
                .contains("Symlinked")
        );
    }

    #[test]
    fn persists_and_reads_the_exact_canonical_selection() {
        let (temp, _home, _default, custom) = setup_directories();
        let record = temp.path().join(OUTPUTS_SELECTION_FILE);
        let canonical = std::fs::canonicalize(custom).unwrap();

        persist_selected_directory(&record, &canonical).expect("persist");
        assert_eq!(
            read_selected_directory(&record).expect("read"),
            Some(canonical)
        );
    }
}
