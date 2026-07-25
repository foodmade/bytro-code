use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct AppConfig {
    pub default_shell: Option<String>,
    pub default_cwd: Option<String>,
    pub font_size: u16,
    pub theme: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            default_shell: None,
            default_cwd: None,
            font_size: 13,
            theme: "dark".to_string(),
        }
    }
}
