// ---------------------------------------------------------------------------
// Skills management — Tauri commands
// ---------------------------------------------------------------------------
//
// Bytro-managed skills are stored under ~/.bytro-community/skills/<provider>/.
// Provider-owned skill and command directories are scanned read-only.
//
// Lightweight operations (scan, info, remove) use direct filesystem access.
// Heavy operations (install, scan repo) shell out to `git` for cloning.
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkillInfo {
    pub name: String,
    pub description: String,
    pub category: String,
    pub source_repo: String,
    pub commit_hash: String,
    pub installed_at: String,
    pub relative_path: String,
    /// Where this skill was discovered: "manifest", "provider-skills",
    /// "provider-commands", "project-skills", "project-commands", "bytro-commands"
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub is_disabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillDetail {
    pub meta: InstalledSkillInfo,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredSkillInfo {
    pub name: String,
    pub description: String,
    pub category: String,
    pub relative_path: String,
}

const DISABLED_SKILL_MD: &str = ".SKILL.md.disabled";
const MAX_SKILL_SCAN_DEPTH: usize = 8;
const MAX_SKILL_SCAN_ENTRIES: usize = 4096;
const MAX_DISCOVERED_SKILLS: usize = 1024;

#[derive(Debug, Clone, Serialize)]
pub struct MarketplaceSkillInfo {
    pub id: String,
    pub skill_id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub source: String,
    pub repo_url: String,
    pub installs: u64,
    pub detail_url: String,
    pub install_command: String,
}

#[derive(Debug, Deserialize)]
struct SkillsSearchResponse {
    #[serde(default)]
    skills: Vec<SkillsSearchItem>,
}

#[derive(Debug, Deserialize)]
struct SkillsSearchItem {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "skillId")]
    skill_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    installs: u64,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillsManifest {
    version: u32,
    skills: HashMap<String, InstalledSkillInfo>,
}

impl Default for SkillsManifest {
    fn default() -> Self {
        Self {
            version: 1,
            skills: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Provider-aware path helpers
// ---------------------------------------------------------------------------

fn provider_namespace(provider: &str) -> Result<String, String> {
    let namespace = provider.trim().to_ascii_lowercase();
    if namespace.is_empty()
        || !namespace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid provider namespace".to_string());
    }
    Ok(namespace)
}

/// Get the Bytro-managed skills directory for a provider.
fn managed_skills_dir(provider: &str) -> Result<PathBuf, String> {
    Ok(crate::bytro_home::skills_dir()?.join(provider_namespace(provider)?))
}

/// Get a provider-owned skills directory for read-only discovery.
fn provider_readonly_skills_dir(provider: &str) -> Result<PathBuf, String> {
    let prefix = provider_home_prefix(provider)
        .ok_or_else(|| format!("Unsupported provider for skills: {}", provider))?;
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.join(prefix).join("skills"))
}

/// Get the Bytro-managed manifest path for a provider.
fn managed_manifest_path(provider: &str) -> Result<PathBuf, String> {
    Ok(managed_skills_dir(provider)?.join(".skills-manifest.json"))
}

fn skill_enabled_path(dir: &Path) -> PathBuf {
    dir.join("SKILL.md")
}

fn skill_disabled_path(dir: &Path) -> PathBuf {
    dir.join(DISABLED_SKILL_MD)
}

fn read_skill_content_from_dir(dir: &Path) -> String {
    let enabled = skill_enabled_path(dir);
    if let Ok(content) = crate::provider_readonly::read_provider_text(dir, &enabled) {
        return content;
    }

    let disabled = skill_disabled_path(dir);
    if let Ok(content) = crate::provider_readonly::read_provider_text(dir, &disabled) {
        return content;
    }

    "(SKILL.md not found)".to_string()
}

fn resolve_skill_dir(
    name: &str,
    provider: &str,
    source: &str,
    _cwd: Option<&str>,
) -> Result<PathBuf, String> {
    let safe_name = sanitize_name(name)?;

    match source {
        "manifest" => Ok(managed_skills_dir(provider)?.join(&safe_name)),
        _ => Err(readonly_source_error(source)),
    }
}

fn readonly_source_error(source: &str) -> String {
    format!(
        "Skill source \"{}\" is read-only in Bytro Community Edition; import it into Bytro before editing",
        source
    )
}

/// Ensure the Bytro-managed provider skills directory exists.
fn ensure_managed_skills_dir(provider: &str) -> Result<PathBuf, String> {
    let dir = managed_skills_dir(provider)?;
    crate::bytro_home::ensure_private_dir(&dir)?;
    Ok(dir)
}

/// Read a Bytro-managed provider manifest.
fn read_managed_manifest(provider: &str) -> SkillsManifest {
    let root = match managed_skills_dir(provider) {
        Ok(p) => p,
        Err(_) => return SkillsManifest::default(),
    };
    let path = match managed_manifest_path(provider) {
        Ok(p) => p,
        Err(_) => return SkillsManifest::default(),
    };
    crate::provider_readonly::read_provider_text(&root, &path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write a Bytro-managed provider manifest.
fn write_managed_manifest(provider: &str, manifest: &SkillsManifest) -> Result<(), String> {
    let path = managed_manifest_path(provider)?;
    ensure_managed_skills_dir(provider)?;
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    crate::bytro_home::write_private_file(&path, json.as_bytes())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Provider-aware directory resolution
// ---------------------------------------------------------------------------

/// Map a provider string to its home-directory dot-folder prefix.
pub fn provider_home_prefix(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some(".claude"),
        "codex" => Some(".codex"),
        "gemini" => Some(".gemini"),
        _ => None,
    }
}

/// Build the ordered list of (directory, source_label, is_skills) tuples to
/// scan for a given provider + cwd.  The caller walks this list in order;
/// the `seen` set ensures higher-priority entries win on name collision.
///
/// Only providers with a known home prefix (claude, codex) are supported.
/// Unknown providers return an empty list.
fn build_scan_dirs(
    provider: Option<&str>,
    cwd: Option<&str>,
) -> Vec<(PathBuf, PathBuf, &'static str, bool)> {
    let mut dirs: Vec<(PathBuf, PathBuf, &'static str, bool)> = Vec::new();
    let home = dirs::home_dir();

    // Only scan for providers with a known home prefix
    let prefix = match provider.and_then(provider_home_prefix) {
        Some(p) => p,
        None => return dirs,
    };

    // Layer 1: Provider-specific global commands (e.g. ~/.claude/commands/)
    if let Some(ref h) = home {
        let root = h.join(prefix);
        dirs.push((
            root.clone(),
            root.join("commands"),
            "provider-commands",
            false,
        ));
    }

    // Layer 2: Project-level provider-specific skills (e.g. {cwd}/.claude/skills/)
    if let Some(cwd_str) = cwd {
        if !cwd_str.is_empty() {
            let root = PathBuf::from(cwd_str).join(prefix);
            dirs.push((root.clone(), root.join("skills"), "project-skills", true));
        }
    }

    // Layer 3: Project-level provider-specific commands (e.g. {cwd}/.claude/commands/)
    if let Some(cwd_str) = cwd {
        if !cwd_str.is_empty() {
            let root = PathBuf::from(cwd_str).join(prefix);
            dirs.push((
                root.clone(),
                root.join("commands"),
                "project-commands",
                false,
            ));
        }
    }

    dirs
}

/// Scan a provider skills directory for SKILL.md files and convert them to
/// InstalledSkillInfo entries.
fn scan_skills_dir_as_installed(
    boundary_root: &Path,
    skills_root: &Path,
    skills: &mut Vec<InstalledSkillInfo>,
    seen: &mut std::collections::HashSet<String>,
    source_label: &str,
) {
    if !crate::provider_readonly::is_real_directory(boundary_root, skills_root) {
        return;
    }
    let mut discovered: Vec<DiscoveredSkillInfo> = Vec::new();
    scan_skills_in_dir_bounded(boundary_root, skills_root, &mut discovered);

    for d in discovered {
        if seen.contains(&d.name) {
            continue;
        }
        seen.insert(d.name.clone());

        skills.push(InstalledSkillInfo {
            name: d.name,
            description: d.description,
            category: d.category,
            source_repo: String::new(),
            commit_hash: String::new(),
            installed_at: String::new(),
            relative_path: d.relative_path,
            source: source_label.to_string(),
            is_disabled: false,
        });
    }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const INVALID_GIT_URL_MESSAGE: &str = "Invalid Git repository URL. Use HTTPS without embedded credentials, query parameters, or fragments; configure authentication with Git credential storage.";

fn public_skill_git_error(category: &str, detail: &str) -> String {
    let digest = Sha256::digest(detail.as_bytes());
    let diagnostic_id = format!("{digest:x}").chars().take(12).collect::<String>();
    log::warn!(
        "[skills-git] category={} len={} sha256={:x}",
        category,
        detail.len(),
        digest
    );
    format!("{category} (diagnosticId: {diagnostic_id})")
}

fn valid_git_path(path: &str) -> bool {
    let trimmed = path.trim_matches('/');
    !trimmed.is_empty()
        && trimmed.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        })
}

/// Normalize a git URL: supports credential-free HTTPS, strict `git@host:path`
/// SSH syntax, and short `owner/repo` form.
fn normalize_git_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');

    if trimmed.starts_with("https://") {
        let mut parsed = Url::parse(trimmed).map_err(|_| INVALID_GIT_URL_MESSAGE.to_string())?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !valid_git_path(parsed.path())
        {
            return Err(INVALID_GIT_URL_MESSAGE.to_string());
        }
        let path = parsed.path().trim_end_matches('/');
        if !path.ends_with(".git") {
            parsed.set_path(&format!("{path}.git"));
        }
        return Ok(parsed.to_string());
    }

    if let Some(ssh) = trimmed.strip_prefix("git@") {
        let Some((host, repo_path)) = ssh.split_once(':') else {
            return Err(INVALID_GIT_URL_MESSAGE.to_string());
        };
        let valid_host = !host.is_empty()
            && !host.starts_with('.')
            && !host.ends_with('.')
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
        if !valid_host || repo_path.contains(['?', '#', '@', ':']) || !valid_git_path(repo_path) {
            return Err(INVALID_GIT_URL_MESSAGE.to_string());
        }
        let repo_path = repo_path.trim_end_matches('/');
        let suffix = if repo_path.ends_with(".git") {
            ""
        } else {
            ".git"
        };
        return Ok(format!(
            "git@{}:{}{}",
            host.to_ascii_lowercase(),
            repo_path,
            suffix
        ));
    }

    // Short form: owner/repo — check with simple char validation
    if let Some((owner, repo)) = trimmed.split_once('/') {
        let valid_segment = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-')
        };
        if valid_segment(owner) && valid_segment(repo) && !repo.contains('/') {
            return Ok(format!("https://github.com/{}.git", trimmed));
        }
    }

    Err(INVALID_GIT_URL_MESSAGE.to_string())
}

/// Shallow-clone a repository, falling back to HTTP zip download if git is
/// not available. Returns a pseudo commit hash (or "http-fallback").
fn clone_repo_shallow(url: &str, target: &Path) -> Result<String, String> {
    // Ensure PATH includes recently-installed Git for Windows, etc.
    super::cli_tools::extend_process_path_with_known_dirs();

    let normalized = normalize_git_url(url)?;

    // Try git clone first
    match try_git_clone(&normalized, target) {
        Ok(hash) => Ok(hash),
        Err(git_err) => {
            // If git is simply not installed, try HTTP zip fallback for GitHub repos
            if let Some(zip_url) = github_zip_url(&normalized) {
                match download_and_extract_zip(&zip_url, target) {
                    Ok(()) => Ok("http-fallback".to_string()),
                    Err(zip_err) => Err(public_skill_git_error(
                        "Repository download failed",
                        &format!("{git_err}; {zip_err}"),
                    )),
                }
            } else {
                Err(git_err)
            }
        }
    }
}

/// Attempt a shallow git clone. Returns the HEAD commit hash on success.
fn try_git_clone(normalized_url: &str, target: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--config",
        "core.symlinks=false",
        "--config",
        "core.fsmonitor=false",
        "--config",
        "protocol.file.allow=never",
        normalized_url,
    ])
    .arg(target)
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_ATTR_NOSYSTEM", "1")
    .env("GIT_TERMINAL_PROMPT", "0");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| public_skill_git_error("Git clone could not start", &e.to_string()))?;

    if !output.status.success() {
        let detail = format!(
            "status={:?}; stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        return Err(public_skill_git_error("Git clone failed", &detail));
    }

    // Get HEAD commit hash
    let mut hash_cmd = std::process::Command::new("git");
    hash_cmd.args(["rev-parse", "HEAD"]).current_dir(target);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        hash_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let hash_output = hash_cmd.output().map_err(|e| {
        public_skill_git_error("Git revision check could not start", &e.to_string())
    })?;
    if !hash_output.status.success() {
        let detail = format!(
            "status={:?}; stderr={}",
            hash_output.status.code(),
            String::from_utf8_lossy(&hash_output.stderr)
        );
        return Err(public_skill_git_error("Git revision check failed", &detail));
    }

    Ok(String::from_utf8_lossy(&hash_output.stdout)
        .trim()
        .to_string())
}

