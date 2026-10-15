//! Read side of `jobs` for the list view, plus the user's "applied" toggle.
//!
//! Nothing here writes to `jobs` — that table is owned by the sync. Applied
//! state lives in `applications` (CLAUDE.md, "Data model").

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
    pub applied: bool,
}

#[derive(Debug)]
pub enum JobsError {
    Db(sqlx::Error),
    /// Un-applying would delete an application that has moved past
    /// `applied` (assessment, interview, ...) along with its timeline.
    ApplicationInProgress(String),
    BadUrl(String),
    Open(String),
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
                j.first_seen, j.last_seen,
                EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id) AS applied
         FROM jobs j
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
    Ok(rows)
}

/// Creates (with an `applied` event) or removes the application for
/// `job_id`. Idempotent in both directions.
pub async fn set_applied(pool: &SqlitePool, job_id: i64, applied: bool) -> Result<(), JobsError> {
    let mut tx = pool.begin().await?;

    let existing: Option<(i64, String)> =
        sqlx::query_as("SELECT id, status FROM applications WHERE job_id = ? LIMIT 1")
            .bind(job_id)
            .fetch_optional(&mut *tx)
            .await?;

    match (applied, existing) {
        (true, None) => {
            let app_id: i64 = sqlx::query_scalar(
                "INSERT INTO applications (job_id, status, applied_at)
                 VALUES (?, 'applied', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                 RETURNING id",
            )
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
            // The timeline is the source of truth for `status`, so the
            // application starts with the event that put it there.
            sqlx::query(
                "INSERT INTO application_events (application_id, type, occurred_at, origin)
                 VALUES (?, 'applied', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'manual')",
            )
            .bind(app_id)
            .execute(&mut *tx)
            .await?;
        }
        (false, Some((_, status))) if status != "applied" => {
            return Err(JobsError::ApplicationInProgress(status));
        }
        (false, Some(_)) => {
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
    fn check_url_only_allows_http() {
        assert!(check_url("https://example.com/job/1").is_ok());
        assert!(check_url("HTTP://example.com").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
    }
}
