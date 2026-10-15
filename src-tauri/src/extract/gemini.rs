//! The Gemini call, behind a trait so the extraction loop can be tested
//! with a mock instead of the network.
//!
//! REST `models.generateContent` with structured output: the request's
//! `generationConfig.responseFormat.text` carries `mimeType:
//! application/json` and a JSON Schema, and the model's answer comes back
//! as JSON text in `candidates[0].content.parts[*].text`. Auth is the
//! `x-goog-api-key` header. (Shape as documented at
//! ai.google.dev/gemini-api/docs/generate-content/structured-output.)

use std::time::Duration;

use oauth2::reqwest;
use serde::Deserialize;
use serde_json::{json, Value};

const BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// Worth retrying after a wait: 429, 5xx, a network failure.
    Retryable(String),
    /// The key was refused (400 with an API-key error, 401, 403). Every
    /// email would fail the same way, so the run stops.
    Auth(String),
    /// This email's request failed in a way a retry won't fix (blocked
    /// prompt, empty answer, other 4xx).
    Failed(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Retryable(m) | CallError::Failed(m) => write!(f, "{m}"),
            CallError::Auth(m) => write!(f, "gemini rejected the API key: {m}"),
        }
    }
}

/// One structured-output call. Returns the model's JSON text.
pub trait LlmClient: Sync {
    fn generate(&self, model: &str, system: &str, user: &str, schema: &Value) -> Result<String, CallError>;
}

/// A shared client is a client: lets tests keep a handle on a mock while
/// `extract::run` owns a boxed copy.
impl<T: LlmClient + Send> LlmClient for std::sync::Arc<T> {
    fn generate(&self, model: &str, system: &str, user: &str, schema: &Value) -> Result<String, CallError> {
        (**self).generate(model, system, user, schema)
    }
}

pub struct GeminiHttp {
    http: reqwest::blocking::Client,
    api_key: String,
}

impl GeminiHttp {
    pub fn new(api_key: String) -> Result<Self, CallError> {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| CallError::Failed(e.to_string()))?;
        Ok(GeminiHttp { http, api_key })
    }
}

impl LlmClient for GeminiHttp {
    fn generate(&self, model: &str, system: &str, user: &str, schema: &Value) -> Result<String, CallError> {
        let body = json!({
            "systemInstruction": { "parts": [{ "text": system }] },
            "contents": [{ "role": "user", "parts": [{ "text": user }] }],
            "generationConfig": {
                // Extraction, not creativity.
                "temperature": 0,
                "responseFormat": {
                    "text": { "mimeType": "application/json", "schema": schema }
                }
            }
        });
        let resp = self
            .http
            .post(format!("{BASE}/{model}:generateContent"))
            .header("x-goog-api-key", &self.api_key)
            .header("Content-Type", "application/json")
            .body(body.to_string())
            .send()
            // `without_url` is belt and braces: the key is in a header,
            // never the URL, but no request detail goes into messages.
            .map_err(|e| CallError::Retryable(format!("gemini request failed: {}", e.without_url())))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .map_err(|e| CallError::Retryable(format!("reading gemini response: {}", e.without_url())))?;
        classify_response(status, &text)
    }
}

/// Status + body → the model's JSON text or an error. Separate from the
/// HTTP call so the classification is testable.
pub fn classify_response(status: u16, body: &str) -> Result<String, CallError> {
    // Google's error bodies: {"error": {"code", "message", "status"}}. Only
    // the message is kept; it never echoes the key.
    let message = || {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("http {status}"))
    };
    match status {
        200 => {}
        429 | 500..=599 => return Err(CallError::Retryable(format!("gemini {status}: {}", message()))),
        401 | 403 => return Err(CallError::Auth(message())),
        400 if body.contains("API_KEY_INVALID") || body.contains("API key not valid") => {
            return Err(CallError::Auth(message()))
        }
        _ => return Err(CallError::Failed(format!("gemini {status}: {}", message()))),
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Resp {
        #[serde(default)]
        candidates: Vec<Candidate>,
        prompt_feedback: Option<Feedback>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Feedback {
        block_reason: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Candidate {
        content: Option<Content>,
        finish_reason: Option<String>,
    }
    #[derive(Deserialize)]
    struct Content {
        #[serde(default)]
        parts: Vec<Part>,
    }
    #[derive(Deserialize)]
    struct Part {
        text: Option<String>,
        /// Thought parts (models that think) aren't the answer.
        #[serde(default)]
        thought: bool,
    }

    let resp: Resp =
        serde_json::from_str(body).map_err(|e| CallError::Failed(format!("unexpected gemini response: {e}")))?;
    if let Some(reason) = resp.prompt_feedback.and_then(|f| f.block_reason) {
        return Err(CallError::Failed(format!("gemini blocked the prompt: {reason}")));
    }
    let Some(candidate) = resp.candidates.into_iter().next() else {
        return Err(CallError::Failed("gemini returned no answer".into()));
    };
    let text: String = candidate
        .content
        .map(|c| c.parts.into_iter().filter(|p| !p.thought).filter_map(|p| p.text).collect())
        .unwrap_or_default();
    if text.trim().is_empty() {
        let why = candidate.finish_reason.unwrap_or_else(|| "unknown".into());
        return Err(CallError::Failed(format!("gemini returned an empty answer (finish reason {why})")));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_responses() {
        let ok = r#"{"candidates":[{"content":{"parts":[{"text":"thinking...","thought":true},{"text":"{\"a\":1}"}]},"finishReason":"STOP"}]}"#;
        assert_eq!(classify_response(200, ok).unwrap(), r#"{"a":1}"#);

        let err = |code, msg: &str| format!(r#"{{"error":{{"code":{code},"message":"{msg}","status":"X"}}}}"#);
        assert!(matches!(classify_response(429, &err(429, "quota")), Err(CallError::Retryable(_))));
        assert!(matches!(classify_response(503, &err(503, "overloaded")), Err(CallError::Retryable(_))));
        assert!(matches!(classify_response(403, &err(403, "denied")), Err(CallError::Auth(_))));
        assert!(matches!(
            classify_response(400, &err(400, "API key not valid. Please pass a valid API key.")),
            Err(CallError::Auth(_))
        ));
        assert!(matches!(classify_response(400, &err(400, "bad schema")), Err(CallError::Failed(_))));

        let blocked = r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#;
        assert_eq!(
            classify_response(200, blocked),
            Err(CallError::Failed("gemini blocked the prompt: SAFETY".into()))
        );
        let empty = r#"{"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}"#;
        assert!(matches!(classify_response(200, empty), Err(CallError::Failed(m)) if m.contains("MAX_TOKENS")));
    }
}
