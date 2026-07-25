use super::events::SlashCommandInfoPayload;
use serde::Serialize;

const MAX_COMMAND_DEPTH: usize = 8;
const MAX_COMMAND_ENTRIES: usize = 2048;

// ---------------------------------------------------------------------------
// Filesystem slash command scanner
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SlashCommandContentPayload {
    pub name: String,
    pub description: String,
    pub content: String,
}

#[derive(Debug, Clone)]
struct CommandDirectory {
    /// Provider/Bytro root used for containment and no-link validation.
    root: std::path::PathBuf,
    commands: std::path::PathBuf,
}

fn command_dirs(cwd: Option<&str>, provider: Option<&str>) -> Vec<CommandDirectory> {
    let mut dirs_to_scan: Vec<CommandDirectory> = Vec::new();

    // 1. Bytro-managed commands.
    if let Ok(bytro_cmds) = crate::bytro_home::commands_dir() {
        if let Some(root) = bytro_cmds.parent() {
            dirs_to_scan.push(CommandDirectory {
                root: root.to_path_buf(),
                commands: bytro_cmds,
            });
        }
    }

    // 2. Provider-specific global commands
    let provider_prefix = match provider {
        Some("claude") => Some(".claude"),
        Some("codex") => Some(".codex"),
        _ => None,
    };

    if let Some(home) = dirs::home_dir() {
        if let Some(prefix) = provider_prefix {
            let root = home.join(prefix);
            dirs_to_scan.push(CommandDirectory {
                commands: root.join("commands"),
                root,
            });
        }

        // Legacy fallback: if no known provider prefix, still scan ~/.claude/commands/
        if provider_prefix.is_none() {
            let root = home.join(".claude");
            dirs_to_scan.push(CommandDirectory {
                commands: root.join("commands"),
                root,
            });
        }
    }

    // 3. Project-level provider-specific commands
    if let Some(cwd_str) = cwd {
        if !cwd_str.is_empty() {
            let cwd_path = std::path::PathBuf::from(cwd_str);
            if let Some(prefix) = provider_prefix {
                let root = cwd_path.join(prefix);
                dirs_to_scan.push(CommandDirectory {
                    commands: root.join("commands"),
                    root,
                });
            }
            // Legacy fallback for project-level
            if provider_prefix.is_none() {
                let root = cwd_path.join(".claude");
                dirs_to_scan.push(CommandDirectory {
                    commands: root.join("commands"),
                    root,
                });
            }
        }
    }

    dirs_to_scan
}

fn slash_command_description(content: &str) -> String {
    content
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().trim_start_matches('#').trim().to_string())
        .unwrap_or_default()
}

fn path_for_command_name(
    base_dir: &std::path::Path,
    name: &str,
) -> Result<std::path::PathBuf, String> {
    if name.trim().is_empty() {
        return Err("Slash command name cannot be empty".to_string());
    }
    if name.len() > 512 || name.split(':').count() > MAX_COMMAND_DEPTH + 1 {
        return Err("Slash command name exceeds the path budget".to_string());
    }

    let mut relative = std::path::PathBuf::new();
    for part in name.split(':') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('/')
            || part.contains('\\')
        {
            return Err(format!("Invalid slash command name: {}", name));
        }
        relative.push(part);
    }

    let path = base_dir.join(relative).with_extension("md");
    if !path.starts_with(base_dir) {
        return Err(format!("Invalid slash command path: {}", name));
    }
    Ok(path)
}

fn scan_commands_dir(
    root: &std::path::Path,
    base_dir: &std::path::Path,
    current_dir: &std::path::Path,
    depth: usize,
    remaining_entries: &mut usize,
    commands: &mut Vec<SlashCommandInfoPayload>,
    seen: &mut std::collections::HashSet<String>,
) {
    if depth > MAX_COMMAND_DEPTH || *remaining_entries == 0 {
        return;
    }
    let entries = match crate::provider_readonly::read_directory_bounded(
        root,
        current_dir,
        *remaining_entries,
    ) {
        Ok(e) => e,
        Err(_) => return,
    };
    *remaining_entries = (*remaining_entries).saturating_sub(entries.len());

    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if crate::provider_readonly::is_real_directory(root, &path) {
                scan_commands_dir(
                    root,
                    base_dir,
                    &path,
                    depth + 1,
                    remaining_entries,
                    commands,
                    seen,
                );
            }
        } else if file_type.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let relative = match path.strip_prefix(base_dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let name = relative
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/")
                .replace('/', ":");

            if name.is_empty() || seen.contains(&name) {
                continue;
            }

            let Ok(content) = crate::provider_readonly::read_provider_text(root, &path) else {
                continue;
            };
            let description = slash_command_description(&content);
            seen.insert(name.clone());

            commands.push(SlashCommandInfoPayload {
                name,
                description,
                argument_hint: None,
                aliases: None,
            });
        }
    }
}

