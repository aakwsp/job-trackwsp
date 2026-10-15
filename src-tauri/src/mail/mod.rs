//! Incremental mail polling for the job account (JT-14).
//!
//! First poll: backfill everything since 2026-08-01 with a search, having
//! read the mailbox's current `historyId` first, and save that id. Later
//! polls: `history.list` from the saved id. If Google says it's too old
//! (404), search since the last successful poll instead. Each message is
//! fetched once (ids already in `emails` are skipped), decoded (`mime`),
//! filtered (`filter`) and stored as `pending` or `ignored`.
//!
//! The history id and the "last checked" values are saved only after the
//! whole batch is stored, so a poll that fails halfway is simply redone.
//!
//! Polls run on app start, every 10 minutes, and on [ check mail ]; one at
//! a time (`MailState`). With Gmail disconnected a poll quietly does
//! nothing. Blocking throughout, like `sync` and `gmail`.

pub mod api;
pub mod filter;
pub mod mime;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use oauth2::reqwest;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::gmail::{self, credentials::ClientCredentials, GmailError, GmailState};
use api::ApiError;

/// The backfill start: 2026-08-01 00:00 in Toronto (EDT, UTC-4), as Unix
/// seconds. Gmail's `after:` takes seconds for an exact cutoff.
const BACKFILL_SINCE: u64 = 1_785_556_800;
/// The fallback search starts this long before the last successful poll,
/// so mail that arrived around that poll isn't missed. Overlap is free:
/// stored ids are skipped.
const FALLBACK_OVERLAP: Duration = Duration::from_secs(60 * 60);
pub const POLL_INTERVAL: Duration = Duration::from_secs(10 * 60);

const HISTORY_KEY: &str = "mail_history_id";
const LAST_POLL_KEY: &str = "mail_last_poll_at";
const LAST_NEW_KEY: &str = "mail_last_new";

#[derive(Debug)]
pub enum MailError {
    Gmail(GmailError),
    Api(ApiError),
    Db(sqlx::Error),
}

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailError::Gmail(e) => write!(f, "{e}"),
            MailError::Api(e) => write!(f, "{e}"),
            MailError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for MailError {}

impl Serialize for MailError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<sqlx::Error> for MailError {
    fn from(e: sqlx::Error) -> Self {
        MailError::Db(e)
    }
}

impl From<ApiError> for MailError {
    fn from(e: ApiError) -> Self {
        MailError::Api(e)
    }
}

/// Ensures one poll at a time, whichever of the three triggers starts it.
#[derive(Default)]
pub struct MailState {
    running: AtomicBool,
}

/// What the status line shows. Mirrors `MailStatus` in types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct MailStatus {
    /// Full ISO timestamp of the last successful poll; null before the first.
    pub last_checked_at: Option<String>,
    /// Messages from that poll that passed the filter (status pending).
    pub last_new: u32,
    /// A poll is running right now.
    pub checking: bool,
}

pub fn status(mail: &MailState, pool: &SqlitePool) -> Result<MailStatus, MailError> {
    Ok(MailStatus {
        last_checked_at: get_setting(pool, LAST_POLL_KEY)?,
        last_new: get_setting(pool, LAST_NEW_KEY)?.and_then(|n| n.parse().ok()).unwrap_or(0),
        checking: mail.running.load(Ordering::SeqCst),
    })
}

/// One poll, unless another is running (then this returns at once). With
/// Gmail disconnected, or no client file, it does nothing and isn't an
/// error.
pub fn poll(gmail: &GmailState, mail: &MailState, pool: &SqlitePool, creds: Option<&ClientCredentials>) -> Result<(), MailError> {
    if mail.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = match creds {
        Some(creds) => poll_inner(gmail, pool, creds),
        None => Ok(()),
    };
    mail.running.store(false, Ordering::SeqCst);
    result
}

