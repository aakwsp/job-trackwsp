//! Read side of `jobs` for the list view, plus the user's "applied" toggle
//! and notes.
//!
//! Nothing here writes to `jobs` — that table is owned by the sync. Applied
//! state lives in `applications` (CLAUDE.md, "Data model"). A note lives in
//! `job_notes` until the posting is applied, then in `applications.notes`.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// `settings` key holding the JOBS sort (JT-39), e.g. "deadline".
pub const SORT_KEY: &str = "jobs_sort";
/// Days ahead that count as "closing soon" (the frontend's
/// `CLOSING_SOON_DAYS`; the pink stripe).
pub const CLOSING_SOON_DAYS: i64 = 7;

/// The JOBS toolbar's sort (JT-39). Sorting is here, not in React: the
/// frontend buckets the sorted list into hub sections and keeps this order
/// inside each, so a posting in two hubs sorts the same way in both.
/// Every key ends on company, title (case-insensitive), then id, so the
/// order is stable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobSort {
    /// Upcoming deadlines soonest first, then rolling (no deadline), then
    /// past due (most recently expired first); same tier and date: the most
    /// recently seen first. The order JOBS always had, so the default.
    #[default]
    Deadline,
    /// `first_seen` newest first; none last.
    FirstSeen,
    /// `last_seen` (the sheet's last sighting) newest first; none last.
    LastSeen,
    /// Company A–Z.
    Company,
    /// The card stripes' order: closing soon (≤ 7 days, not applied) →
    /// applied → has deadline → rolling → past due or rejected.
    Status,
}

impl JobSort {
    fn from_setting(v: &str) -> Option<JobSort> {
        serde_json::from_value(serde_json::Value::String(v.into())).ok()
    }
    fn as_setting(self) -> String {
        serde_json::to_value(self).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }
}

/// One row of the list view. Field names cross the invoke bridge as-is, so
/// they must match the `Job` type in `frontend/src/types.ts`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct JobRow {
    pub id: i64,
    pub company: String,
    pub title: String,
    pub city: Option<String>,
    pub req_id: Option<String>,
    pub url: Option<String>,
    pub deadline: Option<String>,
    pub posting_status: String,
    pub borderline: bool,
    pub borderline_reason: Option<String>,
    pub source: Option<String>,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    /// When the posting disappeared from the sheet (JT-26); None while it's
    /// listed. Removed rows are still returned: JOBS hides them with a
    /// filter, and PIPELINE's record needs them.
    pub removed_at: Option<String>,
    pub applied: bool,
    /// `applications.applied_at`, full ISO timestamp; None when not applied.
    pub applied_at: Option<String>,
    /// `applications.status` (applied, interview, rejected, ...); None when
    /// not applied. The list flags rejected postings with it.
    pub app_status: Option<String>,
    /// From `applications.notes` when applied, else `job_notes.body`.
    pub notes: Option<String>,
    /// The places `city` names (JT-38, `job_cities`), in the posting's
    /// order: what a card shows.
    #[sqlx(skip)]
    pub cities: Vec<String>,
    /// Their hubs (`cities::hubs_of`): the JOBS sections it appears in.
    #[sqlx(skip)]
    pub hubs: Vec<String>,
}

#[derive(Debug)]
pub enum JobsError {
    Db(sqlx::Error),
    /// Un-applying would delete an application that has moved past
    /// `applied` (assessment, interview, ...) along with its timeline.
    ApplicationInProgress(String),
    BadUrl(String),
    Open(String),
    /// No application with this id.
    NotFound(i64),
    /// A pipeline move that doesn't apply from the current state (next stage
    /// after an offer, rejecting something already closed, ...).
    BadTransition(String),
}