/// Convert a normalized GitHub HTTPS git URL to a direct zip download URL.
/// Returns None for non-GitHub URLs.
fn github_zip_url(normalized_url: &str) -> Option<String> {
    let stripped = normalized_url
        .strip_prefix("https://github.com/")?
        .trim_end_matches(".git");
    // Validate it looks like "owner/repo"
    if stripped.split('/').count() != 2 {
        return None;
    }
    Some(format!(
        "https://github.com/{}/archive/refs/heads/main.zip",
        stripped
    ))
}

/// Download a zip from `url` and extract its contents into `target`.
/// GitHub archive zips contain a top-level directory (e.g. "repo-main/"),
/// so we strip that prefix when extracting.
fn download_and_extract_zip(url: &str, target: &Path) -> Result<(), String> {
    let response =
        reqwest::blocking::get(url).map_err(|e| format!("HTTP download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {} from {}", response.status(), url));
    }

    let bytes = response
        .bytes()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let reader = std::io::Cursor::new(&bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Failed to open zip: {}", e))?;

    // Detect the top-level directory prefix (e.g. "skills-main/")
    let prefix = archive
        .file_names()
        .find(|n| n.ends_with('/'))
        .map(|n| n.to_string())
        .unwrap_or_default();

    std::fs::create_dir_all(target).map_err(|e| format!("Failed to create target dir: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;

        let raw_name = entry.name().to_string();
        // Strip the top-level prefix
        let relative = raw_name.strip_prefix(&prefix).unwrap_or(&raw_name);
        if relative.is_empty() {
            continue;
        }

        // Security: reject paths with ".." or absolute paths
        if relative.contains("..") || std::path::Path::new(relative).is_absolute() {
            continue;
        }

        let out_path = target.join(relative);

        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&out_path);
        } else {
            if let Some(parent) = out_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let mut outfile = std::fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create {}: {}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Failed to write {}: {}", out_path.display(), e))?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// SKILL.md scanner
// ---------------------------------------------------------------------------

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "__pycache__",
    ".next",
    ".venv",
    "venv",
];

/// Predefined skill categories.
const KNOWN_CATEGORIES: &[&str] = &[
    "development",
    "testing",
    "review",
    "devops",
    "docs",
    "security",
    "other",
];

/// Infer a skill category from its name and description when not explicitly set.
fn infer_category(name: &str, description: &str) -> String {
    let text = format!("{} {}", name, description).to_lowercase();

    let patterns: &[(&[&str], &str)] = &[
        (
            &[
                "test",
                "tdd",
                "spec",
                "assert",
                "coverage",
                "jest",
                "mocha",
                "vitest",
                "playwright",
                "e2e",
            ],
            "testing",
        ),
        (
            &["review", "lint", "audit", "check", "inspect", "code-review"],
            "review",
        ),
        (
            &[
                "security",
                "vuln",
                "cve",
                "owasp",
                "auth",
                "encrypt",
                "csrf",
                "xss",
                "injection",
            ],
            "security",
        ),
        (
            &[
                "deploy",
                "ci",
                "cd",
                "docker",
                "k8s",
                "kubernetes",
                "pipeline",
                "infra",
                "devops",
                "terraform",
                "helm",
            ],
            "devops",
        ),
        (
            &[
                "doc",
                "readme",
                "changelog",
                "guide",
                "wiki",
                "comment",
                "jsdoc",
                "typedoc",
            ],
            "docs",
        ),
        (
            &[
                "build",
                "scaffold",
                "generate",
                "create",
                "implement",
                "code",
                "develop",
                "refactor",
                "debug",
                "fix",
                "feature",
            ],
            "development",
        ),
    ];

    for (keywords, category) in patterns {
        for keyword in *keywords {
            if text.contains(keyword) {
                return category.to_string();
            }
        }
    }

    "other".to_string()
}

fn is_valid_github_source(source: &str) -> bool {
    let mut parts = source.split('/');
    let owner = match parts.next() {
        Some(value) => value,
        None => return false,
    };
    let repo = match parts.next() {
        Some(value) => value,
        None => return false,
    };
    if parts.next().is_some() {
        return false;
    }

    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    };

    valid_segment(owner) && valid_segment(repo)
}

