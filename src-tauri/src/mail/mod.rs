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
    /// A request that isn't allowed (restoring blocked mail, ...).
    Refused(String),
}

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailError::Gmail(e) => write!(f, "{e}"),
            MailError::Api(e) => write!(f, "{e}"),
            MailError::Db(e) => write!(f, "database error: {e}"),
            MailError::Refused(m) => write!(f, "{m}"),
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
    /// Every stored email, whatever its status.
    pub total: u32,
    /// Ignored or blocked (never in INBOX's lists): `total - ignored` is
    /// what INBOX shows.
    pub ignored: u32,
    /// A poll is running right now.
    pub checking: bool,
    /// Emails the LLM has read (JT-15).
    pub parsed: u32,
    /// Pending emails waiting for the LLM.
    pub waiting: u32,
    /// The LLM is working through them right now.
    pub extracting: bool,
    /// Why the last extraction run stopped early (a rejected key), if it
    /// did. Filled in by lib.rs, which owns the extraction state.
    pub extract_error: Option<String>,
    /// No Gemini key stored yet: the UI shows the key input.
    pub needs_key: bool,
}

pub fn status(mail: &MailState, pool: &SqlitePool) -> Result<MailStatus, MailError> {
    Ok(MailStatus {
        last_checked_at: get_setting(pool, LAST_POLL_KEY)?,
        last_new: get_setting(pool, LAST_NEW_KEY)?.and_then(|n| n.parse().ok()).unwrap_or(0),
        total: block_on(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM emails").fetch_one(pool))? as u32,
        checking: mail.running.load(Ordering::SeqCst),
        parsed: count(pool, "SELECT COUNT(*) FROM emails WHERE status = 'extracted'")?,
        waiting: count(pool, "SELECT COUNT(*) FROM emails WHERE status = 'pending'")?,
        ignored: count(pool, "SELECT COUNT(*) FROM emails WHERE status IN ('ignored', 'blocked')")?,
        extracting: false,
        extract_error: None,
        needs_key: false,
    })
}

fn count(pool: &SqlitePool, sql: &'static str) -> Result<u32, MailError> {
    Ok(block_on(sqlx::query_scalar::<_, i64>(sql).fetch_one(pool))? as u32)
}

/// One poll, unless another is running (then this returns at once). With
/// Gmail disconnected, or no client file, it does nothing and isn't an
/// error.
pub fn poll(gmail: &GmailState, mail: &MailState, pool: &SqlitePool, creds: Option<&ClientCredentials>) -> Result<(), MailError> {
    if mail.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Rules first, connected or not: mail already stored is brought in
    // line with the current filter before anything else happens.
    let result = refilter(pool).and_then(|_| match creds {
        Some(creds) => poll_inner(gmail, pool, creds),
        None => Ok(()),
    });
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

    let applied = applied(pool)?;
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
        if store(pool, &msg, &applied)? == Stored::Pending {
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
///
/// Ignored and blocked mail never has its content stored: only who sent
/// it, when, the subject and the reason. If it's restored later, it's
/// fetched from Gmail again (`restore`).
fn store(pool: &SqlitePool, msg: &mime::Message, applied: &filter::Applied) -> Result<Stored, MailError> {
    let d = mime::decode(msg);
    let labels = serde_json::to_string(&msg.label_ids).expect("labels serialize");
    let verdict = filter::classify(
        &filter::Input {
            from: d.from.as_deref(),
            subject: d.subject.as_deref(),
            label_ids: &msg.label_ids,
        },
        applied,
    );
    let keep = matches!(verdict, filter::Verdict::Pending(_));
    // `.then(..)`: Some(value) for pending mail, None (stored as NULL)
    // for ignored and blocked.
    let content = |v: Option<&str>| keep.then(|| v.map(str::to_string)).flatten();
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
        .bind(content(msg.thread_id.as_deref()))
        .bind(&d.from)
        .bind(content(d.to.as_deref()))
        .bind(&d.subject)
        .bind(content(Some(&msg.snippet)))
        .bind(received)
        .bind(content(Some(&d.body_text)))
        .bind(content(Some(&labels)))
        .bind(verdict.status())
        .bind(verdict.reason())
        .bind(now_iso())
        .execute(pool),
    )?
    .rows_affected();
    Ok(match (inserted, keep) {
        (0, _) => Stored::AlreadyThere,
        (_, true) => Stored::Pending,
        (_, false) => Stored::Ignored,
    })
}

/// Counts from one `refilter` pass.
#[derive(Debug, Default, PartialEq)]
pub struct Refiltered {
    /// Pending rows the current rules now ignore or block.
    pub newly_filtered: u32,
    /// Ignored rows the current rules now block.
    pub newly_blocked: u32,
    /// Rows whose content was cleared in this pass.
    pub scrubbed: u32,
}

/// Re-applies the current filter to mail already stored, so a rule added
/// after mail arrived still applies to it. Runs on app start (connected or
/// not) and before every poll.
///
/// - pending rows are re-classified from what's stored (sender, subject,
///   labels).
/// - ignored rows only move to blocked: there's not enough left of them
///   to re-check anything else, and restoring is `restore`'s job.
/// - every ignored or blocked row has its content cleared. Idempotent.
///
/// The database runs with `secure_delete` (see `db::connect`), so cleared
/// text is overwritten in the file, and the WAL is truncated after any
/// clearing so old copies don't linger there either.
pub fn refilter(pool: &SqlitePool) -> Result<Refiltered, MailError> {
    let mut out = Refiltered::default();
    let applied = applied(pool)?;

    type Row = (i64, Option<String>, Option<String>, Option<String>);
    let pending: Vec<Row> = block_on(
        sqlx::query_as("SELECT id, from_addr, subject, label_ids FROM emails WHERE status = 'pending'").fetch_all(pool),
    )?;
    for (id, from, subject, labels) in pending {
        let labels: Vec<String> = labels.and_then(|l| serde_json::from_str(&l).ok()).unwrap_or_default();
        let verdict = filter::classify(
            &filter::Input {
                from: from.as_deref(),
                subject: subject.as_deref(),
                label_ids: &labels,
            },
            &applied,
        );
        if !matches!(verdict, filter::Verdict::Pending(_)) {
            set_verdict(pool, id, &verdict)?;
            out.newly_filtered += 1;
        }
    }

    let ignored: Vec<(i64, Option<String>)> =
        block_on(sqlx::query_as("SELECT id, from_addr FROM emails WHERE status = 'ignored'").fetch_all(pool))?;
    for (id, from) in ignored {
        let verdict = filter::classify(
            &filter::Input {
                from: from.as_deref(),
                subject: None,
                label_ids: &[],
            },
            &filter::Applied::default(),
        );
        if matches!(verdict, filter::Verdict::Blocked(_)) {
            set_verdict(pool, id, &verdict)?;
            out.newly_blocked += 1;
        }
    }

    out.scrubbed = block_on(
        sqlx::query(
            "UPDATE emails
             SET thread_id = NULL, to_addr = NULL, snippet = NULL, body_text = NULL, label_ids = NULL
             WHERE status IN ('ignored', 'blocked')
               AND (thread_id IS NOT NULL OR to_addr IS NOT NULL OR snippet IS NOT NULL
                    OR body_text IS NOT NULL OR label_ids IS NOT NULL)",
        )
        .execute(pool),
    )?
    .rows_affected() as u32;

    if out.scrubbed > 0 {
        block_on(sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(pool))?;
        log::info!(
            "mail refilter: {} newly filtered, {} newly blocked, {} cleared",
            out.newly_filtered,
            out.newly_blocked,
            out.scrubbed
        );
    }
    Ok(out)
}

fn set_verdict(pool: &SqlitePool, id: i64, verdict: &filter::Verdict) -> Result<(), MailError> {
    block_on(
        sqlx::query("UPDATE emails SET status = ?, filter_reason = ? WHERE id = ?")
            .bind(verdict.status())
            .bind(verdict.reason())
            .bind(id)
            .execute(pool),
    )?;
    Ok(())
}

/// Un-ignores one email: fetches it from Gmail again by `gmail_id` (its
/// content was cleared when it was ignored) and stores it as pending.
/// Blocked mail can't be restored. For JT-18's "recover" action.
pub fn restore(gmail_state: &GmailState, pool: &SqlitePool, creds: &ClientCredentials, gmail_id: &str) -> Result<(), MailError> {
    let status: Option<String> = block_on(
        sqlx::query_scalar("SELECT status FROM emails WHERE gmail_id = ?")
            .bind(gmail_id)
            .fetch_optional(pool),
    )?;
    match status.as_deref() {
        Some("ignored") => {}
        Some("blocked") => return Err(MailError::Refused("blocked mail can't be restored".into())),
        Some(_) => return Ok(()), // already pending (or further along)
        None => return Err(MailError::Refused(format!("no stored email {gmail_id}"))),
    }
    let token = gmail::access_token(gmail_state, pool, creds).map_err(MailError::Gmail)?;
    let http = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| ApiError::Http(e.to_string()))?;
    let msg = api::get_message(&http, token.secret(), gmail_id)?;
    apply_restore(pool, &msg)
}

/// The DB half of `restore`, split out so it can be tested without Gmail.
/// Re-checks the block list on the fresh copy: a restore never un-blocks.
fn apply_restore(pool: &SqlitePool, msg: &mime::Message) -> Result<(), MailError> {
    let d = mime::decode(msg);
    let verdict = filter::classify(
        &filter::Input {
            from: d.from.as_deref(),
            subject: d.subject.as_deref(),
            label_ids: &[],
        },
        &filter::Applied::default(),
    );
    if matches!(verdict, filter::Verdict::Blocked(_)) {
        return Err(MailError::Refused("blocked mail can't be restored".into()));
    }
    block_on(
        sqlx::query(
            "UPDATE emails
             SET thread_id = ?, to_addr = ?, snippet = ?, body_text = ?, label_ids = ?,
                 status = 'pending', filter_reason = 'restored by you', fetched_at = ?
             WHERE gmail_id = ?",
        )
        .bind(&msg.thread_id)
        .bind(&d.to)
        .bind(&msg.snippet)
        .bind(&d.body_text)
        .bind(serde_json::to_string(&msg.label_ids).expect("labels serialize"))
        .bind(now_iso())
        .bind(&msg.id)
        .execute(pool),
    )?;
    Ok(())
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

/// What the filter's application-mail rule knows. Domains of companies
/// the user applied to: the posting URL's registrable domain (unless it's
/// an ATS or job board, which says nothing about the company), and the
/// company name as `<name>.com`. A heuristic; it only decides whether
/// mail skips the ignore list, and the LLM still sees everything else.
/// Plus the req ids of those postings.
fn applied(pool: &SqlitePool) -> Result<filter::Applied, MailError> {
    let rows: Vec<(Option<String>, Option<String>, Option<String>)> = block_on(
        sqlx::query_as(
            "SELECT COALESCE(j.company, a.company), j.url, j.req_id
             FROM applications a LEFT JOIN jobs j ON j.id = a.job_id",
        )
        .fetch_all(pool),
    )?;
    let mut out = HashSet::new();
    let mut reqs = HashSet::new();
    for (company, url, req) in rows {
        // Very short ids would match too much of an unrelated subject.
        if let Some(r) = req.map(|r| r.trim().to_lowercase()).filter(|r| r.len() >= 4) {
            reqs.insert(r);
        }
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
    Ok(filter::Applied {
        domains: out.into_iter().collect(),
        req_ids: reqs.into_iter().collect(),
    })
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

        let none = filter::Applied::default();
        // A List-Unsubscribe header alone no longer ignores (JT-18), so
        // the newsletter is marked sent to exercise the ignored path.
        let mut nl = msg("nl");
        nl.label_ids.push("SENT".into());
        assert_eq!(store(&pool, &msg("gh"), &none).unwrap(), Stored::Pending);
        assert_eq!(store(&pool, &nl, &none).unwrap(), Stored::Ignored);
        // Same gmail_id again: nothing new.
        assert_eq!(store(&pool, &msg("gh"), &none).unwrap(), Stored::AlreadyThere);

        let rows: Vec<(String, String, Option<String>, Option<String>)> = block_on(
            sqlx::query_as("SELECT status, filter_reason, received_at, label_ids FROM emails ORDER BY id")
                .fetch_all(&pool),
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("pending", "ats: greenhouse-mail.io"));
        assert_eq!(rows[0].2.as_deref(), Some("2026-09-21T14:13:20Z"));
        assert_eq!(rows[0].3.as_deref(), Some(r#"["INBOX","CATEGORY_UPDATES"]"#));
        assert_eq!((rows[1].0.as_str(), rows[1].1.as_str()), ("ignored", "sent by you"));
        // The ignored one was stored without its content.
        assert_eq!(rows[1].3, None);
        let (body, snippet, subject): (Option<String>, Option<String>, Option<String>) = block_on(
            sqlx::query_as("SELECT body_text, snippet, subject FROM emails WHERE status = 'ignored'").fetch_one(&pool),
        )
        .unwrap();
        assert_eq!((body, snippet), (None, None));
        assert_eq!(subject.as_deref(), Some("This week in tech"));

        let stored = stored_ids(&pool, &["18f0a1b2c3d4e5f6".into(), "unknown".into()]).unwrap();
        assert_eq!(stored, HashSet::from(["18f0a1b2c3d4e5f6".to_string()]));

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Inserts a pending row the way the old (pre-block) code stored it:
    /// with its full content.
    fn insert_pending(pool: &SqlitePool, gmail_id: &str, from: &str) {
        block_on(
            sqlx::query(
                "INSERT INTO emails (gmail_id, thread_id, from_addr, to_addr, subject, snippet,
                                     body_text, label_ids, status, filter_reason)
                 VALUES (?, 't', ?, 'me@example.com', 'subject', 'snippet', 'private body',
                         '[\"INBOX\"]', 'pending', 'no rule matched')",
            )
            .bind(gmail_id)
            .bind(from)
            .execute(pool),
        )
        .unwrap();
    }

    #[test]
    fn refilter_blocks_and_clears_existing_rows() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        insert_pending(&pool, "ams1", "Shift Lead <lead@ams.queensu.ca>");
        insert_pending(&pool, "ms1", "account-security-noreply@accountprotection.microsoft.com");
        insert_pending(&pool, "ok1", "Jane <jane@startup.example.com>");
        // Already ignored under an old rule, content still there.
        insert_pending(&pool, "ams2", "x@ams.queensu.ca");
        block_on(sqlx::query("UPDATE emails SET status = 'ignored' WHERE gmail_id = 'ams2'").execute(&pool)).unwrap();

        let r = refilter(&pool).unwrap();
        assert_eq!(
            r,
            Refiltered {
                newly_filtered: 2,
                newly_blocked: 1,
                scrubbed: 3
            }
        );

        // gmail_id, status, filter_reason, body_text, snippet, label_ids
        type Row = (String, String, String, Option<String>, Option<String>, Option<String>);
        let rows: Vec<Row> = block_on(
            sqlx::query_as(
                "SELECT gmail_id, status, filter_reason, body_text, snippet, label_ids FROM emails ORDER BY gmail_id",
            )
            .fetch_all(&pool),
        )
        .unwrap();
        let get = |id: &str| rows.iter().find(|r| r.0 == id).unwrap().clone();
        assert_eq!(get("ams1").1, "blocked");
        assert_eq!(get("ams1").2, "blocked domain: ams.queensu.ca");
        assert_eq!(get("ams2").1, "blocked");
        assert_eq!(get("ms1").1, "ignored");
        for id in ["ams1", "ams2", "ms1"] {
            let r = get(id);
            assert_eq!((r.3, r.4, r.5), (None, None, None), "{id} still has content");
        }
        // The legitimate one is untouched.
        assert_eq!(get("ok1").1, "pending");
        assert_eq!(get("ok1").3.as_deref(), Some("private body"));

        // Idempotent.
        assert_eq!(refilter(&pool).unwrap(), Refiltered::default());

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_refetches_but_never_unblocks() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        let gh: mime::Message = serde_json::from_str(include_str!("testdata/greenhouse_alternative.json")).unwrap();
        // Stored ignored with content cleared, as `store` would.
        block_on(
            sqlx::query(
                "INSERT INTO emails (gmail_id, from_addr, subject, status, filter_reason)
                 VALUES (?, 'x@us.greenhouse-mail.io', 'Thank you', 'ignored', 'sent by you')",
            )
            .bind(&gh.id)
            .execute(&pool),
        )
        .unwrap();
        apply_restore(&pool, &gh).unwrap();
        let (status, body): (String, Option<String>) =
            block_on(sqlx::query_as("SELECT status, body_text FROM emails WHERE gmail_id = ?").bind(&gh.id).fetch_one(&pool))
                .unwrap();
        assert_eq!(status, "pending");
        assert!(body.unwrap().starts_with("Hi Sam,"));

        // A fresh copy that turns out to be from a blocked sender is refused.
        let mut blocked = gh;
        blocked.payload.as_mut().unwrap().headers[0].value = "lead@ams.queensu.ca".into();
        assert!(matches!(apply_restore(&pool, &blocked), Err(MailError::Refused(_))));

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn applied_from_applications() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        block_on(async {
            sqlx::query(
                "INSERT INTO jobs (job_key, company, title, triple, url, req_id) VALUES
                 ('a', 'Robinhood', 't', 'a', 'https://careers.robinhood.com/jobs/1', ' 8142930 '),
                 ('b', 'Acme Corp', 't', 'b', 'https://boards.greenhouse.io/acme/jobs/2', '12')",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO applications (job_id) SELECT id FROM jobs").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO applications (company) VALUES ('TD Bank')").execute(&pool).await.unwrap();
        });
        let a = applied(&pool).unwrap();
        let mut d = a.domains;
        d.sort();
        // greenhouse.io is a job board, not Acme's domain.
        assert_eq!(d, ["acmecorp.com", "robinhood.com", "tdbank.com"]);
        // Trimmed; "12" is too short to trust in a subject.
        assert_eq!(a.req_ids, ["8142930"]);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://Jobs.Acme.com:443/x?y#z").as_deref(), Some("jobs.acme.com"));
        assert_eq!(host_of("not a url"), None);
    }
}
