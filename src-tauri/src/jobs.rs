//! Read side of `jobs` for the list view, plus the user's "applied" toggle
//! and notes.
//!
//! Nothing here writes to `jobs` — that table is owned by the sync. Applied
//! state lives in `applications` (CLAUDE.md, "Data model"). A note lives in
//! `job_notes` until the posting is applied, then in `applications.notes`.

use serde::Serialize;
use sqlx::SqlitePool;

/// One row of the list view. Field names cross the invoke bridge as-is, so
/// they must match the `Job` type in `frontend/src/types.ts`.
#[derive(Debug, Serialize, sqlx::FromRow)]
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

/// Every non-hidden job in three tiers: upcoming deadlines (soonest first),
/// then no deadline (rolling), then past due (most recently expired first).
/// Ties go to the most recently seen. The frontend groups by city but keeps
/// this order within each group.
///
/// "Past due" uses the local date, matching the frontend's `daysLeft`.
pub async fn list(pool: &SqlitePool) -> Result<Vec<JobRow>, JobsError> {
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
         WHERE j.hidden = 0
         ORDER BY
           CASE
             WHEN j.deadline IS NULL THEN 1
             WHEN j.deadline < date('now', 'localtime') THEN 2
             ELSE 0
           END,
           -- ascending for upcoming, descending for past due
           CASE WHEN j.deadline >= date('now', 'localtime') THEN j.deadline END ASC,
           CASE WHEN j.deadline < date('now', 'localtime') THEN j.deadline END DESC,
           j.last_seen DESC",
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
    Ok(rows)
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