fn marketplace_detail_url(source: &str, skill_id: &str) -> String {
    format!("https://www.skills.sh/{}/{}", source, skill_id)
}

fn marketplace_repo_url(source: &str) -> String {
    format!("https://github.com/{}.git", source)
}

/// Parsed SKILL.md frontmatter fields.
struct SkillFrontmatter {
    name: String,
    description: String,
    category: String,
}

/// Parse SKILL.md frontmatter (lightweight YAML subset).
fn parse_skill_md(boundary_root: &Path, path: &Path) -> Option<SkillFrontmatter> {
    let content = crate::provider_readonly::read_provider_text(boundary_root, path).ok()?;
    parse_skill_md_content(path, &content)
}

fn parse_skill_md_content(path: &Path, content: &str) -> Option<SkillFrontmatter> {
    let lines: Vec<&str> = content.lines().collect();

    if lines.first().map(|l| l.trim()) != Some("---") {
        // No frontmatter — use directory name
        let name = path.parent()?.file_name()?.to_string_lossy().to_string();
        if !crate::provider_readonly::is_safe_component(&name) {
            return None;
        }
        let category = infer_category(&name, "");
        return Some(SkillFrontmatter {
            name,
            description: String::new(),
            category,
        });
    }

    let closing = lines.iter().skip(1).position(|l| l.trim() == "---")?;
    let yaml_lines = &lines[1..closing + 1];

    let mut name = String::new();
    let mut description = String::new();
    let mut category = String::new();

    for line in yaml_lines {
        if let Some(rest) = line.strip_prefix("name:") {
            name = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(rest) = line.strip_prefix("description:") {
            description = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(rest) = line.strip_prefix("category:") {
            category = rest
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase();
        }
    }

    if name.is_empty() {
        name = path.parent()?.file_name()?.to_string_lossy().to_string();
    }
    if !crate::provider_readonly::is_safe_component(&name) {
        return None;
    }

    // Validate category: use it if known, otherwise infer
    if !KNOWN_CATEGORIES.contains(&category.as_str()) {
        category = infer_category(&name, &description);
    }

    Some(SkillFrontmatter {
        name,
        description,
        category,
    })
}

/// Recursively scan a directory for SKILL.md files.
fn scan_skills_in_dir(
    boundary_root: &Path,
    result_root: &Path,
    current: &Path,
    results: &mut Vec<DiscoveredSkillInfo>,
    depth: usize,
    remaining_entries: &mut usize,
) {
    if depth > MAX_SKILL_SCAN_DEPTH
        || *remaining_entries == 0
        || results.len() >= MAX_DISCOVERED_SKILLS
    {
        return;
    }
    let entries = match crate::provider_readonly::read_directory_bounded(
        boundary_root,
        current,
        *remaining_entries,
    ) {
        Ok(e) => e,
        Err(_) => return,
    };
    *remaining_entries = (*remaining_entries).saturating_sub(entries.len());

    for entry in entries {
        if results.len() >= MAX_DISCOVERED_SKILLS {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if !IGNORED_DIRS.contains(&dir_name.as_str())
                && crate::provider_readonly::is_safe_component(&dir_name)
                && crate::provider_readonly::is_real_directory(boundary_root, &path)
            {
                scan_skills_in_dir(
                    boundary_root,
                    result_root,
                    &path,
                    results,
                    depth + 1,
                    remaining_entries,
                );
            }
        } else if file_type.is_file() && entry.file_name().to_string_lossy() == "SKILL.md" {
            if let Some(fm) = parse_skill_md(boundary_root, &path) {
                let relative = path
                    .parent()
                    .and_then(|p| p.strip_prefix(result_root).ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();

                results.push(DiscoveredSkillInfo {
                    name: fm.name,
                    description: fm.description,
                    category: fm.category,
                    relative_path: relative,
                });
            }
        }
    }
}

fn scan_skills_in_dir_bounded(
    boundary_root: &Path,
    result_root: &Path,
    results: &mut Vec<DiscoveredSkillInfo>,
) {
    let mut remaining_entries = MAX_SKILL_SCAN_ENTRIES;
    scan_skills_in_dir(
        boundary_root,
        result_root,
        result_root,
        results,
        0,
        &mut remaining_entries,
    );
}

fn relative_path_has_segment(relative_path: &str, segment: &str) -> bool {
    let target = segment.trim();
    if target.is_empty() {
        return false;
    }

    relative_path
        .split(['/', '\\'])
        .any(|part| part.eq_ignore_ascii_case(target))
}

/// Sanitize a skill name for use as a directory name.
fn sanitize_name(name: &str) -> Result<String, String> {
    let sanitized: String = name
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let result = sanitized.trim_matches('-').to_string();
    if result.is_empty() {
        return Err(format!("Invalid skill name: {}", name));
    }
    Ok(result)
}

/// Create a unique temp directory.
fn make_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand_suffix: u32 = (ts as u32)
        ^ std::process::id()
        ^ ((&ts as *const _ as usize as u32).wrapping_mul(2654435761));
    let dir = std::env::temp_dir().join(format!("{}-{}-{:08x}", prefix, ts, rand_suffix));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp directory: {}", e))?;
    Ok(dir)
}

/// Current time as ISO 8601 string (e.g. "2025-01-15T08:30:00.000Z").
fn iso_now() -> String {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();

    // Manual UTC breakdown — avoids pulling in chrono just for this
    const SECS_PER_DAY: u64 = 86400;
    let days = secs / SECS_PER_DAY;
    let day_secs = secs % SECS_PER_DAY;
    let hour = day_secs / 3600;
    let minute = (day_secs % 3600) / 60;
    let second = day_secs % 60;

    // Days since epoch → year/month/day (civil calendar)
    // Algorithm from Howard Hinnant's date library (public domain)
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // day of era [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hour, minute, second, millis
    )
}

/// Copy directory recursively.
fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    let source_metadata = std::fs::symlink_metadata(src)
        .map_err(|e| format!("Failed to inspect source directory: {}", e))?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err("Refusing to copy a non-directory or symlinked skill source".to_string());
    }
    crate::bytro_home::ensure_private_dir(dest)?;

    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Directory entry error: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect skill entry: {}", e))?;
        if file_type.is_symlink() {
            continue;
        }

        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            if let Ok(metadata) = std::fs::symlink_metadata(&dest_path) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(
                        "Refusing to overwrite a non-regular managed skill entry".to_string()
                    );
                }
            }
            std::fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest_path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| format!("Failed to secure managed skill file: {}", e))?;
            }
        }
    }
    Ok(())
}

