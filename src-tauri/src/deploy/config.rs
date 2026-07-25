use std::collections::HashMap;
use std::path::{Path, PathBuf};

const WORKER_URL_ENV: &str = "BYTRO_DEPLOY_WORKER_URL";
const API_KEY_ENV: &str = "BYTRO_DEPLOY_API_KEY";
const WORKER_URL_FLAG: &str = "--deploy-worker-url";
const API_KEY_FLAG: &str = "--deploy-api-key";

pub struct DeployConfig {
    pub worker_url: String,
    pub api_key: String,
}

impl std::fmt::Debug for DeployConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DeployConfig")
            .field("worker_url", &self.worker_url)
            .field("api_key", &"[REDACTED]")
            .finish()
    }
}

impl DeployConfig {
    pub fn load() -> Result<Self, String> {
        let args = std::env::args().collect::<Vec<_>>();
        let environment = std::env::vars().collect::<HashMap<_, _>>();
        let file_layers = env_file_candidates()
            .into_iter()
            .filter_map(|(root, path)| read_env_file(&root, &path))
            .collect::<Vec<_>>();

        Self::from_sources(&args, &environment, &file_layers)
    }

    fn from_sources(
        args: &[String],
        environment: &HashMap<String, String>,
        file_layers: &[HashMap<String, String>],
    ) -> Result<Self, String> {
        let worker_url = cli_value(args, WORKER_URL_FLAG)?
            .or_else(|| non_empty_value(environment, WORKER_URL_ENV))
            .or_else(|| layered_value(file_layers, WORKER_URL_ENV))
            .unwrap_or_default();
        let api_key = cli_value(args, API_KEY_FLAG)?
            .or_else(|| non_empty_value(environment, API_KEY_ENV))
            .or_else(|| layered_value(file_layers, API_KEY_ENV))
            .unwrap_or_default();

        Ok(Self {
            worker_url,
            api_key,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.worker_url.is_empty() {
            return Err(format!(
                "{WORKER_URL_ENV} is not configured. Use {WORKER_URL_FLAG} or a local .env file."
            ));
        }

        let parsed = url::Url::parse(&self.worker_url)
            .map_err(|_| format!("{WORKER_URL_ENV} must be a valid HTTP(S) URL."))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(format!("{WORKER_URL_ENV} must use HTTP or HTTPS."));
        }
        if parsed.scheme() == "http" && !has_loopback_host(&parsed) {
            return Err(format!(
                "{WORKER_URL_ENV} must use HTTPS unless it points to localhost."
            ));
        }
        if parsed.username() != "" || parsed.password().is_some() {
            return Err(format!(
                "{WORKER_URL_ENV} must not contain embedded credentials."
            ));
        }
        if !has_loopback_host(&parsed) && !matches!(parsed.host(), Some(url::Host::Domain(_))) {
            return Err(format!(
                "{WORKER_URL_ENV} must use a domain name unless it points to localhost."
            ));
        }
        if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(format!(
                "{WORKER_URL_ENV} must be a base URL without a path, query, or fragment."
            ));
        }

        if self.api_key.is_empty() {
            return Err(format!(
                "{API_KEY_ENV} is not configured. Use {API_KEY_FLAG} or a local .env file."
            ));
        }
        if self.api_key.chars().any(char::is_control) {
            return Err(format!(
                "{API_KEY_ENV} contains invalid control characters."
            ));
        }

        Ok(())
    }

    pub fn endpoint(&self, path: &str) -> Result<url::Url, String> {
        self.validate()?;
        let mut url = url::Url::parse(&self.worker_url)
            .map_err(|_| format!("{WORKER_URL_ENV} must be a valid HTTP(S) URL."))?;
        url.set_path(path.trim_start_matches('/'));
        Ok(url)
    }
}