#[tauri::command]
pub fn scan_slash_commands(
    cwd: Option<String>,
    provider: Option<String>,
) -> Vec<SlashCommandInfoPayload> {
    let mut commands: Vec<SlashCommandInfoPayload> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let dirs_to_scan = command_dirs(cwd.as_deref(), provider.as_deref());

    let mut remaining_entries = MAX_COMMAND_ENTRIES;
    for dir in dirs_to_scan {
        if !crate::provider_readonly::is_real_directory(&dir.root, &dir.commands) {
            continue;
        }
        scan_commands_dir(
            &dir.root,
            &dir.commands,
            &dir.commands,
            0,
            &mut remaining_entries,
            &mut commands,
            &mut seen,
        );
        if remaining_entries == 0 {
            break;
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

#[tauri::command]
pub fn resolve_slash_command(
    cwd: Option<String>,
    provider: Option<String>,
    name: String,
) -> Result<Option<SlashCommandContentPayload>, String> {
    let dirs_to_scan = command_dirs(cwd.as_deref(), provider.as_deref());

    for dir in dirs_to_scan {
        if !crate::provider_readonly::is_real_directory(&dir.root, &dir.commands) {
            continue;
        }
        let path = path_for_command_name(&dir.commands, &name)?;
        let content = match crate::provider_readonly::read_provider_text(&dir.root, &path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let description = slash_command_description(&content);
        return Ok(Some(SlashCommandContentPayload {
            name,
            description,
            content,
        }));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_root(
        root: &std::path::Path,
        commands_dir: &std::path::Path,
    ) -> Vec<SlashCommandInfoPayload> {
        let mut commands = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut remaining = MAX_COMMAND_ENTRIES;
        scan_commands_dir(
            root,
            commands_dir,
            commands_dir,
            0,
            &mut remaining,
            &mut commands,
            &mut seen,
        );
        commands
    }

    #[test]
    fn scans_normal_nested_commands_without_mutating_source() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        let commands_dir = root.join("commands");
        let nested = commands_dir.join("review");
        std::fs::create_dir_all(&nested).expect("command tree");
        let command = nested.join("pr.md");
        std::fs::write(&command, "# Review pull request\nBody").expect("command");
        let before = std::fs::read(&command).expect("source snapshot");

        let commands = scan_root(&root, &commands_dir);

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "review:pr");
        assert_eq!(commands[0].description, "Review pull request");
        assert_eq!(std::fs::read(&command).expect("source after"), before);
    }

    #[test]
    fn rejects_traversal_and_excessive_depth() {
        let base = std::path::Path::new("/tmp/commands");
        assert!(path_for_command_name(base, "../secret").is_err());
        assert!(path_for_command_name(base, "nested/name").is_err());
        let too_deep = std::iter::repeat_n("part", MAX_COMMAND_DEPTH + 2)
            .collect::<Vec<_>>()
            .join(":");
        assert!(path_for_command_name(base, &too_deep).is_err());
    }

    #[test]
    fn skips_oversized_and_directory_leaf_commands() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        let commands_dir = root.join("commands");
        std::fs::create_dir_all(commands_dir.join("directory.md")).expect("command tree");
        let oversized = commands_dir.join("oversized.md");
        let file = std::fs::File::create(&oversized).expect("oversized command");
        file.set_len(crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES + 1)
            .expect("extend command");

        assert!(scan_root(&root, &commands_dir).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn skips_linked_roots_intermediates_leaves_and_fifo() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".claude");
        let commands_dir = root.join("commands");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&commands_dir).expect("commands");
        std::fs::create_dir_all(&outside).expect("outside");
        let secret = outside.join("secret.md");
        std::fs::write(&secret, "# Secret").expect("secret");

        symlink(&secret, commands_dir.join("linked.md")).expect("leaf link");
        symlink(&outside, commands_dir.join("linked-dir")).expect("directory link");
        let fifo = commands_dir.join("fifo.md");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("fifo");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(scan_root(&root, &commands_dir).is_empty());

        let linked_root = temp.path().join("linked-provider");
        symlink(&root, &linked_root).expect("root link");
        assert!(scan_root(&linked_root, &linked_root.join("commands")).is_empty());
    }
}
