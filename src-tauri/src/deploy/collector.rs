use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_FILE_COUNT: usize = 500;
const MAX_FILE_SIZE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct FilePayload {
    pub path: String,
    pub content: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
}

/// Recursively collect all files from the dist directory, encoding content as base64.
pub fn collect_dist_files(dist_path: &str) -> Result<Vec<FilePayload>, String> {
    let dist = Path::new(dist_path);

    if !dist.exists() {
        return Err(format!(
            "dist directory not found: {}. Did the build succeed?",
            dist_path
        ));
    }

    if !dist.is_dir() {
        return Err(format!("{} is not a directory", dist_path));
    }

    let mut files = Vec::new();
    let mut total_bytes = 0;
    collect_recursive(dist, dist, &mut files, &mut total_bytes)?;

    if files.is_empty() {
        return Err(format!(
            "No files found in dist directory: {}. The build may have failed.",
            dist_path
        ));
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

/// Recursively walk a directory and collect file payloads.
fn collect_recursive(
    base: &Path,
    current: &Path,
    files: &mut Vec<FilePayload>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("Failed to read directory {}: {}", current.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {}", path.display(), e))?;

        if file_type.is_symlink() {
            return Err(format!(
                "Refusing to publish symbolic link from dist: {}",
                path.display()
            ));
        }

        if file_type.is_dir() {
            collect_recursive(base, &path, files, total_bytes)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(base)
                .map_err(|e| format!("Failed to compute relative path: {}", e))?;
            let relative = relative.to_str().ok_or_else(|| {
                format!(
                    "Preview contains a file name that is not valid UTF-8: {}",
                    path.display()
                )
            })?;
            #[cfg(not(windows))]
            if relative.contains('\\') {
                return Err(format!("Preview contains an unsafe file path: {relative}"));
            }
            let relative = relative
                // Windows path compatibility: normalize backslashes to forward slashes
                .replace('\\', "/");

            if should_skip_path(&relative) {
                continue;
            }
            if !is_valid_publish_path(&relative) {
                return Err(format!("Preview contains an unsafe file path: {relative}"));
            }
            if files.len() >= MAX_FILE_COUNT {
                return Err(format!(
                    "Too many publishable files in dist (maximum {}).",
                    MAX_FILE_COUNT
                ));
            }

            let metadata = entry
                .metadata()
                .map_err(|e| format!("Failed to inspect {}: {}", path.display(), e))?;
            if metadata.len() > MAX_FILE_SIZE_BYTES {
                return Err(format!(
                    "File exceeds the {} MiB preview limit: {}",
                    MAX_FILE_SIZE_BYTES / 1024 / 1024,
                    relative
                ));
            }
            if total_bytes.saturating_add(metadata.len()) > MAX_TOTAL_SIZE_BYTES {
                return Err(format!(
                    "Preview exceeds the {} MiB total size limit.",
                    MAX_TOTAL_SIZE_BYTES / 1024 / 1024
                ));
            }

            let raw_bytes = fs::read(&path)
                .map_err(|e| format!("Failed to read file {}: {}", path.display(), e))?;
            if raw_bytes.len() as u64 > MAX_FILE_SIZE_BYTES {
                return Err(format!(
                    "File exceeds the {} MiB preview limit: {}",
                    MAX_FILE_SIZE_BYTES / 1024 / 1024,
                    relative
                ));
            }
            *total_bytes = total_bytes.saturating_add(raw_bytes.len() as u64);
            if *total_bytes > MAX_TOTAL_SIZE_BYTES {
                return Err(format!(
                    "Preview exceeds the {} MiB total size limit.",
                    MAX_TOTAL_SIZE_BYTES / 1024 / 1024
                ));
            }

            let encoded = base64::engine::general_purpose::STANDARD.encode(&raw_bytes);

            let content_type = get_content_type(&path);

            files.push(FilePayload {
                path: relative,
                content: encoded,
                content_type,
            });
        }
    }

    Ok(())
}

fn should_skip_path(relative: &str) -> bool {
    let path = Path::new(relative);
    let has_hidden_segment = path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|segment| segment.starts_with('.'))
    });
    let is_source_map = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("map"));

    has_hidden_segment || is_source_map
}

fn is_valid_publish_path(relative: &str) -> bool {
    if relative.is_empty()
        || relative.encode_utf16().count() > 512
        || relative.starts_with('/')
        || relative.ends_with('/')
        || relative.contains("//")
        || relative.contains('%')
        || relative.contains('?')
        || relative.contains('#')
        || relative
            .chars()
            .any(|character| character.is_control() || character == '\\')
    {
        return false;
    }

    relative.split('/').all(|segment| {
        !segment.is_empty() && segment != "." && segment != ".." && !segment.starts_with('.')
    })
}

/// Determine the MIME content type based on file extension.
fn get_content_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "eot" => "application/vnd.ms-fontobject",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "aac" => "audio/aac",
        "pdf" => "application/pdf",
        "csv" => "text/csv",
        "webmanifest" => "application/manifest+json",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "map" => "application/json",
        "wasm" => "application/wasm",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::{is_valid_publish_path, should_skip_path};

    #[test]
    fn excludes_hidden_files_and_source_maps() {
        assert!(should_skip_path(".env"));
        assert!(should_skip_path("assets/.private/config.json"));
        assert!(should_skip_path("assets/app.js.map"));
    }

    #[test]
    fn keeps_normal_static_assets() {
        assert!(!should_skip_path("index.html"));
        assert!(!should_skip_path("assets/app.js"));
        assert!(!should_skip_path("assets/image.png"));
    }

    #[test]
    fn rejects_paths_that_cannot_round_trip_through_a_url() {
        assert!(!is_valid_publish_path("assets/app%2Fsecret.js"));
        assert!(!is_valid_publish_path("assets/query?.js"));
        assert!(!is_valid_publish_path("assets/hash#.js"));
        assert!(!is_valid_publish_path("assets\\app.js"));
        assert!(is_valid_publish_path("assets/hello world.js"));
    }
}
