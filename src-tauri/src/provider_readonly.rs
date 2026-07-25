//! Bounded, no-follow reads from provider-owned filesystem trees.
//!
//! These helpers never create, modify, or delete provider paths. Callers must
//! supply a trusted root and every requested directory/file must remain inside
//! that root without traversing symlinks, junctions, reparse points, FIFOs, or
//! other special files.

use std::io::Read;
use std::path::{Component, Path};

pub const MAX_PROVIDER_TEXT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    index: u64,
    links: u64,
}

impl FileIdentity {
    fn same_object(self, other: Self) -> bool {
        self.volume == other.volume && self.index == other.index
    }
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_windows_reparse_point(metadata)
}

#[cfg(unix)]
fn metadata_identity(metadata: &std::fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;

    FileIdentity {
        volume: metadata.dev(),
        index: metadata.ino(),
        links: metadata.nlink(),
    }
}

#[cfg(unix)]
fn file_identity(file: &std::fs::File) -> Result<FileIdentity, String> {
    Ok(metadata_identity(&file.metadata().map_err(|e| {
        format!("Failed to inspect opened provider handle: {}", e)
    })?))
}

#[cfg(windows)]
fn file_identity(file: &std::fs::File) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, info.as_mut_ptr()) };
    if result == 0 {
        return Err(format!(
            "Failed to identify opened provider handle: {}",
            std::io::Error::last_os_error()
        ));
    }
    let info = unsafe { info.assume_init() };
    Ok(FileIdentity {
        volume: info.dwVolumeSerialNumber as u64,
        index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        links: info.nNumberOfLinks as u64,
    })
}

fn open_directory_handle(path: &Path) -> Result<std::fs::File, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect provider directory: {}", e))?;
    if is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Provider path traverses a non-directory or link".to_string());
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Failed to safely open provider directory: {}", e))?;
    let opened_metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened provider directory: {}", e))?;
    if is_link_or_reparse(&opened_metadata) || !opened_metadata.is_dir() {
        return Err("Opened provider directory is a link or non-directory".to_string());
    }
    #[cfg(unix)]
    if !metadata_identity(&metadata).same_object(file_identity(&file)?) {
        return Err("Provider directory changed while opening".to_string());
    }
    Ok(file)
}

struct DirectoryGuard {
    directories: Vec<(std::path::PathBuf, FileIdentity, std::fs::File)>,
}

impl DirectoryGuard {
    fn open(root: &Path, directory: &Path) -> Result<Self, String> {
        let relative = directory
            .strip_prefix(root)
            .map_err(|_| "Read-only path is outside its provider root".to_string())?;
        let mut component_paths = vec![root.to_path_buf()];
        let mut current = root.to_path_buf();
        for component in relative.components() {
            let Component::Normal(segment) = component else {
                return Err("Provider path contains an unsafe component".to_string());
            };
            current.push(segment);
            component_paths.push(current.clone());
        }

        let mut directories = Vec::with_capacity(component_paths.len());
        for path in component_paths {
            let file = open_directory_handle(&path)?;
            let identity = file_identity(&file)?;
            directories.push((path, identity, file));
        }
        let guard = Self { directories };
        guard.revalidate()?;
        Ok(guard)
    }

    fn revalidate(&self) -> Result<(), String> {
        for (path, identity, _held_handle) in &self.directories {
            let probe = open_directory_handle(path)?;
            if !file_identity(&probe)?.same_object(*identity) {
                return Err("Provider directory identity changed during read".to_string());
            }
        }
        Ok(())
    }
}

