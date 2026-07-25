use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectShortcut {
    pub id: String,
    pub label: String,
    pub command: String,
    pub source: String,
    pub kind: String,
    pub recommended: bool,
}

#[tauri::command]
pub fn scan_project_run_shortcuts(project_path: String) -> Result<Vec<ProjectShortcut>, String> {
    let root = Path::new(&project_path);
    if !root.exists() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {}", project_path));
    }

    let mut shortcuts = Vec::new();

    let package_json = root.join("package.json");
    if package_json.exists() {
        shortcuts.extend(scan_package_json(root, &package_json));
    }

    let deno_json = root.join("deno.json");
    if deno_json.exists() {
        shortcuts.extend(scan_deno_tasks(&deno_json));
    }

    let cargo_toml = root.join("Cargo.toml");
    if cargo_toml.exists() {
        shortcuts.extend(scan_cargo_shortcuts(&cargo_toml));
    }

    let makefile = root.join("Makefile");
    if makefile.exists() {
        shortcuts.extend(scan_make_targets(&makefile));
    }

    let justfile = root.join("justfile");
    if justfile.exists() {
        shortcuts.extend(scan_just_targets(&justfile));
    }

    shortcuts.sort_by(|a, b| {
        shortcut_priority(&a.label)
            .cmp(&shortcut_priority(&b.label))
            .then_with(|| a.source.cmp(&b.source))
            .then_with(|| a.label.cmp(&b.label))
    });

    Ok(shortcuts)
}

fn scan_package_json(root: &Path, package_json: &Path) -> Vec<ProjectShortcut> {
    let Ok(content) = fs::read_to_string(package_json) else {
        return Vec::new();
    };
    let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(scripts) = pkg.get("scripts").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let package_manager = detect_package_manager(root, &pkg);
    let source = package_json
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("package.json")
        .to_string();

    scripts
        .keys()
        .map(|name| ProjectShortcut {
            id: format!("package-json:{}", name),
            label: name.clone(),
            command: package_script_command(package_manager, name),
            source: source.clone(),
            kind: infer_kind(name).to_string(),
            recommended: is_recommended(name),
        })
        .collect()
}

fn scan_deno_tasks(file_path: &Path) -> Vec<ProjectShortcut> {
    let Ok(content) = fs::read_to_string(file_path) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(tasks) = config.get("tasks").and_then(|v| v.as_object()) else {
        return Vec::new();
    };

    let source = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("deno.json")
        .to_string();

    tasks
        .keys()
        .map(|name| ProjectShortcut {
            id: format!("deno-task:{}", name),
            label: name.clone(),
            command: format!("deno task {}", name),
            source: source.clone(),
            kind: infer_kind(name).to_string(),
            recommended: is_recommended(name),
        })
        .collect()
}

fn scan_cargo_shortcuts(file_path: &Path) -> Vec<ProjectShortcut> {
    let source = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Cargo.toml")
        .to_string();

    vec![
        ("run", "cargo run"),
        ("build", "cargo build"),
        ("test", "cargo test"),
        ("check", "cargo check"),
        ("clippy", "cargo clippy"),
    ]
    .into_iter()
    .map(|(label, command)| ProjectShortcut {
        id: format!("cargo:{}", label),
        label: label.to_string(),
        command: command.to_string(),
        source: source.clone(),
        kind: infer_kind(label).to_string(),
        recommended: matches!(label, "run" | "build" | "check"),
    })
    .collect()
}

fn scan_make_targets(file_path: &Path) -> Vec<ProjectShortcut> {
    let Ok(content) = fs::read_to_string(file_path) else {
        return Vec::new();
    };
    let source = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Makefile")
        .to_string();
    let mut seen = BTreeSet::new();
    let mut shortcuts = Vec::new();

    for raw_line in content.lines() {
        let line = raw_line.trim_end();
        if line.is_empty()
            || line.starts_with('\t')
            || line.starts_with('#')
            || line.starts_with('.')
        {
            continue;
        }
        let Some((target, _rest)) = line.split_once(':') else {
            continue;
        };
        let target = target.trim();
        if target.is_empty()
            || target.contains('%')
            || target.contains('=')
            || target.contains(' ')
            || !seen.insert(target.to_string())
        {
            continue;
        }

        shortcuts.push(ProjectShortcut {
            id: format!("make:{}", target),
            label: target.to_string(),
            command: format!("make {}", target),
            source: source.clone(),
            kind: infer_kind(target).to_string(),
            recommended: is_recommended(target),
        });
    }

    shortcuts
}

fn scan_just_targets(file_path: &Path) -> Vec<ProjectShortcut> {
    let Ok(content) = fs::read_to_string(file_path) else {
        return Vec::new();
    };
    let source = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("justfile")
        .to_string();
    let mut seen = BTreeSet::new();
    let mut shortcuts = Vec::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((target, _rest)) = line.split_once(':') else {
            continue;
        };
        let target = target.trim();
        if target.is_empty()
            || target.contains(' ')
            || target.starts_with('@')
            || !seen.insert(target.to_string())
        {
            continue;
        }

        shortcuts.push(ProjectShortcut {
            id: format!("just:{}", target),
            label: target.to_string(),
            command: format!("just {}", target),
            source: source.clone(),
            kind: infer_kind(target).to_string(),
            recommended: is_recommended(target),
        });
    }

    shortcuts
}

fn detect_package_manager(root: &Path, pkg: &serde_json::Value) -> &'static str {
    if let Some(pm) = pkg.get("packageManager").and_then(|value| value.as_str()) {
        if pm.starts_with("pnpm@") {
            return "pnpm";
        }
        if pm.starts_with("yarn@") {
            return "yarn";
        }
        if pm.starts_with("bun@") {
            return "bun";
        }
        if pm.starts_with("npm@") {
            return "npm";
        }
    }

    if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    }
}

fn package_script_command(package_manager: &str, script_name: &str) -> String {
    match package_manager {
        "pnpm" => format!("pnpm run {}", script_name),
        "yarn" => format!("yarn run {}", script_name),
        "bun" => format!("bun run {}", script_name),
        _ => format!("npm run {}", script_name),
    }
}

fn infer_kind(name: &str) -> &'static str {
    let normalized = name.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "dev" | "start" | "serve" | "preview" | "run"
    ) || normalized.starts_with("dev:")
        || normalized.starts_with("start:")
        || normalized.starts_with("serve:")
        || normalized.starts_with("preview:")
        || normalized.starts_with("run:")
    {
        "dev"
    } else if normalized.contains("build") {
        "build"
    } else if normalized.contains("test") {
        "test"
    } else if normalized.contains("lint")
        || normalized.contains("check")
        || normalized.contains("fmt")
        || normalized.contains("format")
        || normalized.contains("clippy")
    {
        "check"
    } else {
        "task"
    }
}

fn is_recommended(name: &str) -> bool {
    matches!(infer_kind(name), "dev" | "build")
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "test" | "check" | "lint"
        )
}

fn shortcut_priority(name: &str) -> usize {
    match name.to_ascii_lowercase().as_str() {
        "dev" => 0,
        "start" => 1,
        "preview" => 2,
        "build" => 3,
        "run" => 4,
        "test" => 5,
        "lint" => 6,
        "check" => 7,
        "typecheck" => 8,
        "clippy" => 9,
        "format" => 10,
        _ => 100,
    }
}
