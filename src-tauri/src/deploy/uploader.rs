use super::collector::FilePayload;
use super::config::{has_loopback_host, DeployConfig};
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

const MAX_RESPONSE_BODY_BYTES: usize = 64 * 1024;

static DEPLOY_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn get_deploy_client() -> Result<reqwest::Client, String> {
    DEPLOY_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Failed to initialize the preview upload client.".to_string())
        })
        .clone()
}

#[derive(Serialize)]
struct UploadPayload<'a> {
    #[serde(rename = "siteId")]
    site_id: &'a str,
    #[serde(rename = "deploymentId")]
    deployment_id: &'a str,
    files: Vec<UploadFile<'a>>,
}

#[derive(Serialize)]
struct UploadFile<'a> {
    path: &'a str,
    content: &'a str,
    #[serde(rename = "contentType")]
    content_type: &'a str,
}

#[derive(Serialize)]
struct FinalizePayload<'a> {
    #[serde(rename = "siteId")]
    site_id: &'a str,
    #[serde(rename = "deploymentId")]
    deployment_id: &'a str,
}

#[derive(Deserialize)]
struct UploadResponse {
    success: bool,
    #[serde(rename = "siteId")]
    site_id: String,
    #[serde(rename = "deploymentId")]
    deployment_id: String,
}

#[derive(Deserialize)]
struct FinalizeResponse {
    success: bool,
    #[serde(rename = "siteId")]
    site_id: String,
    #[serde(rename = "deploymentId")]
    deployment_id: String,
    url: String,
}

#[derive(Debug)]
struct RequestFailure {
    message: String,
    transient: bool,
}

impl RequestFailure {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: false,
        }
    }

    fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            transient: true,
        }
    }
}

fn status_failure(status: reqwest::StatusCode) -> RequestFailure {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return RequestFailure::permanent(
            "Unauthorized (401): Invalid API key. Please check BYTRO_DEPLOY_API_KEY.",
        );
    }
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return RequestFailure::permanent(
            "The preview deployment exceeds the Worker's upload limits.",
        );
    }
    if status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
    {
        return RequestFailure::transient(format!(
            "The preview Worker is temporarily unavailable (status {}).",
            status.as_u16()
        ));
    }
    RequestFailure::permanent(format!(
        "The preview Worker rejected the request (status {}).",
        status.as_u16()
    ))
}

fn append_limited(buffer: &mut Vec<u8>, bytes: &[u8]) -> Result<(), RequestFailure> {
    if buffer.len().saturating_add(bytes.len()) > MAX_RESPONSE_BODY_BYTES {
        return Err(RequestFailure::permanent(
            "The preview Worker returned an oversized response.",
        ));
    }
    buffer.extend_from_slice(bytes);
    Ok(())
}

async fn read_limited_json<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, RequestFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
    {
        return Err(RequestFailure::permanent(
            "The preview Worker returned an oversized response.",
        ));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            RequestFailure::transient("Failed to read the preview Worker response.")
        })?;
        append_limited(&mut body, &chunk)?;
    }

    serde_json::from_slice(&body)
        .map_err(|_| RequestFailure::permanent("The preview Worker returned invalid JSON."))
}

async fn send_json<T: Serialize, R: DeserializeOwned>(
    config: &DeployConfig,
    endpoint: &str,
    payload: &T,
) -> Result<R, RequestFailure> {
    let client = get_deploy_client().map_err(RequestFailure::permanent)?;
    let url = config
        .endpoint(endpoint)
        .map_err(RequestFailure::permanent)?;
    let response = client
        .post(url)
        .header("X-API-Key", &config.api_key)
        .json(payload)
        .send()
        .await
        .map_err(|_| RequestFailure::transient("Preview upload request failed."))?;

    if !response.status().is_success() {
        return Err(status_failure(response.status()));
    }
    read_limited_json(response).await
}

