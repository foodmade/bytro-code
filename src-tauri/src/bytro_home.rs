// ---------------------------------------------------------------------------
// Bytro Community Edition home directory management (~/.bytro-community/)
// ---------------------------------------------------------------------------
//
// Provides path helpers plus initialization and permission hardening for the
// isolated ~/.bytro-community/ directory.
//
// This module is the single source of truth for Bytro-managed MCP servers,
// skills, agents, commands, and plugins. Provider-owned directories are never
// copied automatically and are never used as mutation targets.
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};

#[cfg(windows)]
pub(crate) fn harden_windows_private_acl(path: &Path, is_directory: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AddAccessAllowedAceEx, GetLengthSid, GetTokenInformation, InitializeAcl, TokenUser,
        ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct TokenHandle(HANDLE);
    impl Drop for TokenHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!(
            "Failed to open current-user token for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let _token = TokenHandle(token);

    let mut token_bytes = 0_u32;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut token_bytes);
    }
    if token_bytes < std::mem::size_of::<TOKEN_USER>() as u32 {
        return Err(format!(
            "Failed to size current-user token for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }

    let word_bytes = std::mem::size_of::<usize>();
    let mut token_buffer = vec![0_usize; (token_bytes as usize).div_ceil(word_bytes)];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            token_buffer.as_mut_ptr().cast(),
            token_bytes,
            &mut token_bytes,
        )
    } == 0
    {
        return Err(format!(
            "Failed to read current-user token for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }

    let token_user = unsafe { &*(token_buffer.as_ptr().cast::<TOKEN_USER>()) };
    let user_sid = token_user.User.Sid;
    let sid_bytes = unsafe { GetLengthSid(user_sid) };
    if sid_bytes == 0 {
        return Err(format!(
            "Failed to inspect current-user SID for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }

    let acl_bytes = std::mem::size_of::<ACL>() + std::mem::size_of::<ACCESS_ALLOWED_ACE>()
        - std::mem::size_of::<u32>()
        + sid_bytes as usize;
    let mut acl_buffer = vec![0_usize; acl_bytes.div_ceil(word_bytes)];
    let acl = acl_buffer.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(acl, acl_bytes as u32, ACL_REVISION) } == 0 {
        return Err(format!(
            "Failed to initialize private ACL for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }

    let inheritance = if is_directory {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        0
    };
    if unsafe { AddAccessAllowedAceEx(acl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, user_sid) }
        == 0
    {
        return Err(format!(
            "Failed to grant the current user access to {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        )
    };
    if result != ERROR_SUCCESS {
        return Err(format!(
            "Failed to apply a current-user-only ACL to {}: Windows error {}",
            path.display(),
            result
        ));
    }
    Ok(())
}

pub(crate) fn harden_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to secure file {}: {}", path.display(), e))?;
    }
    #[cfg(windows)]
    harden_windows_private_acl(path, false)?;
    Ok(())
}

fn harden_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to secure directory {}: {}", path.display(), e))?;
    }
    #[cfg(windows)]
    harden_windows_private_acl(path, true)?;
    Ok(())
}

/// Subdirectory names inside ~/.bytro-community/
const SKILLS_SUBDIR: &str = "skills";
const AGENTS_SUBDIR: &str = "agents";
const COMMANDS_SUBDIR: &str = "commands";
const PLUGINS_SUBDIR: &str = "plugins";
const FONTS_SUBDIR: &str = "fonts";

const MCP_SERVERS_FILE: &str = "mcp-servers.json";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Returns the root Bytro Community Edition home directory.
pub fn home_dir() -> Result<PathBuf, String> {
    let user_home = dirs::home_dir().ok_or("Cannot determine user home directory")?;
    Ok(user_home.join(crate::constants::BYTRO_COMMUNITY_HOME_DIR))
}

/// Returns the MCP servers config path: ~/.bytro-community/mcp-servers.json
pub fn mcp_config_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(MCP_SERVERS_FILE))
}

/// Returns the skills directory: ~/.bytro-community/skills/
pub fn skills_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(SKILLS_SUBDIR))
}

/// Returns the commands directory: ~/.bytro-community/commands/
pub fn commands_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(COMMANDS_SUBDIR))
}

/// Returns the agents directory: ~/.bytro-community/agents/
pub fn agents_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(AGENTS_SUBDIR))
}

/// Returns the plugins directory: ~/.bytro-community/plugins/
pub fn plugins_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(PLUGINS_SUBDIR))
}

/// Returns the fonts cache directory: ~/.bytro-community/fonts/
pub fn fonts_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(FONTS_SUBDIR))
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/// Initialize and permission-harden the ~/.bytro-community/ directory structure.
/// Called once during Tauri app setup.
pub fn init() -> Result<(), String> {
    let root = home_dir()?;
    ensure_private_dir(&root)?;

    ensure_private_dir(&root.join(SKILLS_SUBDIR))?;
    ensure_private_dir(&root.join(AGENTS_SUBDIR))?;
    ensure_private_dir(&root.join(COMMANDS_SUBDIR))?;
    ensure_private_dir(&root.join(PLUGINS_SUBDIR))?;
    ensure_private_dir(&root.join(FONTS_SUBDIR))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

pub(crate) fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "Refusing to use symlinked Bytro Community directory {}",
                dir.display()
            ));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(format!(
                "Bytro Community directory path is not a directory: {}",
                dir.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))?;
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect directory {}: {}",
                dir.display(),
                error
            ));
        }
    }

    harden_private_directory(dir)
}

pub(crate) fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write as _;

    let parent = path
        .parent()
        .ok_or_else(|| format!("Bytro file has no parent directory: {}", path.display()))?;
    ensure_private_dir(parent)?;

    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Refusing to write non-regular Bytro file {}",
                path.display()
            ));
        }
    }

    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }

    let mut file = options
        .open(path)
        .map_err(|e| format!("Failed to open file {}: {}", path.display(), e))?;
    file.write_all(contents)
        .map_err(|e| format!("Failed to write file {}: {}", path.display(), e))?;

    file.sync_all()
        .map_err(|e| format!("Failed to flush file {}: {}", path.display(), e))?;
    drop(file);
    harden_private_file(path)
}

pub fn ensure_dir_public(dir: &Path) -> Result<(), String> {
    ensure_dir(dir)
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "bytro-community-home-{}-{}",
                label,
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn private_file_writer_refuses_symlink_targets() {
        use std::os::unix::fs::symlink;

        let test_dir = TestDir::new("private-file-symlink");
        let outside_file = test_dir.0.join("outside.txt");
        let managed_dir = test_dir.0.join(".bytro-community");
        let managed_file = managed_dir.join("settings.json");
        std::fs::create_dir_all(&managed_dir).expect("create managed directory");
        std::fs::write(&outside_file, b"outside sentinel").expect("write outside sentinel");
        symlink(&outside_file, &managed_file).expect("link managed file");

        assert!(write_private_file(&managed_file, b"replacement").is_err());
        assert_eq!(
            std::fs::read(&outside_file).expect("read outside sentinel"),
            b"outside sentinel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_directory_and_file_permissions_are_restricted() {
        use std::os::unix::fs::PermissionsExt;

        let test_dir = TestDir::new("permissions");
        let current = test_dir.0.join(".bytro-community");
        let managed_file = current.join("settings.json");
        ensure_private_dir(&current).expect("create private current home");
        write_private_file(&managed_file, b"{}").expect("write private file");

        let directory_mode = std::fs::metadata(&current)
            .expect("read directory metadata")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = std::fs::metadata(managed_file)
            .expect("read file metadata")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }
}
