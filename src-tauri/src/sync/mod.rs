//! Sync the Google Sheet "discovery inbox" into the local `jobs` table.
//!
//! Read-only against the sheet: `GET {url}?token={token}` returns every row
//! as `{"postings": [...]}` (see `apps-script/code.gs`'s `doGet`). This
//! module never POSTs — that's the scheduler's job (JT-8/JT-22).
//!
//! Deliberately synchronous/blocking (`reqwest::blocking`, `std::thread`)
//! rather than `tokio::time::sleep` + async `reqwest`: CLAUDE.md names
//! `sqlx` and `reqwest` as dependencies but not `tokio`, and a Tauri command
//! that isn't declared `async fn` is already dispatched by Tauri on a
//! blocking-safe thread (`spawn_blocking` internally), so there's nothing to
//! gain from making this async and a real dependency to avoid by not doing
//! so.

mod matching;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

/// One row as the sheet's `doGet` returns it. Every cell comes back as a
/// string, booleans included (`"true"`/`"false"`) — see CLAUDE.md, "Sheet
/// quirks" — and a field the scheduler hasn't ever set comes back as `""`,
/// not absent, but `#[serde(default)]` covers both.
///
/// `applied`, `applied_date`, `notes`, `imported_at` are in the sheet's
/// response too but intentionally not fields here: those are the sheet's
/// own leftover bookkeeping columns from before this app existed. The
/// `jobs` table has no such columns — applied state lives in
/// `applications`, which CLAUDE.md is explicit the sync must never write.
#[derive(Debug, Clone, Deserialize)]
struct RawPosting {
    #[serde(default)]
    company: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    city: String,
    #[serde(default)]
    req_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    deadline: String,
    #[serde(default)]
    posting_status: String,
    #[serde(default)]
    borderline: String,
    #[serde(default)]
    borderline_reason: String,
    #[serde(default)]
    first_seen: String,
    #[serde(default)]
    last_seen: String,
    #[serde(default)]
    source: String,
}

#[derive(Debug, Default, Deserialize)]
struct PostingsResponse {
    #[serde(default)]
    postings: Vec<RawPosting>,
    /// Present instead of `postings` on `{"error": "unauthorized"}` etc.
    error: Option<String>,
}

/// Counts returned to the caller (frontend, via the Tauri command) after a
/// sync — mirrors `code.gs`'s `doPost` response shape (`inserted`,
/// `updated`, `merged`, `skipped`), applied to the local DB instead of the
/// sheet.
#[derive(Debug, Default, Clone, Serialize)]
pub struct SyncCounts {
    pub inserted: u32,
    pub updated: u32,
    pub merged: u32,
    pub skipped: u32,
}