pub fn is_safe_component(value: &str) -> bool {
    if value.is_empty() || value.len() > 160 || value.starts_with('.') {
        return false;
    }
    let mut components = Path::new(value).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return false;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

pub fn validate_real_directory_tree(root: &Path, directory: &Path) -> Result<(), String> {
    DirectoryGuard::open(root, directory)?.revalidate()
}

pub fn is_real_directory(root: &Path, directory: &Path) -> bool {
    validate_real_directory_tree(root, directory).is_ok()
}

pub fn read_directory_bounded(
    root: &Path,
    directory: &Path,
    max_entries: usize,
) -> Result<Vec<std::fs::DirEntry>, String> {
    read_directory_bounded_with_hook(root, directory, max_entries, || {})
}

fn read_directory_bounded_with_hook(
    root: &Path,
    directory: &Path,
    max_entries: usize,
    after_read: impl FnOnce(),
) -> Result<Vec<std::fs::DirEntry>, String> {
    let guard = DirectoryGuard::open(root, directory)?;
    let mut entries = Vec::new();
    let reader = std::fs::read_dir(directory)
        .map_err(|e| format!("Failed to read provider directory: {}", e))?;
    for entry in reader {
        if entries.len() >= max_entries {
            break;
        }
        entries.push(entry.map_err(|e| format!("Failed to inspect provider entry: {}", e))?);
    }
    after_read();
    guard.revalidate()?;
    Ok(entries)
}

fn open_bounded_regular_file(
    root: &Path,
    path: &Path,
    max_bytes: u64,
) -> Result<std::fs::File, String> {
    open_bounded_regular_file_with_hook(root, path, max_bytes, || {})
}

fn open_bounded_regular_file_with_hook(
    root: &Path,
    path: &Path,
    max_bytes: u64,
    after_open: impl FnOnce(),
) -> Result<std::fs::File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Provider file has no parent directory".to_string())?;
    let guard = DirectoryGuard::open(root, parent)?;
    if !path.starts_with(root) {
        return Err("Provider file is outside its provider root".to_string());
    }

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect provider file: {}", e))?;
    #[cfg(unix)]
    let pre_identity = metadata_identity(&metadata);
    if is_link_or_reparse(&metadata) || !metadata.is_file() || metadata.len() > max_bytes || {
        #[cfg(unix)]
        {
            pre_identity.links != 1
        }
        #[cfg(windows)]
        {
            false
        }
    } {
        return Err("Provider file is not a bounded regular file".to_string());
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Failed to safely open provider file: {}", e))?;
    let opened_metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened provider file: {}", e))?;
    if is_link_or_reparse(&opened_metadata)
        || !opened_metadata.is_file()
        || opened_metadata.len() > max_bytes
    {
        return Err("Opened provider file is not a bounded regular file".to_string());
    }
    let opened_identity = file_identity(&file)?;
    if opened_identity.links != 1 {
        return Err("Provider file has multiple hard links".to_string());
    }
    #[cfg(unix)]
    if pre_identity != opened_identity {
        return Err("Provider file changed while opening".to_string());
    }

    after_open();
    guard.revalidate()?;
    let reopened_metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to re-inspect provider file: {}", e))?;
    #[cfg(unix)]
    let reopened_identity = metadata_identity(&reopened_metadata);
    if is_link_or_reparse(&reopened_metadata)
        || !reopened_metadata.is_file()
        || reopened_metadata.len() > max_bytes
        || {
            #[cfg(unix)]
            {
                reopened_identity.links != 1 || reopened_identity != opened_identity
            }
            #[cfg(windows)]
            {
                false
            }
        }
    {
        return Err("Provider file changed to a link or special file".to_string());
    }

    let mut probe_options = std::fs::OpenOptions::new();
    probe_options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        probe_options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        probe_options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let probe = probe_options
        .open(path)
        .map_err(|e| format!("Failed to re-open provider file: {}", e))?;
    let probe_metadata = probe
        .metadata()
        .map_err(|e| format!("Failed to inspect re-opened provider file: {}", e))?;
    let probe_identity = file_identity(&probe)?;
    if is_link_or_reparse(&probe_metadata)
        || !probe_metadata.is_file()
        || probe_metadata.len() > max_bytes
        || probe_identity.links != 1
        || probe_identity != opened_identity
    {
        return Err("Provider file identity changed during read".to_string());
    }
    guard.revalidate()?;
    Ok(file)
}

pub fn read_bounded_bytes(root: &Path, path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let file = open_bounded_regular_file(root, path, max_bytes)?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read provider file: {}", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err("Provider file exceeds the read budget".to_string());
    }
    Ok(bytes)
}

pub fn is_bounded_regular_file(root: &Path, path: &Path, max_bytes: u64) -> bool {
    open_bounded_regular_file(root, path, max_bytes).is_ok()
}

pub fn read_bounded_text(root: &Path, path: &Path, max_bytes: u64) -> Result<String, String> {
    let bytes = read_bounded_bytes(root, path, max_bytes)?;
    String::from_utf8(bytes).map_err(|_| "Provider file is not valid UTF-8".to_string())
}

pub fn read_provider_text(root: &Path, path: &Path) -> Result<String, String> {
    read_bounded_text(root, path, MAX_PROVIDER_TEXT_BYTES)
}