fn remove_managed_skill_dir_if_exists(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Failed to inspect managed skill: {}", error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Refusing to remove a non-directory managed skill entry".to_string());
    }
    std::fs::remove_dir_all(path).map_err(|e| format!("Failed to remove managed skill: {}", e))
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// Search the public skills.sh marketplace by name/keyword.
///
/// skills.sh currently exposes `GET /api/search?q=...`. The older
/// `/api/skills` endpoint is not available on the public host, so this command
/// intentionally depends only on the live search endpoint and normalizes each
/// result into the repo URL + skill name required by `install_skill_from_repo`.
#[tauri::command]
pub async fn search_marketplace_skills(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<MarketplaceSkillInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let max_results = limit.unwrap_or(30).clamp(1, 50) as usize;
        let encoded_query = urlencoding::encode(trimmed);
        let url = format!("https://skills.sh/api/search?q={}", encoded_query);

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(crate::constants::USER_AGENT)
            .build()
            .map_err(|e| format!("Failed to create skills search client: {}", e))?;

        let response = client
            .get(&url)
            .send()
            .map_err(|e| format!("Failed to search skills.sh: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "skills.sh search returned HTTP {}",
                response.status()
            ));
        }

        let payload: SkillsSearchResponse = response
            .json()
            .map_err(|e| format!("Failed to parse skills.sh response: {}", e))?;

        let results = payload
            .skills
            .into_iter()
            .filter(|item| is_valid_github_source(&item.source))
            .filter_map(|item| {
                let skill_id = if item.skill_id.is_empty() {
                    item.name.clone()
                } else {
                    item.skill_id.clone()
                };
                let name = if item.name.is_empty() {
                    skill_id.clone()
                } else {
                    item.name.clone()
                };
                if skill_id.is_empty() || name.is_empty() {
                    return None;
                }

                let repo_url = marketplace_repo_url(&item.source);
                Some(MarketplaceSkillInfo {
                    id: if item.id.is_empty() {
                        format!("{}/{}", item.source, skill_id)
                    } else {
                        item.id
                    },
                    skill_id: skill_id.clone(),
                    name,
                    description: item.description.clone(),
                    category: infer_category(&skill_id, &item.description),
                    source: item.source.clone(),
                    repo_url: repo_url.clone(),
                    installs: item.installs,
                    detail_url: marketplace_detail_url(&item.source, &skill_id),
                    install_command: format!("npx skills add {} --skill {}", repo_url, skill_id),
                })
            })
            .take(max_results)
            .collect();

        Ok(results)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// List all installed skills, scanning all relevant directories based on