#[derive(Debug)]
pub enum SyncError {
    Config(String),
    Request(reqwest::Error),
    /// Every attempt returned something that didn't parse as JSON — Apps
    /// Script's known failure mode (CLAUDE.md, "Sheet quirks": "intermittently
    /// returns an HTML error page instead of JSON, even though the script
    /// ran"). Carries the last attempt's body (truncated) for debugging.
    InvalidJson {
        attempts: u32,
        last_body: String,
    },
    /// The endpoint parsed fine but reported `{"error": "..."}`, e.g. a bad
    /// token.
    Endpoint(String),
    Db(sqlx::Error),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Config(m) => write!(f, "sync config: {m}"),
            SyncError::Request(e) => write!(f, "sync request failed: {e}"),
            SyncError::InvalidJson {
                attempts,
                last_body,
            } => write!(
                f,
                "sheet did not return valid JSON after {attempts} attempt(s); last body: {:.200}",
                last_body
            ),
            SyncError::Endpoint(e) => write!(f, "sheet endpoint error: {e}"),
            SyncError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for SyncError {}

// Tauri command errors must be `Serialize` so they can cross the invoke
// bridge to the frontend; a plain string is all the UI needs.
impl Serialize for SyncError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl SyncError {
    /// reqwest's error Display includes the request URL, which carries
    /// `?token=` — strip it so the token never reaches the log or the UI.
    fn from_reqwest(e: reqwest::Error) -> Self {
        SyncError::Request(e.without_url())
    }
}

impl From<sqlx::Error> for SyncError {
    fn from(e: sqlx::Error) -> Self {
        SyncError::Db(e)
    }
}

const MAX_ATTEMPTS: u32 = 4; // first try + up to 3 retries, per CLAUDE.md
const RETRY_WAIT: Duration = Duration::from_secs(10);

/// `GET {url}?token={token}`, retried up to 3 times (10s apart) when the
/// body fails to parse as JSON. The retry is keyed on the parse failure,
/// not the HTTP status: Apps Script returns a plain 200 even when it's
/// serving the HTML error page, so checking `response.status()` would never
/// catch the failure CLAUDE.md is warning about.
fn fetch_postings(
    client: &reqwest::blocking::Client,
    url: &str,
    token: &str,
) -> Result<Vec<RawPosting>, SyncError> {
    let mut last_body = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        let body = client
            .get(url)
            .query(&[("token", token)])
            .send()
            .map_err(SyncError::from_reqwest)?
            .text()
            .map_err(SyncError::from_reqwest)?;

        match serde_json::from_str::<PostingsResponse>(&body) {
            Ok(parsed) => {
                if let Some(err) = parsed.error {
                    return Err(SyncError::Endpoint(err));
                }
                return Ok(parsed.postings);
            }
            Err(_) => {
                last_body = body;
                if attempt < MAX_ATTEMPTS {
                    std::thread::sleep(RETRY_WAIT);
                }
            }
        }
    }

    Err(SyncError::InvalidJson {
        attempts: MAX_ATTEMPTS,
        last_body,
    })
}