pub fn read_bounded_lines(
    root: &Path,
    path: &Path,
    max_file_bytes: u64,
    max_line_bytes: usize,
    max_lines: usize,
) -> Result<Vec<String>, String> {
    use std::io::BufRead;

    let file = open_bounded_regular_file(root, path, max_file_bytes)?;
    let mut reader = std::io::BufReader::new(file);
    let mut lines = Vec::new();
    let mut total_bytes = 0_u64;

    loop {
        if lines.len() >= max_lines {
            let mut extra = [0_u8; 1];
            if reader
                .read(&mut extra)
                .map_err(|e| format!("Failed to enforce provider line budget: {}", e))?
                > 0
            {
                return Err("Provider file exceeds the line-count budget".to_string());
            }
            break;
        }

        let mut bytes = Vec::new();
        let read = reader
            .by_ref()
            .take(max_line_bytes as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| format!("Failed to read provider line: {}", e))?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read as u64);
        if read > max_line_bytes || total_bytes > max_file_bytes {
            return Err("Provider file exceeds the line or file budget".to_string());
        }
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        lines.push(
            String::from_utf8(bytes)
                .map_err(|_| "Provider file contains a non-UTF-8 line".to_string())?,
        );
    }

    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_small_regular_file_without_mutating_provider_tree() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        std::fs::create_dir(&root).expect("provider root");
        let file = root.join("config.json");
        std::fs::write(&file, "safe config").expect("provider file");
        let before = std::fs::read(&file).expect("snapshot");

        assert_eq!(
            read_provider_text(&root, &file).expect("read provider file"),
            "safe config"
        );
        assert_eq!(std::fs::read(&file).expect("provider file after"), before);
    }

    #[test]
    fn rejects_oversized_and_directory_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        std::fs::create_dir(&root).expect("provider root");
        let oversized = root.join("oversized");
        let file = std::fs::File::create(&oversized).expect("oversized file");
        file.set_len(MAX_PROVIDER_TEXT_BYTES + 1)
            .expect("extend oversized file");
        assert!(read_provider_text(&root, &oversized).is_err());
        assert!(read_provider_text(&root, &root).is_err());
    }

    #[test]
    fn bounded_lines_enforces_line_and_entry_budgets() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        std::fs::create_dir(&root).expect("provider root");
        let file = root.join("events.jsonl");
        std::fs::write(&file, "one\ntwo\nthree\n").expect("events");

        assert_eq!(
            read_bounded_lines(&root, &file, 64, 8, 3).expect("bounded lines"),
            vec!["one", "two", "three"]
        );
        assert!(read_bounded_lines(&root, &file, 64, 8, 2).is_err());
        assert!(read_bounded_lines(&root, &file, 64, 2, 3).is_err());
    }

    #[test]
    fn rejects_unsafe_path_components() {
        assert!(is_safe_component("team-123"));
        assert!(is_safe_component("session_123.jsonl"));
        assert!(!is_safe_component("../secret"));
        assert!(!is_safe_component("nested/name"));
        assert!(!is_safe_component(".hidden"));
        assert!(!is_safe_component("team name"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_root_intermediate_leaf_links_and_fifo() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).expect("provider root");
        std::fs::create_dir(&outside).expect("outside root");
        let secret = outside.join("secret");
        std::fs::write(&secret, "secret").expect("secret");

        let linked_leaf = root.join("linked");
        symlink(&secret, &linked_leaf).expect("leaf link");
        assert!(read_provider_text(&root, &linked_leaf).is_err());

        let linked_dir = root.join("linked-dir");
        symlink(&outside, &linked_dir).expect("intermediate link");
        assert!(read_provider_text(&root, &linked_dir.join("secret")).is_err());

        let linked_root = temp.path().join("linked-root");
        symlink(&outside, &linked_root).expect("root link");
        assert!(read_provider_text(&linked_root, &linked_root.join("secret")).is_err());

        let fifo = root.join("fifo");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(read_provider_text(&root, &fifo).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hard_links_and_leaf_replacement_races() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        std::fs::create_dir(&root).expect("provider root");

        let outside = temp.path().join("outside");
        std::fs::write(&outside, "outside").expect("outside file");
        let hard_link = root.join("hard-link");
        std::fs::hard_link(&outside, &hard_link).expect("hard link");
        assert!(read_provider_text(&root, &hard_link).is_err());

        let config = root.join("config");
        std::fs::write(&config, "before").expect("config");
        let replaced = root.join("replaced");
        let result =
            open_bounded_regular_file_with_hook(&root, &config, MAX_PROVIDER_TEXT_BYTES, || {
                std::fs::rename(&config, &replaced).expect("move original");
                std::fs::write(&config, "after").expect("replacement");
            });
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_directory_replacement_during_enumeration() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        let commands = root.join("commands");
        std::fs::create_dir_all(&commands).expect("commands");
        std::fs::write(commands.join("safe.md"), "safe").expect("command");
        let replaced = root.join("commands-old");

        let result = read_directory_bounded_with_hook(&root, &commands, 16, || {
            std::fs::rename(&commands, &replaced).expect("move directory");
            std::fs::create_dir(&commands).expect("replacement directory");
            std::fs::write(commands.join("different.md"), "different").expect("replacement entry");
        });

        assert!(result.is_err());
    }
}
