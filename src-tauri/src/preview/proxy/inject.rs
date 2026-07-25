use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const INSPECTOR_SCRIPT_MARKER: &str = "id=\"__bytro-preview-inspector-runtime\"";

/// Read the bundled `inspector-runtime.js` once at startup. Uses the same
/// dev/prod split as `preview/project_init.rs:91-99`.
pub fn load_inspector_runtime(app: &AppHandle) -> Result<String, String> {
    let template_dir = if cfg!(dev) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/preview-template")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {}", e))?
            .join("preview-template")
    };

    let runtime_path = template_dir.join("plugins/inspector-runtime.js");
    std::fs::read_to_string(&runtime_path).map_err(|e| {
        format!(
            "failed to read inspector-runtime.js at {}: {}",
            runtime_path.display(),
            e
        )
    })
}

/// Inject the inspector script + vite HMR host overrides into an HTML body.
///
/// `sid` is the session id; the script is served via the proxy at
/// `/__bytro_preview/<sid>/__inspector_runtime.js`. We also pre-set the vite HMR
/// override globals so that vite's client connects back to the proxy on
/// the proxy's port (instead of inferring a wrong host from import.meta.url).
pub fn inject_into_html(html: &str, sid: &str, proxy_port: u16) -> String {
    if html.contains(INSPECTOR_SCRIPT_MARKER) {
        return html.to_string();
    }

    let block = format!(
        r#"<script>
;(function () {{
  // Strip the proxy prefix from the address bar before any user code runs.
  // The browser must see `/__bytro_preview/<sid>/...` to route through this server,
  // but the user's SPA (e.g. React Router) needs to see "/" to match its
  // own routes. We rewrite immediately so the SPA's initial mount reads
  // the expected pathname.
  try {{
    var p = window.location.pathname;
    if (p && p.indexOf("/__bytro_preview/") === 0) {{
      var rewritten = p.replace(/^\/__bytro_preview\/[^/]+\/?/, "/");
      var url = rewritten + window.location.search + window.location.hash;
      window.history.replaceState(null, "", url);
    }}
  }} catch (e) {{ /* swallow — broken browsers degrade to 404 routes */ }}
}})();
window.__HMR_HOSTNAME = "127.0.0.1";
window.__HMR_PORT = {port};
window.__HMR_PROTOCOL = "ws";
window.__HMR_BASE = "/__bytro_preview/{sid}/";
</script>
<script id="__bytro-preview-inspector-runtime" src="/__bytro_preview/{sid}/__inspector_runtime.js"></script>
"#,
        port = proxy_port,
        sid = sid,
    );

    let stripped = strip_csp_meta(html);

    if let Some(idx) = find_case_insensitive(&stripped, "</head>") {
        let mut out = String::with_capacity(stripped.len() + block.len());
        out.push_str(&stripped[..idx]);
        out.push_str(&block);
        out.push_str(&stripped[idx..]);
        out
    } else if let Some(idx) = find_case_insensitive(&stripped, "<body") {
        let mut out = String::with_capacity(stripped.len() + block.len());
        out.push_str(&stripped[..idx]);
        out.push_str(&block);
        out.push_str(&stripped[idx..]);
        out
    } else {
        // Fallback: prepend at the very top — last resort for malformed HTML.
        let mut out = String::with_capacity(stripped.len() + block.len());
        out.push_str(&block);
        out.push_str(&stripped);
        out
    }
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let needle_lower = needle.to_ascii_lowercase();
    let bytes = haystack.as_bytes();
    let n = needle_lower.len();
    if bytes.len() < n {
        return None;
    }
    for i in 0..=bytes.len() - n {
        let slice = &bytes[i..i + n];
        if slice
            .iter()
            .zip(needle_lower.bytes())
            .all(|(a, b)| a.eq_ignore_ascii_case(&b))
        {
            return Some(i);
        }
    }
    None
}

/// Remove `<meta http-equiv="Content-Security-Policy" ...>` tags so the
/// injected script isn't blocked by a strict page-level CSP. Mirrors the
/// existing inspector Vite plugin (`inspector-plugin.ts:29-32`).
fn strip_csp_meta(html: &str) -> String {
    // Simple regex-free scrub: walk and skip any <meta> whose attributes
    // contain `http-equiv` matching CSP. Only handles well-formed tags;
    // malformed HTML degrades to a passthrough, which is acceptable.
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0usize;

    while cursor < html.len() {
        let Some(rel) = lower[cursor..].find("<meta") else {
            out.push_str(&html[cursor..]);
            break;
        };
        let start = cursor + rel;

        let Some(end_rel) = lower[start..].find('>') else {
            out.push_str(&html[cursor..]);
            break;
        };
        let end = start + end_rel + 1;

        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        let is_csp =
            tag_lower.contains("http-equiv") && tag_lower.contains("content-security-policy");

        if is_csp {
            out.push_str(&html[cursor..start]);
            // Skip the tag entirely.
        } else {
            out.push_str(&html[cursor..end]);
            let _ = tag; // tag retained as part of the slice copy above
        }
        cursor = end;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_before_head_close() {
        let html = "<html><head><title>x</title></head><body>hi</body></html>";
        let out = inject_into_html(html, "abc123", 5555);
        let head_close = out.find("</head>").unwrap();
        let script_idx = out.find("__bytro-preview-inspector-runtime").unwrap();
        assert!(script_idx < head_close);
    }

    #[test]
    fn idempotent_when_already_injected() {
        let html = "<html><head></head><body></body></html>";
        let once = inject_into_html(html, "abc123", 5555);
        let twice = inject_into_html(&once, "abc123", 5555);
        assert_eq!(once, twice);
    }

    #[test]
    fn falls_back_to_before_body_when_no_head() {
        let html = "<html><body>no head</body></html>";
        let out = inject_into_html(html, "abc123", 5555);
        assert!(out.contains("__bytro-preview-inspector-runtime"));
        let body_idx = out.find("<body").unwrap();
        let script_idx = out.find("__bytro-preview-inspector-runtime").unwrap();
        assert!(script_idx < body_idx);
    }

    #[test]
    fn strips_csp_meta() {
        let html = r#"<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head>"#;
        let out = inject_into_html(html, "abc", 1);
        assert!(!out.to_ascii_lowercase().contains("content-security-policy"));
    }

    #[test]
    fn keeps_other_meta_tags() {
        let html = "<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"></head>";
        let out = inject_into_html(html, "abc", 1);
        assert!(out.contains("charset"));
        assert!(out.contains("viewport"));
    }

    #[test]
    fn writes_vite_hmr_globals() {
        let html = "<head></head>";
        let out = inject_into_html(html, "abc", 9999);
        assert!(out.contains("__HMR_PORT = 9999"));
        assert!(out.contains("__HMR_HOSTNAME = \"127.0.0.1\""));
    }
}