impl std::fmt::Display for JobsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobsError::Db(e) => write!(f, "database error: {e}"),
            JobsError::ApplicationInProgress(status) => write!(
                f,
                "application is already at '{status}' — not removing it from the list view"
            ),
            JobsError::BadUrl(u) => write!(f, "refusing to open non-http(s) url: {u}"),
            JobsError::Open(e) => write!(f, "could not open browser: {e}"),
            JobsError::NotFound(id) => write!(f, "no application with id {id}"),
            JobsError::BadTransition(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for JobsError {}

// Same as `SyncError`: the frontend only needs the message.
impl Serialize for JobsError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<sqlx::Error> for JobsError {
    fn from(e: sqlx::Error) -> Self {
        JobsError::Db(e)
    }
}

/// Every non-hidden job in the default order (`JobSort::Deadline`). Tests
/// only; the app goes through `list_sorted`.
#[cfg(test)]
pub async fn list(pool: &SqlitePool) -> Result<Vec<JobRow>, JobsError> {
    list_sorted(pool, JobSort::default()).await
}

/// The stored JOBS sort, or the default when none is saved (or it's not a
/// known key).
pub async fn stored_sort(pool: &SqlitePool) -> Result<JobSort, JobsError> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?").bind(SORT_KEY).fetch_optional(pool).await?;
    Ok(v.as_deref().and_then(JobSort::from_setting).unwrap_or_default())
}

/// Remembers the JOBS sort (a plain `settings` key, no migration).
pub async fn save_sort(pool: &SqlitePool, sort: JobSort) -> Result<(), JobsError> {
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(SORT_KEY)
        .bind(sort.as_setting())
        .execute(pool)
        .await?;
    Ok(())
}

/// Every non-hidden job, sorted by `sort` (see `sort_jobs`). "Today" is
/// the local date from SQLite, matching the frontend's `daysLeft`.
pub async fn list_sorted(pool: &SqlitePool, sort: JobSort) -> Result<Vec<JobRow>, JobsError> {
    let rows = sqlx::query_as::<_, JobRow>(
        "SELECT j.id, j.company, j.title, j.city, j.req_id, j.url, j.deadline,
                j.posting_status, j.borderline, j.borderline_reason, j.source,
                j.first_seen, j.last_seen, j.removed_at,
                a.id IS NOT NULL AS applied, a.applied_at, a.status AS app_status,
                COALESCE(a.notes, n.body) AS notes
         FROM jobs j
         -- at most one application per job (set_applied never makes a second)
         LEFT JOIN applications a ON a.job_id = j.id
         LEFT JOIN job_notes n ON n.job_id = j.id
         WHERE j.hidden = 0",
    )
    .fetch_all(pool)
    .await?;
    let mut rows = rows;
    let pairs: Vec<(i64, String)> = sqlx::query_as("SELECT job_id, city FROM job_cities ORDER BY job_id, position").fetch_all(pool).await?;
    let mut by_job: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    for (id, city) in pairs {
        by_job.entry(id).or_default().push(city);
    }
    for r in &mut rows {
        r.cities = by_job.remove(&r.id).unwrap_or_default();
        r.hubs = crate::cities::hubs_of(&r.cities);
    }
    let (today, soon): (String, String) = sqlx::query_as("SELECT date('now', 'localtime'), date('now', 'localtime', ?)")
        .bind(format!("+{CLOSING_SOON_DAYS} days"))
        .fetch_one(pool)
        .await?;
    sort_jobs(&mut rows, sort, &today, &soon);
    Ok(rows)
}

