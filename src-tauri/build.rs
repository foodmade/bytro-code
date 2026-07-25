fn main() {
    embed_binary_versions();

    let mut windows = tauri_build::WindowsAttributes::new();
    windows = windows.app_manifest(
        r#"
        <assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
            <dependency>
                <dependentAssembly>
                    <assemblyIdentity
                        type="win32"
                        name="Microsoft.Windows.Common-Controls"
                        version="6.0.0.0"
                        processorArchitecture="*"
                        publicKeyToken="6595b64144ccf1df"
                        language="*" />
                </dependentAssembly>
            </dependency>
            <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
                <security>
                    <requestedPrivileges>
                        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
                    </requestedPrivileges>
                </security>
            </trustInfo>
        </assembly>
    "#,
    );
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run build script");
}

/// Keep the Community runtime installer on the same version source used by
/// the formal binary publishing pipeline.
fn embed_binary_versions() {
    let pkg_path = std::path::Path::new("../sidecar/package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());

    let content = std::fs::read_to_string(pkg_path).unwrap_or_else(|error| {
        panic!(
            "embed_binary_versions: cannot read {}: {}",
            pkg_path.display(),
            error
        )
    });

    let claude =
        extract_json_string(&content, "@anthropic-ai/claude-agent-sdk").unwrap_or_else(|| {
            panic!(
                "embed_binary_versions: required dependencies[\"@anthropic-ai/claude-agent-sdk\"] \
                 not found in {}",
                pkg_path.display()
            )
        });
    let codex = extract_json_string(&content, "codex").unwrap_or_else(|| {
        panic!(
            "embed_binary_versions: required binaryVersions.codex not found in {}",
            pkg_path.display()
        )
    });

    println!("cargo:rustc-env=CLAUDE_BINARY_VERSION={claude}");
    println!("cargo:rustc-env=CODEX_BINARY_VERSION={codex}");
}

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let index = json.find(&needle)?;
    let after_key = &json[index + needle.len()..];
    let after_colon = &after_key[after_key.find(':')? + 1..];
    let value_start = after_colon.find('"')? + 1;
    let value = &after_colon[value_start..];
    Some(value[..value.find('"')?].to_string())
}