async fn with_single_retry<T, F, Fut>(mut request: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, RequestFailure>>,
{
    match request().await {
        Ok(value) => Ok(value),
        Err(first) if first.transient => request().await.map_err(|error| error.message),
        Err(error) => Err(error.message),
    }
}

pub async fn upload_chunk(
    config: &DeployConfig,
    site_id: &str,
    deployment_id: &str,
    files: &[FilePayload],
) -> Result<(), String> {
    let upload_files = files
        .iter()
        .map(|file| UploadFile {
            path: &file.path,
            content: &file.content,
            content_type: &file.content_type,
        })
        .collect();
    let payload = UploadPayload {
        site_id,
        deployment_id,
        files: upload_files,
    };

    let response: UploadResponse =
        with_single_retry(|| send_json(config, "/api/deploy", &payload)).await?;
    if !response.success || response.site_id != site_id || response.deployment_id != deployment_id {
        return Err("The preview Worker returned a mismatched upload response.".to_string());
    }
    Ok(())
}

pub async fn finalize_deployment(
    config: &DeployConfig,
    site_id: &str,
    deployment_id: &str,
) -> Result<String, String> {
    let payload = FinalizePayload {
        site_id,
        deployment_id,
    };
    let response: FinalizeResponse =
        with_single_retry(|| send_json(config, "/api/deploy/finalize", &payload)).await?;
    if !response.success || response.site_id != site_id || response.deployment_id != deployment_id {
        return Err("The preview Worker returned a mismatched finalize response.".to_string());
    }

    validate_published_url(config, site_id, &response.url)
}

fn validate_published_url(
    config: &DeployConfig,
    site_id: &str,
    value: &str,
) -> Result<String, String> {
    let published = url::Url::parse(value)
        .map_err(|_| "The preview Worker returned an invalid site URL.".to_string())?;
    if published.scheme() != "https"
        || published.username() != ""
        || published.password().is_some()
        || published.query().is_some()
        || published.fragment().is_some()
        || published.path() != "/"
    {
        return Err("The preview Worker returned an unsafe site URL.".to_string());
    }

    let published_host = published
        .host_str()
        .ok_or_else(|| "The preview Worker returned an invalid site URL.".to_string())?;
    let worker = url::Url::parse(&config.worker_url)
        .map_err(|_| "The preview Worker URL is invalid.".to_string())?;
    let worker_host = worker
        .host_str()
        .ok_or_else(|| "The preview Worker URL is invalid.".to_string())?;
    if !has_loopback_host(&worker) {
        let expected_host = format!("{site_id}.{worker_host}");
        if !published_host.eq_ignore_ascii_case(&expected_host) {
            return Err("The preview Worker returned a site URL for another host.".to_string());
        }
    }

    Ok(published.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(worker_url: &str) -> DeployConfig {
        DeployConfig {
            worker_url: worker_url.to_string(),
            api_key: "test-secret".to_string(),
        }
    }

    #[test]
    fn response_buffer_has_a_hard_limit() {
        let mut buffer = vec![0; MAX_RESPONSE_BODY_BYTES - 1];
        append_limited(&mut buffer, &[1]).unwrap();
        assert!(append_limited(&mut buffer, &[2]).is_err());
    }

    #[test]
    fn published_url_must_match_the_expected_site_host() {
        let config = config("https://preview.example.test");
        assert_eq!(
            validate_published_url(&config, "site-one", "https://site-one.preview.example.test")
                .unwrap(),
            "https://site-one.preview.example.test/"
        );
        assert!(
            validate_published_url(&config, "site-one", "https://attacker.example.test").is_err()
        );
        assert!(validate_published_url(&config, "site-one", "javascript:alert(1)").is_err());
    }

    #[test]
    fn only_transient_statuses_are_retryable() {
        assert!(status_failure(reqwest::StatusCode::SERVICE_UNAVAILABLE).transient);
        assert!(status_failure(reqwest::StatusCode::TOO_MANY_REQUESTS).transient);
        assert!(!status_failure(reqwest::StatusCode::BAD_REQUEST).transient);
        assert!(!status_failure(reqwest::StatusCode::UNAUTHORIZED).transient);
    }
}