/// the active provider and current working directory.
///
/// Priority (highest first):
///   0.  Bytro-managed manifest and skills (~/.bytro-community/skills/<provider>/)
///   1.  Provider-owned global skills and commands (read-only)
///   2.  Project-level provider skills and commands (read-only)
///
/// Names that appear at a higher priority are never overwritten.
#[tauri::command]
pub fn scan_installed_skills(
    cwd: Option<String>,
    provider: Option<String>,
) -> Result<Vec<InstalledSkillInfo>, String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skills: Vec<InstalledSkillInfo> = Vec::new();

    let prov = provider.as_deref().unwrap_or("");

    // Layer 0: Bytro-managed skills (highest priority).
    let manifest = read_managed_manifest(prov);
    for mut skill in manifest.skills.into_values() {
        if skill.source.is_empty() {
            skill.source = "manifest".to_string();
        }
        seen.insert(skill.name.clone());
        skills.push(skill);
    }

    // Layer 0.5: Bytro-managed SKILL.md files not already in the manifest.
    if let Ok(bytro_skills) = managed_skills_dir(prov) {
        scan_skills_dir_as_installed(
            &bytro_skills,
            &bytro_skills,
            &mut skills,
            &mut seen,
            "manifest",
        );
    }

    // Provider-owned paths remain available for read-only discovery.
    if provider_home_prefix(prov).is_some() {
        // Layer 1: provider-owned skills are available for read-only discovery.
        if let Ok(provider_skills) = provider_readonly_skills_dir(prov) {
            if let Some(provider_root) = provider_skills.parent() {
                scan_skills_dir_as_installed(
                    provider_root,
                    &provider_skills,
                    &mut skills,
                    &mut seen,
                    "provider-skills",
                );
            }
        }
    }

    // Layers 1-3: Provider-aware directories
    let scan_dirs = build_scan_dirs(provider.as_deref(), cwd.as_deref());

    for (boundary_root, dir, source_label, is_skills) in &scan_dirs {
        if !crate::provider_readonly::is_real_directory(boundary_root, dir) {
            continue;
        }
        if *is_skills {
            scan_skills_dir_as_installed(boundary_root, dir, &mut skills, &mut seen, source_label);
        } else {
            let mut remaining_entries = MAX_SKILL_SCAN_ENTRIES;
            let source = CommandSkillSource {
                boundary_root,
                base_dir: dir,
                label: source_label,
            };
            scan_commands_as_skills(
                &source,
                dir,
                0,
                &mut remaining_entries,
                &mut skills,
                &mut seen,
            );
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

/// Recursively scan a commands directory and convert .md files into virtual
/// `InstalledSkillInfo` entries so they appear in the Skills Quick Menu.
struct CommandSkillSource<'a> {
    boundary_root: &'a Path,
    base_dir: &'a Path,
    label: &'a str,
}

fn scan_commands_as_skills(
    source: &CommandSkillSource<'_>,
    current_dir: &Path,
    depth: usize,
    remaining_entries: &mut usize,
    skills: &mut Vec<InstalledSkillInfo>,
    seen: &mut std::collections::HashSet<String>,
) {
    if depth > MAX_SKILL_SCAN_DEPTH
        || *remaining_entries == 0
        || skills.len() >= MAX_DISCOVERED_SKILLS
    {
        return;
    }
    let entries = match crate::provider_readonly::read_directory_bounded(
        source.boundary_root,
        current_dir,
        *remaining_entries,
    ) {
        Ok(e) => e,
        Err(_) => return,
    };
    *remaining_entries = (*remaining_entries).saturating_sub(entries.len());

    for entry in entries {
        if skills.len() >= MAX_DISCOVERED_SKILLS {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if !IGNORED_DIRS.contains(&dir_name.as_str())
                && crate::provider_readonly::is_safe_component(&dir_name)
                && crate::provider_readonly::is_real_directory(source.boundary_root, &path)
            {
                scan_commands_as_skills(source, &path, depth + 1, remaining_entries, skills, seen);
            }
        } else if file_type.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            let relative = match path.strip_prefix(source.base_dir) {
                Ok(r) => r,
                Err(_) => continue,
            };

            // Command name: path separators become ":", extension stripped
            // e.g. "frontend-design.md" → "frontend-design"
            //      "vercel/deploy.md"   → "vercel:deploy"
            let name = relative
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/")
                .replace('/', ":");

            if name.is_empty()
                || name.len() > 512
                || name
                    .split(':')
                    .any(|part| !crate::provider_readonly::is_safe_component(part))
                || seen.contains(&name)
            {
                continue;
            }

            // Read first non-empty line as description
            let Some(content) =
                crate::provider_readonly::read_provider_text(source.boundary_root, &path).ok()
            else {
                continue;
            };
            let description = Some(content)
                .and_then(|content| {
                    content
                        .lines()
                        .find(|line| !line.trim().is_empty())
                        .map(|line| line.trim().trim_start_matches('#').trim().to_string())
                })
                .unwrap_or_default();
            seen.insert(name.clone());

            let category = infer_category(&name, &description);

            skills.push(InstalledSkillInfo {
                name,
                description,
                category,
                source_repo: String::new(),
                commit_hash: String::new(),
                installed_at: String::new(),
                relative_path: relative.to_string_lossy().to_string(),
                source: source.label.to_string(),
                is_disabled: false,
            });
        }
    }
}

fn safe_command_content_path(commands_root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.len() > 512 {
        return Err("Invalid command name".to_string());
    }

    let parts = name.split(':').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| !crate::provider_readonly::is_safe_component(part))
    {
        return Err("Invalid command name".to_string());
    }

    let mut path = commands_root.to_path_buf();
    for part in &parts[..parts.len().saturating_sub(1)] {
        path.push(part);
    }
    path.push(format!("{}.md", parts[parts.len() - 1]));
    Ok(path)
}

fn find_skill_content_path(
    boundary_root: &Path,
    skills_root: &Path,
    name: &str,
) -> Option<PathBuf> {
    if !crate::provider_readonly::is_safe_component(name) {
        return None;
    }

    let mut discovered = Vec::new();
    scan_skills_in_dir_bounded(boundary_root, skills_root, &mut discovered);
    let skill = discovered.into_iter().find(|skill| skill.name == name)?;
    let skill_dir = if skill.relative_path.is_empty() {
        skills_root.to_path_buf()
    } else {
        skills_root.join(skill.relative_path)
    };
    Some(skill_dir.join("SKILL.md"))
}

fn readonly_detail_path(
    name: &str,
    provider: &str,
    source: &str,
    cwd: Option<&str>,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let prefix = provider_home_prefix(provider)
        .ok_or_else(|| format!("Unsupported provider for skills: {}", provider))?;

    let (boundary_root, content_root, is_command) = match source {
        "provider-skills" | "provider-commands" => {
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            let boundary = home.join(prefix);
            let child = if source == "provider-skills" {
                "skills"
            } else {
                "commands"
            };
            (
                boundary.clone(),
                boundary.join(child),
                source.ends_with("commands"),
            )
        }
        "project-skills" | "project-commands" => {
            let cwd = cwd.filter(|value| !value.is_empty());
            let Some(cwd) = cwd else {
                return Ok(None);
            };
            let boundary = PathBuf::from(cwd).join(prefix);
            let child = if source == "project-skills" {
                "skills"
            } else {
                "commands"
            };
            (
                boundary.clone(),
                boundary.join(child),
                source.ends_with("commands"),
            )
        }
        _ => return Ok(None),
    };

    let content_path = if is_command {
        safe_command_content_path(&content_root, name)?
    } else {
        let Some(path) = find_skill_content_path(&boundary_root, &content_root, name) else {
            return Ok(None);
        };
        path
    };

    Ok(Some((boundary_root, content_path)))
}