pub(super) fn has_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn cli_value(args: &[String], flag: &str) -> Result<Option<String>, String> {
    let with_equals = format!("{flag}=");
    let mut result = None;
    let mut index = 1;

    while index < args.len() {
        let argument = &args[index];
        if argument == flag {
            let value = args
                .get(index + 1)
                .filter(|value| !value.starts_with("--"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{flag} requires a value."))?;
            result = Some(value);
            index += 2;
            continue;
        }

        if let Some(value) = argument.strip_prefix(&with_equals) {
            let value = value.trim();
            if value.is_empty() {
                return Err(format!("{flag} requires a value."));
            }
            result = Some(value.to_string());
        }

        index += 1;
    }

    Ok(result)
}

fn non_empty_value(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn layered_value(layers: &[HashMap<String, String>], key: &str) -> Option<String> {
    layers
        .iter()
        .find_map(|values| non_empty_value(values, key))
}

fn env_file_candidates() -> Vec<(PathBuf, PathBuf)> {
    let mut bases = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        let user_home = dirs::home_dir();
        if user_home.as_ref() != Some(&cwd) && is_community_checkout(&cwd) {
            bases.push(cwd);
        }
    }
    if let Ok(app_home) = crate::bytro_home::home_dir() {
        if !bases.contains(&app_home) {
            bases.push(app_home);
        }
    }

    let mut candidates = Vec::new();
    for name in [".env.local", ".env"] {
        for base in &bases {
            candidates.push((base.clone(), base.join(name)));
        }
    }
    candidates
}

fn is_community_checkout(path: &Path) -> bool {
    let package_json_path = path.join("package.json");
    let package_json = match crate::provider_readonly::read_provider_text(path, &package_json_path)
    {
        Ok(content) => content,
        Err(_) => return false,
    };
    let package = match serde_json::from_str::<serde_json::Value>(&package_json) {
        Ok(value) => value,
        Err(_) => return false,
    };

    package.get("name").and_then(serde_json::Value::as_str) == Some("bytro-community")
        && crate::provider_readonly::is_bounded_regular_file(
            path,
            &path.join("src-tauri").join("tauri.conf.json"),
            crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES,
        )
}

fn read_env_file(root: &Path, path: &Path) -> Option<HashMap<String, String>> {
    let content = crate::provider_readonly::read_provider_text(root, path).ok()?;
    Some(parse_env_content(&content))
}

fn parse_env_content(content: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let trimmed = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            if !matches!(key, WORKER_URL_ENV | API_KEY_ENV) {
                continue;
            }
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string();
            if !value.is_empty() {
                values.insert(key.to_string(), value);
            }
        }
    }

    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn reads_bounded_env_file_without_mutating_it() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("checkout");
        std::fs::create_dir(&root).expect("checkout root");
        let env_file = root.join(".env");
        std::fs::write(
            &env_file,
            format!(
                "{WORKER_URL_ENV}=https://worker.example.test\n{API_KEY_ENV}=secret\nIGNORED=value\n"
            ),
        )
        .expect("write env");
        let before = std::fs::read(&env_file).expect("env snapshot");

        let values = read_env_file(&root, &env_file).expect("read env");

        assert_eq!(
            values.get(WORKER_URL_ENV).map(String::as_str),
            Some("https://worker.example.test")
        );
        assert_eq!(values.get(API_KEY_ENV).map(String::as_str), Some("secret"));
        assert!(!values.contains_key("IGNORED"));
        assert_eq!(std::fs::read(&env_file).expect("env after read"), before);
    }

    #[test]
    fn rejects_oversized_and_non_regular_env_files() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("checkout");
        std::fs::create_dir(&root).expect("checkout root");

        let oversized_path = root.join(".env");
        let oversized = std::fs::File::create(&oversized_path).expect("oversized env");
        oversized
            .set_len(crate::provider_readonly::MAX_PROVIDER_TEXT_BYTES + 1)
            .expect("extend oversized env");
        assert!(read_env_file(&root, &oversized_path).is_none());

        let directory_path = root.join(".env.local");
        std::fs::create_dir(&directory_path).expect("directory env");
        assert!(read_env_file(&root, &directory_path).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_linked_roots_linked_env_files_and_fifo() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("checkout");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).expect("checkout root");
        std::fs::create_dir(&outside).expect("outside root");
        let secret = outside.join("secret.env");
        std::fs::write(&secret, format!("{API_KEY_ENV}=outside-secret\n")).expect("secret env");

        let linked_root = temp.path().join("linked-root");
        symlink(&outside, &linked_root).expect("linked root");
        assert!(read_env_file(&linked_root, &linked_root.join("secret.env")).is_none());

        let linked_leaf = root.join(".env");
        symlink(&secret, &linked_leaf).expect("linked env");
        assert!(read_env_file(&root, &linked_leaf).is_none());

        let fifo = root.join(".env.local");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);
        assert!(read_env_file(&root, &fifo).is_none());
    }

    #[test]
    fn command_line_overrides_environment_and_files() {
        let args = vec![
            "bytro".to_string(),
            WORKER_URL_FLAG.to_string(),
            "https://cli.example.test".to_string(),
            format!("{API_KEY_FLAG}=cli-secret"),
        ];
        let environment = map(&[
            (WORKER_URL_ENV, "https://env.example.test"),
            (API_KEY_ENV, "env-secret"),
        ]);
        let files = vec![map(&[
            (WORKER_URL_ENV, "https://file.example.test"),
            (API_KEY_ENV, "file-secret"),
        ])];

        let config = DeployConfig::from_sources(&args, &environment, &files).unwrap();

        assert_eq!(config.worker_url, "https://cli.example.test");
        assert_eq!(config.api_key, "cli-secret");
    }

    #[test]
    fn environment_overrides_file_layers() {
        let args = vec!["bytro".to_string()];
        let environment = map(&[
            (WORKER_URL_ENV, "https://env.example.test"),
            (API_KEY_ENV, "env-secret"),
        ]);
        let files = vec![map(&[
            (WORKER_URL_ENV, "https://file.example.test"),
            (API_KEY_ENV, "file-secret"),
        ])];

        let config = DeployConfig::from_sources(&args, &environment, &files).unwrap();

        assert_eq!(config.worker_url, "https://env.example.test");
        assert_eq!(config.api_key, "env-secret");
    }

    #[test]
    fn first_file_layer_has_priority() {
        let args = vec!["bytro".to_string()];
        let files = vec![
            map(&[
                (WORKER_URL_ENV, "https://local.example.test"),
                (API_KEY_ENV, "local-secret"),
            ]),
            map(&[
                (WORKER_URL_ENV, "https://fallback.example.test"),
                (API_KEY_ENV, "fallback-secret"),
            ]),
        ];

        let config = DeployConfig::from_sources(&args, &HashMap::new(), &files).unwrap();

        assert_eq!(config.worker_url, "https://local.example.test");
        assert_eq!(config.api_key, "local-secret");
    }

    #[test]
    fn missing_command_line_value_is_rejected() {
        let args = vec!["bytro".to_string(), API_KEY_FLAG.to_string()];

        let error = DeployConfig::from_sources(&args, &HashMap::new(), &[]).unwrap_err();

        assert!(error.contains("requires a value"));
        assert!(!error.contains("secret"));
    }

    #[test]
    fn validation_rejects_non_http_urls_and_embedded_credentials() {
        let non_http = DeployConfig {
            worker_url: "file:///tmp/worker".to_string(),
            api_key: "secret".to_string(),
        };
        assert!(non_http.validate().unwrap_err().contains("HTTP or HTTPS"));

        let credentials = DeployConfig {
            worker_url: "https://user:password@example.test".to_string(),
            api_key: "secret".to_string(),
        };
        assert!(credentials
            .validate()
            .unwrap_err()
            .contains("embedded credentials"));

        let public_ip = DeployConfig {
            worker_url: "https://203.0.113.10".to_string(),
            api_key: "secret".to_string(),
        };
        assert!(public_ip.validate().unwrap_err().contains("domain name"));
    }

    #[test]
    fn validation_requires_https_away_from_loopback() {
        let remote_http = DeployConfig {
            worker_url: "http://preview.example.test".to_string(),
            api_key: "secret".to_string(),
        };
        assert!(remote_http
            .validate()
            .unwrap_err()
            .contains("must use HTTPS"));

        for worker_url in [
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
        ] {
            let local_http = DeployConfig {
                worker_url: worker_url.to_string(),
                api_key: "secret".to_string(),
            };
            assert!(local_http.validate().is_ok(), "{worker_url}");
        }
    }

    #[test]
    fn validation_rejects_non_base_urls_and_endpoint_joins_safely() {
        for worker_url in [
            "https://preview.example.test/api/deploy",
            "https://preview.example.test?target=deploy",
            "https://preview.example.test#deploy",
        ] {
            let config = DeployConfig {
                worker_url: worker_url.to_string(),
                api_key: "secret".to_string(),
            };
            assert!(config.validate().is_err(), "{worker_url}");
        }

        let config = DeployConfig {
            worker_url: "https://preview.example.test/".to_string(),
            api_key: "secret".to_string(),
        };
        assert_eq!(
            config.endpoint("/api/deploy").unwrap().as_str(),
            "https://preview.example.test/api/deploy"
        );
    }

    #[test]
    fn validation_errors_never_include_api_key() {
        let config = DeployConfig {
            worker_url: "not a url".to_string(),
            api_key: "do-not-print-this-secret".to_string(),
        };

        let error = config.validate().unwrap_err();

        assert!(!error.contains(&config.api_key));
    }

    #[test]
    fn debug_output_redacts_api_key() {
        let config = DeployConfig {
            worker_url: "https://worker.example.test".to_string(),
            api_key: "do-not-print-this-secret".to_string(),
        };

        let debug = format!("{config:?}");

        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains(&config.api_key));
    }

    #[test]
    fn env_parser_supports_quotes_and_ignores_unrelated_keys() {
        let values = parse_env_content(
            r#"
                # Local community configuration
                BYTRO_DEPLOY_WORKER_URL="https://worker.example.test"
                export BYTRO_DEPLOY_API_KEY='local-secret'
                UNRELATED_KEY=ignored
            "#,
        );

        assert_eq!(
            values.get(WORKER_URL_ENV).map(String::as_str),
            Some("https://worker.example.test")
        );
        assert_eq!(
            values.get(API_KEY_ENV).map(String::as_str),
            Some("local-secret")
        );
        assert!(!values.contains_key("UNRELATED_KEY"));
    }

    #[test]
    fn generic_directories_are_not_treated_as_environment_roots() {
        let unique = format!(
            "bytro-deploy-config-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        );
        let base = std::env::temp_dir().join(unique);
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("package.json"), r#"{"name":"unrelated-project"}"#).unwrap();
        fs::create_dir_all(base.join("src-tauri")).unwrap();
        fs::write(base.join("src-tauri").join("tauri.conf.json"), "{}").unwrap();

        assert!(!is_community_checkout(&base));

        fs::write(base.join("package.json"), r#"{"name":"bytro-community"}"#).unwrap();
        assert!(is_community_checkout(&base));

        fs::remove_dir_all(base).unwrap();
    }
}