/// Sorts in place. `today` and `soon` (today + `CLOSING_SOON_DAYS`) are
/// 'YYYY-MM-DD'; dates compare as text, which sorts correctly.
pub fn sort_jobs(rows: &mut [JobRow], sort: JobSort, today: &str, soon: &str) {
    // Newest first, none last.
    let newest = |a: &Option<String>, b: &Option<String>| match (a, b) {
        (Some(a), Some(b)) => b.cmp(a),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    };
    let names = |a: &JobRow, b: &JobRow| {
        a.company
            .to_lowercase()
            .cmp(&b.company.to_lowercase())
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then(a.id.cmp(&b.id))
    };
    // Deadline tiers: 0 upcoming (today counts), 1 rolling, 2 past due.
    let tier = |r: &JobRow| match r.deadline.as_deref() {
        Some(d) if d >= today => 0,
        None => 1,
        Some(_) => 2,
    };
    // The stripe order (`statusOf` in lib/jobs.ts, with rejected last).
    let rank = |r: &JobRow| {
        let d = r.deadline.as_deref();
        if r.app_status.as_deref() == Some("rejected") {
            4
        } else if r.applied {
            1
        } else if d.is_some_and(|d| d >= today && d <= soon) {
            0
        } else if d.is_some_and(|d| d < today) {
            4
        } else if d.is_some() {
            2
        } else {
            3
        }
    };
    rows.sort_by(|a, b| {
        let first = match sort {
            JobSort::Deadline => tier(a).cmp(&tier(b)).then_with(|| match tier(a) {
                0 => a.deadline.cmp(&b.deadline),
                2 => b.deadline.cmp(&a.deadline),
                _ => Ordering::Equal,
            })
            .then_with(|| newest(&a.last_seen, &b.last_seen)),
            JobSort::FirstSeen => newest(&a.first_seen, &b.first_seen),
            JobSort::LastSeen => newest(&a.last_seen, &b.last_seen),
            JobSort::Company => Ordering::Equal,
            JobSort::Status => rank(a).cmp(&rank(b)),
        };
        first.then_with(|| names(a, b))
    });
}

/// Creates (with an `applied` event) or removes the application for
/// `job_id`. Idempotent in both directions. The posting's note moves with it:
/// into `applications.notes` on apply, back to `job_notes` on undo.
pub async fn set_applied(pool: &SqlitePool, job_id: i64, applied: bool) -> Result<(), JobsError> {
    set_applied_at(pool, job_id, applied, None).await
}

/// `set_applied`, with the applied date given (a full ISO timestamp)
/// instead of now: for recording an application after the fact, dated when
/// it really happened (e.g. the confirmation email's date). Same
/// transaction, same note handling, one `applied` event at that time.
pub async fn set_applied_at(
    pool: &SqlitePool,
    job_id: i64,
    applied: bool,
    applied_at: Option<&str>,
) -> Result<(), JobsError> {
    let mut tx = pool.begin().await?;

    let existing: Option<(i64, String)> =
        sqlx::query_as("SELECT id, status FROM applications WHERE job_id = ? LIMIT 1")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await?;

    match (applied, existing) {
        (true, None) => {
            let app_id: i64 = sqlx::query_scalar(
                "INSERT INTO applications (job_id, status, applied_at, notes)
                 VALUES (?, 'applied', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                         (SELECT body FROM job_notes WHERE job_id = ?))
                 RETURNING id",
            )
            .bind(job_id)
            .bind(applied_at)
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM job_notes WHERE job_id = ?")
                .bind(job_id)
                .execute(&mut *tx)
                .await?;
            // The timeline is the source of truth for `status`, so the
            // application starts with the event that put it there.
            sqlx::query(
                "INSERT INTO application_events (application_id, type, occurred_at, origin)
                 VALUES (?, 'applied', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), 'manual')",
            )
            .bind(app_id)
            .bind(applied_at)
            .execute(&mut *tx)
            .await?;
        }
        (false, Some((_, status))) if status != "applied" => {
            return Err(JobsError::ApplicationInProgress(status));
        }
        (false, Some((app_id, _))) => {
            // Still 'applied', but with more than its first event (say it
            // advanced and was undone back): deleting the application would
            // delete that history too, so refuse the same way.
            let events: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM application_events WHERE application_id = ?",
            )
            .bind(app_id)
            .fetch_one(&mut *tx)
            .await?;
            if events > 1 {
                return Err(JobsError::ApplicationInProgress("applied, with later events".into()));
            }
            sqlx::query(
                "INSERT INTO job_notes (job_id, body)
                 SELECT job_id, notes FROM applications
                 WHERE job_id = ? AND notes IS NOT NULL",
            )
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
            // Events go with it via ON DELETE CASCADE.
            sqlx::query("DELETE FROM applications WHERE job_id = ?")
                .bind(job_id)
                .execute(&mut *tx)
                .await?;
        }
        (true, Some(_)) | (false, None) => {}
    }

    tx.commit().await?;
    Ok(())
}