/// Get detailed information about an installed skill.
///
/// Looks up the skill in the provider manifest first, then tries to locate
/// the SKILL.md file on disk (provider dir, project dir, or commands dir).
#[tauri::command]
pub fn get_skill_detail(
    name: String,
    provider: Option<String>,
    source: Option<String>,
    cwd: Option<String>,
) -> Result<SkillDetail, String> {
    let prov = provider.as_deref().unwrap_or("claude");

    // Try the Bytro-managed manifest first.
    let manifest = read_managed_manifest(prov);
    if let Some(meta) = manifest.skills.get(&name) {
        let safe_name = sanitize_name(&meta.name)?;
        let skill_dir = managed_skills_dir(prov)
            .map(|d| d.join(&safe_name))
            .unwrap_or_default();

        let content = read_skill_content_from_dir(&skill_dir);

        return Ok(SkillDetail {
            meta: meta.clone(),
            content,
        });
    }

    // Not in manifest — resolve path based on source
    let src = source.as_deref().unwrap_or("");
    let detail_path = readonly_detail_path(&name, prov, src, cwd.as_deref())?;
    let content_path = detail_path.as_ref().map(|(_, path)| path.clone());
    let content = detail_path
        .as_ref()
        .and_then(|(root, path)| crate::provider_readonly::read_provider_text(root, path).ok())
        .unwrap_or_else(|| "(Content not found)".to_string());

    let meta = InstalledSkillInfo {
        name: name.clone(),
        description: String::new(),
        category: String::new(),
        source_repo: String::new(),
        commit_hash: String::new(),
        installed_at: String::new(),
        relative_path: content_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        source: src.to_string(),
        is_disabled: false,
    };

    Ok(SkillDetail { meta, content })
}

/// Remove a Bytro-managed skill. Provider and project sources are read-only.
#[tauri::command]
pub fn remove_skill(
    name: String,
    provider: Option<String>,
    source: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let prov = provider.as_deref().unwrap_or("claude");
    let src = source.as_deref().unwrap_or("manifest");
    let _ = cwd;
    if src != "manifest" {
        return Err(readonly_source_error(src));
    }

    let safe_name = sanitize_name(&name)?;
    let dir = managed_skills_dir(prov)?.join(&safe_name);
    remove_managed_skill_dir_if_exists(&dir)?;

    let mut manifest = read_managed_manifest(prov);
    manifest.skills.remove(&name);
    write_managed_manifest(prov, &manifest)?;
    Ok(())
}

#[tauri::command]
pub fn set_skill_disabled(
    name: String,
    provider: Option<String>,
    source: Option<String>,
    cwd: Option<String>,
    disabled: bool,
) -> Result<InstalledSkillInfo, String> {
    let prov = provider.as_deref().unwrap_or("claude");
    let src = source.as_deref().unwrap_or("manifest");

    if src != "manifest" {
        return Err(readonly_source_error(src));
    }

    let skill_dir = resolve_skill_dir(&name, prov, src, cwd.as_deref())?;
    let enabled_path = skill_enabled_path(&skill_dir);
    let disabled_path = skill_disabled_path(&skill_dir);

    if disabled {
        if enabled_path.exists() {
            if disabled_path.exists() {
                std::fs::remove_file(&disabled_path)
                    .map_err(|e| format!("Failed to replace disabled skill file: {}", e))?;
            }
            std::fs::rename(&enabled_path, &disabled_path)
                .map_err(|e| format!("Failed to disable skill: {}", e))?;
        } else if !disabled_path.exists() {
            return Err("SKILL.md not found".to_string());
        }
    } else if disabled_path.exists() {
        if enabled_path.exists() {
            std::fs::remove_file(&disabled_path)
                .map_err(|e| format!("Failed to remove disabled skill file: {}", e))?;
        } else {
            std::fs::rename(&disabled_path, &enabled_path)
                .map_err(|e| format!("Failed to enable skill: {}", e))?;
        }
    } else if !enabled_path.exists() {
        return Err("Disabled SKILL.md not found".to_string());
    }

    let mut manifest = read_managed_manifest(prov);
    let mut meta = manifest.skills.get(&name).cloned().unwrap_or_else(|| {
        let content_path = if enabled_path.exists() {
            enabled_path.clone()
        } else {
            disabled_path.clone()
        };
        let fm = parse_skill_md(&skill_dir, &content_path).unwrap_or(SkillFrontmatter {
            name: name.clone(),
            description: String::new(),
            category: infer_category(&name, ""),
        });

        InstalledSkillInfo {
            name: fm.name,
            description: fm.description,
            category: fm.category,
            source_repo: String::new(),
            commit_hash: String::new(),
            installed_at: String::new(),
            relative_path: skill_dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| sanitize_name(&name).unwrap_or_else(|_| name.clone())),
            source: "manifest".to_string(),
            is_disabled: disabled,
        }
    });

    meta.is_disabled = disabled;
    if meta.source.is_empty() || meta.source == "provider-skills" {
        meta.source = "manifest".to_string();
    }

    manifest.skills.insert(meta.name.clone(), meta.clone());
    write_managed_manifest(prov, &manifest)?;

    Ok(meta)
}