/// One posting's worth of the three lookups code.gs does before deciding
/// insert vs. update vs. merge — `job_key` first, then `triple`, then
/// `url_norm`, in that order (CLAUDE.md, "Identity and deduplication").
async fn find_existing(
    pool: &SqlitePool,
    key: &str,
    trip: &str,
    url_norm: &str,
) -> Result<Option<(i64, bool)>, sqlx::Error> {
    if let Some(row) = sqlx::query("SELECT id FROM jobs WHERE job_key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?
    {
        return Ok(Some((row.get::<i64, _>("id"), false)));
    }

    if let Some(row) = sqlx::query("SELECT id FROM jobs WHERE triple = ? LIMIT 1")
        .bind(trip)
        .fetch_optional(pool)
        .await?
    {
        return Ok(Some((row.get::<i64, _>("id"), true)));
    }

    if !url_norm.is_empty() {
        if let Some(row) = sqlx::query("SELECT id FROM jobs WHERE url_norm = ? LIMIT 1")
            .bind(url_norm)
            .fetch_optional(pool)
            .await?
        {
            return Ok(Some((row.get::<i64, _>("id"), true)));
        }
    }

    Ok(None)
}

fn parse_bool(s: &str) -> bool {
    s == "true"
}

/// `posting_status` has a `CHECK` in the migration; fall back to `open`
/// rather than letting a blank/unexpected sheet value reject the whole row.
fn posting_status_or_default(s: &str) -> &str {
    match s {
        "open" | "closing" | "closed" => s,
        _ => "open",
    }
}

fn none_if_empty(s: &str) -> Option<&str> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Upserts every posting into `jobs`, three-layer matching as above.
/// `hidden` and `first_seen`/`synced_at` timestamps aside (see inline
/// comments), this mirrors `code.gs`'s `doPost` loop exactly, just against
/// SQLite rows instead of sheet rows.
async fn upsert(pool: &SqlitePool, postings: Vec<RawPosting>) -> Result<SyncCounts, SyncError> {
    let mut counts = SyncCounts::default();

    for p in postings {
        if p.company.trim().is_empty() || p.title.trim().is_empty() {
            counts.skipped += 1;
            continue;
        }

        let key = matching::job_key(&p.company, &p.title, &p.city, &p.req_id);
        let trip = matching::triple(&p.company, &p.title, &p.city);
        let url_norm = matching::norm_url(&p.url);
        // Same truthiness code.gs relies on (`norm(p.req_id) ? ... : ...`):
        // a req id that normalizes to nothing (blank, or pure punctuation)
        // doesn't count as "has one".
        let has_req_id = !matching::norm(&p.req_id).is_empty();

        match find_existing(pool, &key, &trip, &url_norm).await? {
            Some((id, is_merge)) => {
                // A req id we didn't have before upgrades the row's key in
                // place — same rule as code.gs, applied to the local row
                // instead of the sheet row. `first_seen` and `hidden` are
                // deliberately not in this UPDATE: `first_seen` is the
                // sheet's own (mirrored as-is below on insert), and
                // `hidden` is local-only, owned by the user.
                sqlx::query(
                    "UPDATE jobs SET \
                        job_key = CASE WHEN ?1 THEN ?2 ELSE job_key END, \
                        company = ?3, title = ?4, city = ?5, req_id = ?6, \
                        url = ?7, url_norm = ?8, triple = ?9, deadline = ?10, \
                        posting_status = ?11, borderline = ?12, borderline_reason = ?13, \
                        source = ?14, last_seen = ?15, \
                        synced_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') \
                     WHERE id = ?16",
                )
                .bind(has_req_id)
                .bind(&key)
                .bind(&p.company)
                .bind(&p.title)
                .bind(none_if_empty(&p.city))
                .bind(none_if_empty(&p.req_id))
                .bind(none_if_empty(&p.url))
                .bind(none_if_empty(&url_norm))
                .bind(&trip)
                .bind(none_if_empty(&p.deadline))
                .bind(posting_status_or_default(&p.posting_status))
                .bind(parse_bool(&p.borderline))
                .bind(none_if_empty(&p.borderline_reason))
                .bind(none_if_empty(&p.source))
                .bind(none_if_empty(&p.last_seen))
                .bind(id)
                .execute(pool)
                .await?;

                if is_merge {
                    counts.merged += 1;
                } else {
                    counts.updated += 1;
                }
            }
            None => {
                sqlx::query(
                    "INSERT INTO jobs \
                        (job_key, company, title, city, req_id, url, url_norm, triple, \
                         deadline, posting_status, borderline, borderline_reason, source, \
                         first_seen, last_seen) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                )
                .bind(&key)
                .bind(&p.company)
                .bind(&p.title)
                .bind(none_if_empty(&p.city))
                .bind(none_if_empty(&p.req_id))
                .bind(none_if_empty(&p.url))
                .bind(none_if_empty(&url_norm))
                .bind(&trip)
                .bind(none_if_empty(&p.deadline))
                .bind(posting_status_or_default(&p.posting_status))
                .bind(parse_bool(&p.borderline))
                .bind(none_if_empty(&p.borderline_reason))
                .bind(none_if_empty(&p.source))
                .bind(none_if_empty(&p.first_seen))
                .bind(none_if_empty(&p.last_seen))
                .execute(pool)
                .await?;

                counts.inserted += 1;
            }
        }
    }

    Ok(counts)
}

/// Fetches the sheet and upserts into `jobs`. Blocking end-to-end (see the
/// module doc for why) — callers on the UI thread must not call this
/// directly; go through the Tauri command (auto-dispatched off-thread) or
/// the background loop (already its own thread).
pub fn run_sync_blocking(
    pool: &SqlitePool,
    url: &str,
    token: &str,
) -> Result<SyncCounts, SyncError> {
    let client = reqwest::blocking::Client::new();
    let postings = fetch_postings(&client, url, token)?;
    tauri::async_runtime::block_on(upsert(pool, postings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn scratch_dir() -> std::path::PathBuf {
        let unique = format!(
            "job-trackwsp-synctest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    fn repo_root() -> std::path::PathBuf {
        // CARGO_MANIFEST_DIR is src-tauri/ at compile time.
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    /// Loads URL/TOKEN from the repo-root .env the same way `lib.rs` does,
    /// without pulling in a dotenv crate — see `load_dotenv` there. Kept as
    /// a tiny local copy so this test doesn't depend on the app having run
    /// `run()` first.
    fn load_env_value(key: &str) -> Option<String> {
        let contents = std::fs::read_to_string(repo_root().join(".env")).ok()?;
        contents.lines().find_map(|line| {
            let line = line.trim();
            let (k, v) = line.split_once('=')?;
            (k.trim() == key).then(|| v.trim().to_string())
        })
    }

    #[test]
    fn upsert_inserts_then_merges_on_new_req_id() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        let first_seen = RawPosting {
            company: "Shopify".into(),
            title: "SWE Intern".into(),
            city: "Toronto".into(),
            req_id: "".into(),
            url: "https://example.com/jobs/1".into(),
            deadline: "2027-01-15".into(),
            posting_status: "open".into(),
            borderline: "false".into(),
            borderline_reason: "".into(),
            first_seen: "2026-09-01".into(),
            last_seen: "2026-09-01".into(),
            source: "daily".into(),
        };
        let counts =
            tauri::async_runtime::block_on(upsert(&pool, vec![first_seen.clone()])).unwrap();
        assert_eq!(
            (
                counts.inserted,
                counts.updated,
                counts.merged,
                counts.skipped
            ),
            (1, 0, 0, 0)
        );

        // Same posting resurfaces with a req id now — must update the
        // existing row's job_key in place (merge), not insert a new row.
        let mut with_req_id = first_seen.clone();
        with_req_id.req_id = "REQ-42".into();
        let counts = tauri::async_runtime::block_on(upsert(&pool, vec![with_req_id])).unwrap();
        assert_eq!(
            (
                counts.inserted,
                counts.updated,
                counts.merged,
                counts.skipped
            ),
            (0, 0, 1, 0)
        );

        let rows: Vec<(String,)> = tauri::async_runtime::block_on(async {
            sqlx::query_as("SELECT job_key FROM jobs")
                .fetch_all(&pool)
                .await
                .unwrap()
        });
        assert_eq!(rows, vec![("shopify|req 42".to_string(),)]);

        // Missing company/title is skipped, same as code.gs.
        let bad = RawPosting {
            company: "".into(),
            ..first_seen
        };
        let counts = tauri::async_runtime::block_on(upsert(&pool, vec![bad])).unwrap();
        assert_eq!(
            (
                counts.inserted,
                counts.updated,
                counts.merged,
                counts.skipped
            ),
            (0, 0, 0, 1)
        );

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Hits the real Apps Script endpoint from .env — not run by default
    /// (`cargo test` skips `#[ignore]`d tests). Run explicitly:
    ///   cargo test --lib sync::tests::real_sheet_sync -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_sheet_sync() {
        let url = load_env_value("URL").expect(".env has no URL");
        let token = load_env_value("TOKEN").expect(".env has no TOKEN");

        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        let counts = run_sync_blocking(&pool, &url, &token).expect("sync");
        println!(
            "inserted={} updated={} merged={} skipped={}",
            counts.inserted, counts.updated, counts.merged, counts.skipped
        );

        let total: i64 = tauri::async_runtime::block_on(async {
            sqlx::query_scalar("SELECT COUNT(*) FROM jobs")
                .fetch_one(&pool)
                .await
                .unwrap()
        });
        println!("jobs rows after sync: {total}");
        assert!(
            total > 0,
            "expected at least one posting from the real sheet"
        );

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