fn poll_inner(gmail_state: &GmailState, pool: &SqlitePool, creds: &ClientCredentials) -> Result<(), MailError> {
    // Disconnected: no polling, no error.
    match gmail::access_token(gmail_state, pool, creds) {
        Ok(_) => {}
        Err(GmailError::NotConnected) => return Ok(()),
        Err(e) => return Err(MailError::Gmail(e)),
    }
    // Every request asks for the token again: it's cached, and a long
    // backfill that outlives the hour gets a refreshed one.
    let token = || -> Result<String, ApiError> {
        gmail::access_token(gmail_state, pool, creds)
            .map(|t| t.secret().clone())
            .map_err(|e| ApiError::Http(e.to_string()))
    };
    let http = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| ApiError::Http(e.to_string()))?;
    let started = now_iso();

    let (ids, next_history) = match get_setting(pool, HISTORY_KEY)? {
        None => {
            // First run. The id is read before listing, so mail arriving
            // during the backfill is caught by the next history poll.
            let history = api::current_history_id(&http, &token()?)?;
            let ids = api::list_ids(&http, &token, &format!("after:{BACKFILL_SINCE} -in:drafts"))?;
            (ids, history)
        }
        Some(start) => match api::added_since(&http, &token, &start) {
            Ok(found) => found,
            Err(ApiError::NotFound) => {
                let since = get_setting(pool, LAST_POLL_KEY)?
                    .and_then(|iso| secs_from_iso(&iso))
                    .map(|s| s.saturating_sub(FALLBACK_OVERLAP.as_secs()))
                    .unwrap_or(BACKFILL_SINCE);
                log::warn!("gmail history id too old; searching since the last poll instead");
                let history = api::current_history_id(&http, &token()?)?;
                (api::list_ids(&http, &token, &format!("after:{since} -in:drafts"))?, history)
            }
            Err(e) => return Err(e.into()),
        },
    };

    // Never fetch the same message twice: drop ids already stored (and
    // duplicates within this batch).
    let stored = stored_ids(pool, &ids)?;
    let mut seen = HashSet::new();
    let todo: Vec<&String> = ids.iter().filter(|id| !stored.contains(*id) && seen.insert(*id)).collect();

    let companies = company_domains(pool)?;
    let mut new_pending = 0u32;
    for id in todo {
        let msg = match api::get_message(&http, &token()?, id) {
            Ok(m) => m,
            // Deleted between listing and fetching: nothing to store.
            Err(ApiError::NotFound) => continue,
            Err(e) => return Err(e.into()),
        };
        if msg.label_ids.iter().any(|l| l == "DRAFT") {
            continue;
        }
        if store(pool, &msg, &companies)? == Stored::Pending {
            new_pending += 1;
        }
    }

    // Only now that everything is stored: move the history id forward and
    // record the poll.
    set_setting(pool, HISTORY_KEY, &next_history)?;
    set_setting(pool, LAST_POLL_KEY, &started)?;
    set_setting(pool, LAST_NEW_KEY, &new_pending.to_string())?;
    log::info!("mail poll: {} fetched, {new_pending} pending", ids.len() - stored.len());
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Stored {
    Pending,
    Ignored,
    AlreadyThere,
}