/// Saves the note for `job_id` wherever it currently lives (see the module
/// doc). Blank clears it.
pub async fn save_notes(pool: &SqlitePool, job_id: i64, body: &str) -> Result<(), JobsError> {
    let body = Some(body.trim()).filter(|b| !b.is_empty());
    let mut tx = pool.begin().await?;

    let applied = sqlx::query(
        "UPDATE applications
         SET notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE job_id = ?",
    )
    .bind(body)
    .bind(job_id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;

    if !applied {
        match body {
            Some(body) => {
                sqlx::query(
                    "INSERT INTO job_notes (job_id, body) VALUES (?, ?)
                     ON CONFLICT (job_id) DO UPDATE
                     SET body = excluded.body,
                         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
                )
                .bind(job_id)
                .bind(body)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query("DELETE FROM job_notes WHERE job_id = ?")
                    .bind(job_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }

    tx.commit().await?;
    Ok(())
}

/// Only http(s): the URL comes from the sheet, and handing the OS opener a
/// `file://` or custom-scheme link from scraped data isn't something we want.
pub fn check_url(url: &str) -> Result<(), JobsError> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Ok(())
    } else {
        Err(JobsError::BadUrl(url.to_string()))
    }
}

#[cfg(test)]
mod tests {

    // ── JT-39 sort ───────────────────────────────────────────────────────

    const TODAY: &str = "2026-10-16";
    const SOON: &str = "2026-10-23";

    fn row(id: i64, company: &str, title: &str) -> JobRow {
        JobRow {
            id,
            company: company.into(),
            title: title.into(),
            city: None,
            req_id: None,
            url: None,
            deadline: None,
            posting_status: "open".into(),
            borderline: false,
            borderline_reason: None,
            source: None,
            first_seen: None,
            last_seen: None,
            removed_at: None,
            applied: false,
            applied_at: None,
            app_status: None,
            notes: None,
            cities: vec![],
            hubs: vec![],
        }
    }

    fn dated(id: i64, company: &str, deadline: Option<&str>) -> JobRow {
        JobRow { deadline: deadline.map(str::to_string), ..row(id, company, "intern") }
    }

    fn order(mut rows: Vec<JobRow>, sort: JobSort) -> Vec<i64> {
        sort_jobs(&mut rows, sort, TODAY, SOON);
        rows.iter().map(|r| r.id).collect()
    }

    #[test]
    fn deadline_sort_upcoming_then_rolling_then_past_due() {
        let rows = vec![
            dated(1, "a", None),                 // rolling
            dated(2, "b", Some("2026-10-01")),   // past due, older
            dated(3, "c", Some("2026-11-30")),   // upcoming, later
            dated(4, "d", Some(TODAY)),          // due today: still upcoming
            dated(5, "e", Some("2026-10-10")),   // past due, more recent
            dated(6, "f", Some("2026-10-20")),   // upcoming, sooner
        ];
        assert_eq!(order(rows, JobSort::Deadline), [4, 6, 3, 1, 5, 2]);
        // Same tier and date: most recently seen first (today's order).
        let mut x = dated(7, "x", None);
        x.last_seen = Some("2026-10-01".into());
        let mut y = dated(8, "y", None);
        y.last_seen = Some("2026-10-15".into());
        assert_eq!(order(vec![x, y], JobSort::Deadline), [8, 7]);
    }

    #[test]
    fn first_and_last_seen_newest_first_none_last() {
        let mk = |id, d: Option<&str>| JobRow { first_seen: d.map(str::to_string), last_seen: d.map(str::to_string), ..row(id, "co", "t") };
        let rows = || vec![mk(1, Some("2026-09-01")), mk(2, None), mk(3, Some("2026-10-01"))];
        assert_eq!(order(rows(), JobSort::FirstSeen), [3, 1, 2]);
        assert_eq!(order(rows(), JobSort::LastSeen), [3, 1, 2]);
        // Only first_seen differs: last seen ignores it.
        let a = JobRow { first_seen: Some("2026-10-01".into()), last_seen: Some("2026-09-01".into()), ..row(1, "a", "t") };
        let b = JobRow { first_seen: Some("2026-09-01".into()), last_seen: Some("2026-10-01".into()), ..row(2, "b", "t") };
        assert_eq!(order(vec![a.clone(), b.clone()], JobSort::FirstSeen), [1, 2]);
        assert_eq!(order(vec![a, b], JobSort::LastSeen), [2, 1]);
    }

    #[test]
    fn company_sort_is_a_to_z_ignoring_case() {
        let rows = vec![row(1, "Zeta", "t"), row(2, "amd", "t"), row(3, "Google", "t")];
        assert_eq!(order(rows, JobSort::Company), [2, 3, 1]);
    }

    #[test]
    fn status_sort_follows_the_stripes() {
        let closing = dated(1, "a", Some("2026-10-20"));
        let applied = JobRow { applied: true, app_status: Some("interview".into()), ..dated(2, "b", Some("2026-10-01")) };
        let has_deadline = dated(3, "c", Some("2026-12-01"));
        let rolling = dated(4, "d", None);
        let past_due = dated(5, "e", Some("2026-10-01"));
        let rejected = JobRow { applied: true, app_status: Some("rejected".into()), ..dated(6, "f", None) };
        // A closing-soon posting you applied to is applied, not urgent.
        let applied_soon = JobRow { applied: true, ..dated(7, "g", Some("2026-10-18")) };
        let rows = vec![rejected, rolling, past_due, has_deadline, applied, closing, applied_soon];
        assert_eq!(order(rows, JobSort::Status), [1, 2, 7, 3, 4, 5, 6]);
    }

    #[test]
    fn ties_break_on_company_then_title_then_id() {
        let rows = vec![row(3, "Acme", "Backend"), row(1, "acme", "API"), row(2, "Acme", "Backend"), row(4, "Beta", "API")];
        // Everything ties on the key itself under status (all rolling).
        assert_eq!(order(rows.clone(), JobSort::Status), [1, 2, 3, 4]);
        assert_eq!(order(rows.clone(), JobSort::Deadline), [1, 2, 3, 4]);
        assert_eq!(order(rows, JobSort::FirstSeen), [1, 2, 3, 4]);
    }

    #[test]
    fn the_sort_is_remembered_in_settings() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).unwrap();
        tauri::async_runtime::block_on(async {
            assert_eq!(stored_sort(&pool).await.unwrap(), JobSort::Deadline); // nothing saved
            save_sort(&pool, JobSort::FirstSeen).await.unwrap();
            assert_eq!(stored_sort(&pool).await.unwrap(), JobSort::FirstSeen);
            let raw: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'jobs_sort'").fetch_one(&pool).await.unwrap();
            assert_eq!(raw, "first_seen");
            // Something unknown falls back to the default.
            sqlx::query("UPDATE settings SET value = 'nonsense' WHERE key = 'jobs_sort'").execute(&pool).await.unwrap();
            assert_eq!(stored_sort(&pool).await.unwrap(), JobSort::Deadline);
        });
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_posting_in_two_hubs_sorts_the_same_in_each() {
        // The frontend buckets the sorted list by hub, keeping this order.
        let hubbed = |id, company: &str, deadline: &str, raw: &str| {
            let cities = crate::cities::parse(raw);
            JobRow { hubs: crate::cities::hubs_of(&cities), cities, city: Some(raw.into()), ..dated(id, company, Some(deadline)) }
        };
        let mut rows = vec![
            hubbed(1, "a", "2026-11-30", "Toronto"),
            hubbed(2, "b", "2026-10-20", "Waterloo or Toronto"),
            hubbed(3, "c", "2026-11-01", "Waterloo"),
            hubbed(4, "d", "2026-10-25", "Markham"),
        ];
        sort_jobs(&mut rows, JobSort::Deadline, TODAY, SOON);
        let section = |hub: &str| rows.iter().filter(|r| r.hubs.iter().any(|h| h == hub)).map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(section("gta"), [2, 4, 1]);
        assert_eq!(section("kw"), [2, 3]);
        // First in both: same sort, same place.
    }
    use super::*;
    use crate::db;

    fn scratch_dir() -> std::path::PathBuf {
        let unique = format!(
            "job-trackwsp-jobs-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn list_sorts_and_set_applied_round_trips() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        tauri::async_runtime::block_on(async {
            for (key, deadline, last_seen, hidden) in [
                ("a", None, "2026-10-01", 0),
                ("b", Some("2999-10-20"), "2026-09-01", 0),
                ("c", None, "2026-10-05", 0),
                ("d", Some("2999-10-10"), "2026-09-01", 0),
                ("e", Some("2001-10-01"), "2026-09-01", 1),
                ("f", Some("2001-01-01"), "2026-09-01", 0),
                ("g", Some("2001-06-01"), "2026-09-01", 0),
            ] {
                sqlx::query(
                    "INSERT INTO jobs (job_key, company, title, triple, deadline, last_seen, hidden)
                     VALUES (?, 'co', ?, ?, ?, ?, ?)",
                )
                .bind(key)
                .bind(key)
                .bind(key)
                .bind(deadline)
                .bind(last_seen)
                .bind(hidden)
                .execute(&pool)
                .await
                .unwrap();
            }

            let titles: Vec<String> = list(&pool)
                .await
                .unwrap()
                .into_iter()
                .map(|j| j.title)
                .collect();
            // upcoming asc, then rolling by last_seen, then past due desc; e hidden
            assert_eq!(titles, ["d", "b", "c", "a", "g", "f"]);

            let id = list(&pool).await.unwrap()[0].id;
            set_applied(&pool, id, true).await.unwrap();
            set_applied(&pool, id, true).await.unwrap(); // idempotent
            assert!(list(&pool).await.unwrap()[0].applied);
            let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM application_events")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(events, 1);

            set_applied(&pool, id, false).await.unwrap();
            assert!(!list(&pool).await.unwrap()[0].applied);

            // Past 'applied' → refuse to delete.
            set_applied(&pool, id, true).await.unwrap();
            sqlx::query("UPDATE applications SET status = 'interview'")
                .execute(&pool)
                .await
                .unwrap();
            assert!(matches!(
                set_applied(&pool, id, false).await,
                Err(JobsError::ApplicationInProgress(_))
            ));

            // Back at 'applied' but with history: still refused.
            sqlx::query("UPDATE applications SET status = 'applied'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO application_events (application_id, type, occurred_at)
                 SELECT id, 'applied', '2026-01-01T00:00:00Z' FROM applications",
            )
            .execute(&pool)
            .await
            .unwrap();
            assert!(matches!(
                set_applied(&pool, id, false).await,
                Err(JobsError::ApplicationInProgress(_))
            ));
        });

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Applied state lives only in SQLite, so "survives a restart" means it
    /// survives closing the pool and opening a fresh one on the same file.
    #[test]
    fn applied_survives_reopen() {
        let dir = scratch_dir();
        let id = tauri::async_runtime::block_on(async {
            let pool = db::connect(&dir).await.unwrap();
            sqlx::query(
                "INSERT INTO jobs (job_key, company, title, triple) VALUES ('k', 'co', 't', 'k')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let id = list(&pool).await.unwrap()[0].id;
            set_applied(&pool, id, true).await.unwrap();
            pool.close().await;
            id
        });

        let reopened = tauri::async_runtime::block_on(async {
            let pool = db::connect(&dir).await.unwrap();
            let jobs = list(&pool).await.unwrap();
            pool.close().await;
            jobs
        });
        assert_eq!(reopened[0].id, id);
        assert!(reopened[0].applied);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_follow_the_application() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        tauri::async_runtime::block_on(async {
            sqlx::query(
                "INSERT INTO jobs (job_key, company, title, triple) VALUES ('k', 'co', 't', 'k')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let id = list(&pool).await.unwrap()[0].id;
            let note = |pool: &SqlitePool| {
                let pool = pool.clone();
                async move { list(&pool).await.unwrap()[0].notes.clone() }
            };

            save_notes(&pool, id, "  ask about the term  ").await.unwrap();
            assert_eq!(note(&pool).await.as_deref(), Some("ask about the term"));

            set_applied(&pool, id, true).await.unwrap();
            assert_eq!(note(&pool).await.as_deref(), Some("ask about the term"));
            let in_job_notes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM job_notes")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(in_job_notes, 0);
            assert!(list(&pool).await.unwrap()[0].applied_at.is_some());

            save_notes(&pool, id, "no referral").await.unwrap();
            set_applied(&pool, id, false).await.unwrap();
            assert_eq!(note(&pool).await.as_deref(), Some("no referral"));

            save_notes(&pool, id, "   ").await.unwrap();
            assert_eq!(note(&pool).await, None);
        });

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_applied_at_dates_the_application_and_its_event() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");
        tauri::async_runtime::block_on(async {
            sqlx::query("INSERT INTO jobs (job_key, company, title, triple) VALUES ('k', 'co', 't', 'k')")
                .execute(&pool)
                .await
                .unwrap();
            let id = list(&pool).await.unwrap()[0].id;
            set_applied_at(&pool, id, true, Some("2026-09-17T14:02:00Z")).await.unwrap();
            assert_eq!(list(&pool).await.unwrap()[0].applied_at.as_deref(), Some("2026-09-17T14:02:00Z"));
            let at: String = sqlx::query_scalar("SELECT occurred_at FROM application_events").fetch_one(&pool).await.unwrap();
            assert_eq!(at, "2026-09-17T14:02:00Z");
        });
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One-off: record an application on the real database, dated in the
    /// past. Not run by default:
    ///   JT_DB_DIR=~/.local/share/xyz.aakwsp.job-trackwsp JT_JOB_ID=38 JT_APPLIED_AT=2026-09-17T..Z \
    ///     cargo test --lib jobs::tests::record_past_application -- --ignored --nocapture
    #[test]
    #[ignore]
    fn record_past_application() {
        let dir = std::path::PathBuf::from(std::env::var("JT_DB_DIR").expect("JT_DB_DIR"));
        let job: i64 = std::env::var("JT_JOB_ID").expect("JT_JOB_ID").parse().unwrap();
        let at = std::env::var("JT_APPLIED_AT").expect("JT_APPLIED_AT");
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");
        tauri::async_runtime::block_on(async {
            set_applied_at(&pool, job, true, Some(&at)).await.unwrap();
            let row: (i64, String, String) = sqlx::query_as(
                "SELECT a.id, a.status, e.occurred_at FROM applications a
                 JOIN application_events e ON e.application_id = a.id WHERE a.job_id = ?",
            )
            .bind(job)
            .fetch_one(&pool)
            .await
            .unwrap();
            println!("application {} on job {job}: {} at {}", row.0, row.1, row.2);
        });
    }

    #[test]
    fn check_url_only_allows_http() {
        assert!(check_url("https://example.com/job/1").is_ok());
        assert!(check_url("HTTP://example.com").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
    }
}