/// Clone a repo and scan for available skills (does NOT install).
#[tauri::command]
pub async fn scan_repo_skills(repo_url: String) -> Result<Vec<DiscoveredSkillInfo>, String> {
    // Run in blocking task to avoid blocking the async runtime
    tokio::task::spawn_blocking(move || {
        let normalized_repo_url = normalize_git_url(&repo_url)?;
        let temp_dir = make_temp_dir("skills-scan")?;

        let result = (|| -> Result<Vec<DiscoveredSkillInfo>, String> {
            clone_repo_shallow(&normalized_repo_url, &temp_dir)?;
            let mut results = Vec::new();
            scan_skills_in_dir_bounded(&temp_dir, &temp_dir, &mut results);
            Ok(results)
        })();

        // Always clean up temp dir
        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Update an installed skill by re-cloning from its source repo.
/// Returns the updated skill info, or an error if the skill is not installed
/// or the source repo is unreachable.
#[tauri::command]
pub async fn update_skill(
    name: String,
    provider: Option<String>,
) -> Result<InstalledSkillInfo, String> {
    tokio::task::spawn_blocking(move || {
        let prov = provider.as_deref().unwrap_or("claude");
        let manifest = read_managed_manifest(prov);
        let meta = manifest
            .skills
            .get(&name)
            .ok_or_else(|| format!("Skill \"{}\" is not installed", name))?;

        let source_repo = normalize_git_url(&meta.source_repo)?;
        let relative_path = meta.relative_path.clone();
        let skill_name = meta.name.clone();
        let description = meta.description.clone();

        let temp_dir = make_temp_dir("skills-update")?;

        let result = (|| -> Result<InstalledSkillInfo, String> {
            let commit_hash = clone_repo_shallow(&source_repo, &temp_dir)?;

            // Find the skill in the cloned repo by relative_path
            let src = temp_dir.join(&relative_path);
            let skill_md = src.join("SKILL.md");
            if !crate::provider_readonly::is_bounded_regular_file(
                &temp_dir,
                &skill_md,
                crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES,
            ) {
                return Err(format!(
                    "SKILL.md not found at expected path \"{}\" in repo",
                    relative_path
                ));
            }

            // Re-parse SKILL.md for updated fields
            let fm = parse_skill_md(&temp_dir, &skill_md).unwrap_or(SkillFrontmatter {
                name: skill_name.clone(),
                description: description.clone(),
                category: infer_category(&skill_name, &description),
            });

            let safe_name = sanitize_name(&skill_name)?;
            let dest = ensure_managed_skills_dir(prov)?.join(&safe_name);

            // Remove existing and copy fresh
            remove_managed_skill_dir_if_exists(&dest)?;
            copy_dir_recursive(&src, &dest)?;

            let updated = InstalledSkillInfo {
                name: fm.name,
                description: fm.description,
                category: fm.category,
                source_repo: source_repo.clone(),
                commit_hash,
                installed_at: iso_now(),
                relative_path,
                source: "manifest".to_string(),
                is_disabled: false,
            };

            let mut manifest = read_managed_manifest(prov);
            manifest.skills.insert(skill_name, updated.clone());
            write_managed_manifest(prov, &manifest)?;

            Ok(updated)
        })();

        // Always clean up temp dir
        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Install skills from a repository into the provider-specific directory.
/// If `skill_names` is provided, installs only those skills.
/// If `skill_names` is None, installs all discovered skills.
#[tauri::command]
pub async fn install_skill_from_repo(
    repo_url: String,
    skill_names: Option<Vec<String>>,
    provider: Option<String>,
) -> Result<Vec<InstalledSkillInfo>, String> {
    tokio::task::spawn_blocking(move || {
        let prov = provider.as_deref().unwrap_or("claude");
        let normalized_repo_url = normalize_git_url(&repo_url)?;
        let temp_dir = make_temp_dir("skills-install")?;

        let result = (|| -> Result<Vec<InstalledSkillInfo>, String> {
            let commit_hash = clone_repo_shallow(&normalized_repo_url, &temp_dir)?;

            let mut discovered = Vec::new();
            scan_skills_in_dir_bounded(&temp_dir, &temp_dir, &mut discovered);

            if discovered.is_empty() {
                return Err("No skills found in repository".to_string());
            }

            // Determine which skills to install
            let to_install: Vec<&DiscoveredSkillInfo> = match &skill_names {
                Some(names) => {
                    let mut selected = Vec::new();
                    let mut selected_paths = std::collections::HashSet::new();
                    for name in names {
                        let found = discovered
                            .iter()
                            .find(|s| s.name == *name || s.relative_path.ends_with(name.as_str()));

                        if let Some(skill) = found {
                            if selected_paths.insert(skill.relative_path.clone()) {
                                selected.push(skill);
                            }
                            continue;
                        }

                        let group_matches = discovered
                            .iter()
                            .filter(|s| relative_path_has_segment(&s.relative_path, name))
                            .collect::<Vec<_>>();

                        if !group_matches.is_empty() {
                            for skill in group_matches {
                                if selected_paths.insert(skill.relative_path.clone()) {
                                    selected.push(skill);
                                }
                            }
                            continue;
                        }

                        let available = discovered
                            .iter()
                            .map(|s| s.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        return Err(format!(
                            "Skill \"{}\" not found. Available: {}",
                            name, available
                        ));
                    }
                    selected
                }
                None => discovered.iter().collect(),
            };

            let managed_skills_dir = ensure_managed_skills_dir(prov)?;
            let mut manifest = read_managed_manifest(prov);
            let mut installed = Vec::new();

            for skill in to_install {
                let safe_name = sanitize_name(&skill.name)?;
                let src = temp_dir.join(&skill.relative_path);
                let dest = managed_skills_dir.join(&safe_name);

                // Remove existing
                remove_managed_skill_dir_if_exists(&dest)?;

                copy_dir_recursive(&src, &dest)?;

                let meta = InstalledSkillInfo {
                    name: skill.name.clone(),
                    description: skill.description.clone(),
                    category: skill.category.clone(),
                    source_repo: normalized_repo_url.clone(),
                    commit_hash: commit_hash.clone(),
                    installed_at: iso_now(),
                    relative_path: skill.relative_path.clone(),
                    source: "manifest".to_string(),
                    is_disabled: false,
                };

                manifest.skills.insert(skill.name.clone(), meta.clone());
                installed.push(meta);
            }

            write_managed_manifest(prov, &manifest)?;
            Ok(installed)
        })();

        // Always clean up temp dir
        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Save edited content for a Bytro-managed skill.
#[tauri::command]
pub fn save_skill_content(
    name: String,
    provider: Option<String>,
    content: String,
    source: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let prov = provider.as_deref().unwrap_or("claude");
    let src = source.as_deref().unwrap_or("manifest");
    let _ = cwd;
    if src != "manifest" {
        return Err(readonly_source_error(src));
    }

    let safe_name = sanitize_name(&name)?;
    let skill_dir = ensure_managed_skills_dir(prov)?.join(&safe_name);
    crate::bytro_home::ensure_private_dir(&skill_dir)?;
    let mut file_path = skill_enabled_path(&skill_dir);

    let manifest = read_managed_manifest(prov);
    if manifest
        .skills
        .get(&name)
        .map(|skill| skill.is_disabled)
        .unwrap_or(false)
    {
        file_path = skill_disabled_path(&skill_dir);
    }

    if let Ok(metadata) = std::fs::symlink_metadata(&file_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Refusing to write a non-regular managed skill file".to_string());
        }
    }

    crate::bytro_home::write_private_file(&file_path, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_urls_are_normalized_without_embedded_request_state() {
        assert_eq!(
            normalize_git_url("https://GitHub.com/OpenAI/codex").expect("HTTPS URL"),
            "https://github.com/OpenAI/codex.git"
        );
        assert_eq!(
            normalize_git_url("git@GitHub.com:OpenAI/codex").expect("SSH URL"),
            "git@github.com:OpenAI/codex.git"
        );
        assert_eq!(
            normalize_git_url("OpenAI/codex").expect("short URL"),
            "https://github.com/OpenAI/codex.git"
        );

        let sentinel = "raw-secret-sentinel";
        for unsafe_url in [
            format!("https://user:{sentinel}@github.com/owner/repo"),
            format!("https://github.com/owner/repo?token={sentinel}"),
            format!("https://github.com/owner/repo#{sentinel}"),
            format!("git@github.com:owner/repo?token={sentinel}"),
        ] {
            let error = normalize_git_url(&unsafe_url).expect_err("reject sensitive URL");
            assert_eq!(error, INVALID_GIT_URL_MESSAGE);
            assert!(!error.contains(sentinel));
            assert!(!error.contains(&unsafe_url));
        }
    }

    #[test]
    fn git_stderr_is_reduced_to_a_bounded_diagnostic_id() {
        let sentinel = "raw-git-stderr-secret-sentinel";
        let public = public_skill_git_error(
            "Git clone failed",
            &format!("fatal: remote returned bearer {sentinel}"),
        );

        assert!(public.starts_with("Git clone failed (diagnosticId: "));
        assert_eq!(public.len(), "Git clone failed (diagnosticId: )".len() + 12);
        assert!(!public.contains(sentinel));
    }

    fn write_test_skill(skills_root: &Path, relative: &str, name: &str) -> PathBuf {
        let skill_dir = skills_root.join(relative);
        std::fs::create_dir_all(&skill_dir).expect("create skill");
        let skill_file = skill_dir.join("SKILL.md");
        std::fs::write(
            &skill_file,
            format!(
                "---\nname: {}\ndescription: Safe test skill\ncategory: testing\n---\n",
                name
            ),
        )
        .expect("write skill");
        skill_file
    }

    #[test]
    fn managed_skill_paths_stay_inside_bytro_home() {
        for provider in ["claude", "codex", "gemini"] {
            let path = managed_skills_dir(provider).expect("managed skill path");
            assert!(path.starts_with(crate::bytro_home::home_dir().expect("Bytro home")));
            assert!(path.ends_with(Path::new("skills").join(provider)));
        }
        assert!(managed_skills_dir("../claude").is_err());
        assert!(managed_skills_dir(".claude").is_err());
    }

    #[test]
    fn provider_and_project_sources_reject_mutation() {
        for source in [
            "provider-skills",
            "provider-commands",
            "project-skills",
            "project-commands",
        ] {
            assert!(remove_skill(
                "example".to_string(),
                Some("claude".to_string()),
                Some(source.to_string()),
                Some("/tmp/example".to_string()),
            )
            .is_err());
            assert!(set_skill_disabled(
                "example".to_string(),
                Some("claude".to_string()),
                Some(source.to_string()),
                Some("/tmp/example".to_string()),
                true,
            )
            .is_err());
            assert!(save_skill_content(
                "example".to_string(),
                Some("claude".to_string()),
                "content".to_string(),
                Some(source.to_string()),
                Some("/tmp/example".to_string()),
            )
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_skill_copy_skips_source_symlinks() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bytro-community-skill-test-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("source");
        let destination = root.join("destination");
        let outside = root.join("outside.txt");
        std::fs::create_dir_all(&source).expect("create source");
        std::fs::write(source.join("SKILL.md"), b"safe").expect("write skill");
        std::fs::write(&outside, b"secret").expect("write outside");
        symlink(&outside, source.join("linked-secret")).expect("link secret");

        copy_dir_recursive(&source, &destination).expect("copy skill");

        assert_eq!(
            std::fs::read(destination.join("SKILL.md")).expect("read copied skill"),
            b"safe"
        );
        assert!(std::fs::symlink_metadata(destination.join("linked-secret")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_scan_finds_valid_skill_without_mutating_source() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        let skills_root = root.join("skills");
        std::fs::create_dir_all(&skills_root).expect("skills root");
        let skill_file = write_test_skill(&skills_root, "nested/safe-skill", "safe-skill");
        let before = std::fs::read(&skill_file).expect("skill snapshot");

        let mut discovered = Vec::new();
        scan_skills_in_dir_bounded(&root, &skills_root, &mut discovered);

        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].name, "safe-skill");
        assert_eq!(
            std::fs::read(&skill_file).expect("skill after scan"),
            before
        );
        assert_eq!(
            find_skill_content_path(&root, &skills_root, "safe-skill"),
            Some(skill_file)
        );
    }

    #[test]
    fn bounded_scan_enforces_size_depth_and_entry_budgets() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        let skills_root = root.join("skills");
        std::fs::create_dir_all(&skills_root).expect("skills root");

        let oversized_dir = skills_root.join("oversized");
        std::fs::create_dir(&oversized_dir).expect("oversized skill dir");
        let oversized =
            std::fs::File::create(oversized_dir.join("SKILL.md")).expect("oversized skill file");
        oversized
            .set_len(crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES + 1)
            .expect("extend oversized skill");

        let mut deep = skills_root.clone();
        for index in 0..=MAX_SKILL_SCAN_DEPTH {
            deep.push(format!("level-{}", index));
        }
        write_test_skill(&deep, "too-deep", "too-deep");

        let mut discovered = Vec::new();
        scan_skills_in_dir_bounded(&root, &skills_root, &mut discovered);
        assert!(discovered.is_empty());

        write_test_skill(&skills_root, "one", "one");
        write_test_skill(&skills_root, "two", "two");
        let mut entry_limited = Vec::new();
        let mut remaining_entries = 1;
        scan_skills_in_dir(
            &root,
            &skills_root,
            &skills_root,
            &mut entry_limited,
            0,
            &mut remaining_entries,
        );
        assert!(entry_limited.len() <= 1);
        assert_eq!(remaining_entries, 0);
    }

    #[test]
    fn command_paths_reject_traversal_and_preserve_nested_names() {
        let commands = Path::new("/provider/commands");
        assert_eq!(
            safe_command_content_path(commands, "group:deploy").expect("safe command"),
            commands.join("group").join("deploy.md")
        );
        for unsafe_name in ["", "../secret", "group:..", "group:/secret", ".hidden"] {
            assert!(safe_command_content_path(commands, unsafe_name).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn bounded_scan_rejects_root_intermediate_leaf_links_loops_and_fifo() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join(".provider");
        let skills_root = root.join("skills");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&skills_root).expect("skills root");
        std::fs::create_dir(&outside).expect("outside root");
        let outside_skill = write_test_skill(&outside, "external", "external");

        let linked_root = temp.path().join("linked-root");
        symlink(&root, &linked_root).expect("linked root");
        let mut root_results = Vec::new();
        scan_skills_in_dir_bounded(&linked_root, &linked_root.join("skills"), &mut root_results);
        assert!(root_results.is_empty());

        let linked_skills = root.join("linked-skills");
        symlink(&outside, &linked_skills).expect("linked skills");
        let mut intermediate_results = Vec::new();
        scan_skills_in_dir_bounded(&root, &linked_skills, &mut intermediate_results);
        assert!(intermediate_results.is_empty());

        let linked_leaf_dir = skills_root.join("linked-leaf");
        std::fs::create_dir(&linked_leaf_dir).expect("linked leaf dir");
        symlink(&outside_skill, linked_leaf_dir.join("SKILL.md")).expect("linked leaf");
        symlink(&outside, skills_root.join("cross-tree")).expect("cross-tree link");
        symlink(&skills_root, skills_root.join("loop")).expect("loop link");

        let fifo_dir = skills_root.join("fifo-skill");
        std::fs::create_dir(&fifo_dir).expect("fifo skill dir");
        let fifo = fifo_dir.join("SKILL.md");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);

        let mut discovered = Vec::new();
        scan_skills_in_dir_bounded(&root, &skills_root, &mut discovered);
        assert!(discovered.is_empty());
    }
}