/// Decode, filter and insert one message. `INSERT OR IGNORE` on the unique
/// `gmail_id` makes a second store of the same message a no-op.
fn store(pool: &SqlitePool, msg: &mime::Message, companies: &[String]) -> Result<Stored, MailError> {
    let d = mime::decode(msg);
    let verdict = filter::classify(
        &filter::Input {
            from: d.from.as_deref(),
            list_unsubscribe: d.list_unsubscribe,
            label_ids: &msg.label_ids,
        },
        companies,
    );
    let (status, reason, outcome) = match verdict {
        filter::Verdict::Pending(r) => ("pending", r, Stored::Pending),
        filter::Verdict::Ignored(r) => ("ignored", r, Stored::Ignored),
    };
    let received = msg
        .internal_date
        .as_deref()
        .and_then(|ms| ms.parse::<u64>().ok())
        .map(|ms| iso_from_secs(ms / 1000));
    let inserted = block_on(
        sqlx::query(
            "INSERT OR IGNORE INTO emails
               (gmail_id, thread_id, from_addr, to_addr, subject, snippet, received_at,
                body_text, label_ids, status, filter_reason, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&msg.id)
        .bind(&msg.thread_id)
        .bind(&d.from)
        .bind(&d.to)
        .bind(&d.subject)
        .bind(&msg.snippet)
        .bind(received)
        .bind(&d.body_text)
        .bind(serde_json::to_string(&msg.label_ids).expect("labels serialize"))
        .bind(status)
        .bind(&reason)
        .bind(now_iso())
        .execute(pool),
    )?
    .rows_affected();
    Ok(if inserted == 0 { Stored::AlreadyThere } else { outcome })
}

/// Which of `ids` are already in `emails`. One query: the ids go in as a
/// JSON array that SQLite's `json_each` unpacks.
fn stored_ids(pool: &SqlitePool, ids: &[String]) -> Result<HashSet<String>, MailError> {
    let json = serde_json::to_string(ids).expect("ids serialize");
    let rows: Vec<String> = block_on(
        sqlx::query_scalar("SELECT gmail_id FROM emails WHERE gmail_id IN (SELECT value FROM json_each(?))")
            .bind(json)
            .fetch_all(pool),
    )?;
    Ok(rows.into_iter().collect())
}

/// Domains of companies the user applied to, for the filter's allow rule:
/// the posting URL's registrable domain (unless it's an ATS or job board,
/// which says nothing about the company), and the company name as
/// `<name>.com`. A heuristic; it only decides whether mail skips the
/// ignore list, and the LLM still sees everything else.
fn company_domains(pool: &SqlitePool) -> Result<Vec<String>, MailError> {
    let rows: Vec<(Option<String>, Option<String>)> = block_on(
        sqlx::query_as(
            "SELECT COALESCE(j.company, a.company), j.url
             FROM applications a LEFT JOIN jobs j ON j.id = a.job_id",
        )
        .fetch_all(pool),
    )?;
    let mut out = HashSet::new();
    for (company, url) in rows {
        if let Some(host) = url.as_deref().and_then(host_of) {
            let reg = filter::registrable(&host);
            if !filter::is_job_board(&reg) {
                out.insert(reg);
            }
        }
        if let Some(name) = company {
            let squashed: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
            if !squashed.is_empty() {
                out.insert(format!("{squashed}.com"));
            }
        }
    }
    Ok(out.into_iter().collect())
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?.split('@').next_back()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

// ── settings + time helpers ───────────────────────────────────────────────

fn get_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>, MailError> {
    Ok(block_on(
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?").bind(key).fetch_optional(pool),
    )?)
}

fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), MailError> {
    block_on(
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(value)
            .execute(pool),
    )?;
    Ok(())
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn now_iso() -> String {
    iso_from_secs(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

/// Unix seconds → `YYYY-MM-DDTHH:MM:SSZ`, the app's timestamp format.
/// Howard Hinnant's days-to-civil algorithm, to avoid a date crate for one
/// conversion.
pub fn iso_from_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// The inverse, for timestamps this app wrote. None if it doesn't parse.
pub fn secs_from_iso(iso: &str) -> Option<u64> {
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn scratch_dir() -> std::path::PathBuf {
        let unique = format!(
            "job-trackwsp-mail-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn iso_round_trip_and_backfill_constant() {
        assert_eq!(iso_from_secs(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_from_secs(BACKFILL_SINCE), "2026-08-01T04:00:00Z");
        assert_eq!(iso_from_secs(951_782_400), "2000-02-29T00:00:00Z"); // leap day
        for s in [0, 951_782_400, BACKFILL_SINCE, 1_790_000_123] {
            assert_eq!(secs_from_iso(&iso_from_secs(s)), Some(s));
        }
        assert_eq!(secs_from_iso("garbage"), None);
    }

    #[test]
    fn store_filters_and_never_duplicates() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        let msg = |file: &str| -> mime::Message {
            let json = match file {
                "gh" => include_str!("testdata/greenhouse_alternative.json"),
                _ => include_str!("testdata/newsletter_html_only.json"),
            };
            serde_json::from_str(json).unwrap()
        };

        assert_eq!(store(&pool, &msg("gh"), &[]).unwrap(), Stored::Pending);
        assert_eq!(store(&pool, &msg("nl"), &[]).unwrap(), Stored::Ignored);
        // Same gmail_id again: nothing new.
        assert_eq!(store(&pool, &msg("gh"), &[]).unwrap(), Stored::AlreadyThere);

        let rows: Vec<(String, String, Option<String>, Option<String>)> = block_on(
            sqlx::query_as("SELECT status, filter_reason, received_at, label_ids FROM emails ORDER BY id")
                .fetch_all(&pool),
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("pending", "ats: greenhouse-mail.io"));
        assert_eq!(rows[0].2.as_deref(), Some("2026-09-21T14:13:20Z"));
        assert_eq!(rows[0].3.as_deref(), Some(r#"["INBOX","CATEGORY_UPDATES"]"#));
        assert_eq!((rows[1].0.as_str(), rows[1].1.as_str()), ("ignored", "newsletter: list-unsubscribe header"));

        let stored = stored_ids(&pool, &["18f0a1b2c3d4e5f6".into(), "unknown".into()]).unwrap();
        assert_eq!(stored, HashSet::from(["18f0a1b2c3d4e5f6".to_string()]));

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn company_domains_from_applications() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        block_on(async {
            sqlx::query(
                "INSERT INTO jobs (job_key, company, title, triple, url) VALUES
                 ('a', 'Robinhood', 't', 'a', 'https://careers.robinhood.com/jobs/1'),
                 ('b', 'Acme Corp', 't', 'b', 'https://boards.greenhouse.io/acme/jobs/2')",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO applications (job_id) SELECT id FROM jobs").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO applications (company) VALUES ('TD Bank')").execute(&pool).await.unwrap();
        });
        let mut d = company_domains(&pool).unwrap();
        d.sort();
        // greenhouse.io is a job board, not Acme's domain.
        assert_eq!(d, ["acmecorp.com", "robinhood.com", "tdbank.com"]);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://Jobs.Acme.com:443/x?y#z").as_deref(), Some("jobs.acme.com"));
        assert_eq!(host_of("not a url"), None);
    }
}
