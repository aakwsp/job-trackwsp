//! The four Gmail REST calls the poller needs, with plain reqwest.
//! Reference: https://developers.google.com/gmail/api/reference/rest

use oauth2::reqwest;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::mime::Message;

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

#[derive(Debug)]
pub enum ApiError {
    /// Not found (404): for `history.list` the start id is too old; for
    /// `messages.get` the message was deleted since it was listed.
    NotFound,
    /// 401: the access token was rejected.
    Unauthorized,
    Http(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::NotFound => write!(f, "gmail: not found"),
            ApiError::Unauthorized => write!(f, "gmail: access token rejected"),
            ApiError::Http(m) => write!(f, "gmail: {m}"),
        }
    }
}

/// GET with a bearer token. reqwest is built without its `json` feature,
/// so the body is read as text and parsed with serde_json. Error messages
/// carry the status and path, never the token.
fn get<T: DeserializeOwned>(
    http: &reqwest::blocking::Client,
    token: &str,
    path: &str,
    query: &[(&str, &str)],
) -> Result<T, ApiError> {
    let resp = http
        .get(format!("{BASE}{path}"))
        .bearer_auth(token)
        .query(query)
        .send()
        .map_err(|e| ApiError::Http(format!("request failed: {}", e.without_url())))?;
    match resp.status().as_u16() {
        200 => {}
        401 => return Err(ApiError::Unauthorized),
        404 => return Err(ApiError::NotFound),
        s => return Err(ApiError::Http(format!("{path} returned {s}"))),
    }
    let body = resp
        .text()
        .map_err(|e| ApiError::Http(format!("reading {path}: {}", e.without_url())))?;
    serde_json::from_str(&body).map_err(|e| ApiError::Http(format!("unexpected {path} response: {e}")))
}

/// The mailbox's current history id (`users.getProfile`).
pub fn current_history_id(http: &reqwest::blocking::Client, token: &str) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Profile {
        history_id: String,
    }
    Ok(get::<Profile>(http, token, "/profile", &[])?.history_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdOnly {
    id: String,
    #[serde(default)]
    label_ids: Vec<String>,
}

/// Every message id matching a search (`messages.list`), all pages.
/// Drafts are excluded in the query itself.
pub fn list_ids(http: &reqwest::blocking::Client, token: &dyn Fn() -> Result<String, ApiError>, q: &str) -> Result<Vec<String>, ApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        #[serde(default)]
        messages: Vec<IdOnly>,
        next_page_token: Option<String>,
    }
    let mut ids = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut query = vec![("q", q), ("maxResults", "500")];
        if let Some(t) = &page_token {
            query.push(("pageToken", t));
        }
        let page: Page = get(http, &token()?, "/messages", &query)?;
        ids.extend(page.messages.into_iter().map(|m| m.id));
        match page.next_page_token {
            Some(t) => page_token = Some(t),
            None => return Ok(ids),
        }
    }
}

/// Ids of messages added since `start` (`history.list`), all pages, plus
/// the history id to start from next time. Drafts are skipped. `NotFound`
/// means `start` is too old and the caller should fall back to a search.
pub fn added_since(
    http: &reqwest::blocking::Client,
    token: &dyn Fn() -> Result<String, ApiError>,
    start: &str,
) -> Result<(Vec<String>, String), ApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        #[serde(default)]
        history: Vec<History>,
        next_page_token: Option<String>,
        history_id: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct History {
        #[serde(default)]
        messages_added: Vec<Added>,
    }
    #[derive(Deserialize)]
    struct Added {
        message: IdOnly,
    }
    let mut ids = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut query = vec![("startHistoryId", start), ("historyTypes", "messageAdded")];
        if let Some(t) = &page_token {
            query.push(("pageToken", t));
        }
        let page: Page = get(http, &token()?, "/history", &query)?;
        for h in page.history {
            for a in h.messages_added {
                if !a.message.label_ids.iter().any(|l| l == "DRAFT") {
                    ids.push(a.message.id);
                }
            }
        }
        match page.next_page_token {
            Some(t) => page_token = Some(t),
            None => return Ok((ids, page.history_id)),
        }
    }
}

/// One full message (`messages.get`, `format=full`).
pub fn get_message(http: &reqwest::blocking::Client, token: &str, id: &str) -> Result<Message, ApiError> {
    get(http, token, &format!("/messages/{id}"), &[("format", "full")])
}
