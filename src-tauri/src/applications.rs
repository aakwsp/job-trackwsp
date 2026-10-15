//! The pipeline: the user's applications and their timelines.
//!
//! `applications.status` is stored, but it's never written directly — every
//! change goes through `write_event` / `recompute_status`, which add or
//! remove an `application_events` row and set `status` from the latest one,
//! inside the caller's transaction. So the stored status can't drift from
//! the timeline (CLAUDE.md, "Data model").
//!
//! The sync never touches any of this. Creating an application for a
//! posting the scheduler found is `jobs::set_applied`; this module also
//! creates ones with no `job_id`, for things the scheduler never found.

use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::jobs::JobsError;

/// One entry in an application's timeline. Must match `AppEvent` in
/// `frontend/src/types.ts`.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EventRow {
    pub id: i64,
    pub application_id: i64,
    /// `type` in SQL; a Rust keyword, so renamed on both sides.
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub kind: String,
    pub occurred_at: String,
    pub origin: String,
    pub note: Option<String>,
}

/// One application for the pipeline and the record. Must match
/// `Application` in `frontend/src/types.ts`.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ApplicationRow {
    pub id: i64,
    pub job_id: Option<i64>,
    /// From the posting when there is one, else the free-text columns.
    pub company: String,
    pub title: String,
    pub status: String,
    pub applied_at: Option<String>,
    /// `occurred_at` of the latest event: when it entered its current stage
    /// (or closed).
    pub stage_since: Option<String>,
    pub notes: Option<String>,
    /// Oldest first. Filled in after the main query.
    #[sqlx(skip)]
    pub events: Vec<EventRow>,
}

/// The four open stages, in order. `rejected` / `withdrawn` close an
/// application from any of them.
const STAGES: [&str; 4] = ["applied", "assessment", "interview", "offer"];

// A macro rather than a `const`, so `concat!` can build each full query
// as a `&'static str` at compile time: sqlx 0.9 only takes static SQL
// (`SqlSafeStr`), which rules out `format!`.
macro_rules! select_apps {
    () => {
        "
    SELECT a.id, a.job_id,
           COALESCE(j.company, a.company, '') AS company,
           COALESCE(j.title, a.title, '') AS title,
           a.status, a.applied_at,
           (SELECT e.occurred_at FROM application_events e
            WHERE e.application_id = a.id
            ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS stage_since,
           a.notes
    FROM applications a
    LEFT JOIN jobs j ON j.id = a.job_id"
    };
}

/// Every application, newest applied first, each with its events.
pub async fn list(pool: &SqlitePool) -> Result<Vec<ApplicationRow>, JobsError> {
    let mut apps = sqlx::query_as::<_, ApplicationRow>(concat!(
        select_apps!(),
        " ORDER BY a.applied_at DESC, a.id DESC"
    ))
    .fetch_all(pool)
    .await?;

    // One query for every event rather than one per application; there are
    // a few hundred at most.
    let events = sqlx::query_as::<_, EventRow>(
        "SELECT id, application_id, type, occurred_at, origin, note
         FROM application_events ORDER BY occurred_at, id",
    )
    .fetch_all(pool)
    .await?;
    for ev in events {
        if let Some(app) = apps.iter_mut().find(|a| a.id == ev.application_id) {
            app.events.push(ev);
        }
    }
    Ok(apps)
}

async fn get(pool: &SqlitePool, id: i64) -> Result<ApplicationRow, JobsError> {
    let mut app = sqlx::query_as::<_, ApplicationRow>(concat!(select_apps!(), " WHERE a.id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(JobsError::NotFound(id))?;
    app.events = sqlx::query_as::<_, EventRow>(
        "SELECT id, application_id, type, occurred_at, origin, note
         FROM application_events WHERE application_id = ? ORDER BY occurred_at, id",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    Ok(app)
}

/// Sets `status` from the latest event. Called after every event write.
async fn recompute_status(tx: &mut Transaction<'_, Sqlite>, id: i64) -> Result<(), JobsError> {
    sqlx::query(
        "UPDATE applications
         SET status = (SELECT type FROM application_events
                       WHERE application_id = applications.id
                       ORDER BY occurred_at DESC, id DESC LIMIT 1),
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn write_event(tx: &mut Transaction<'_, Sqlite>, id: i64, kind: &str) -> Result<(), JobsError> {
    sqlx::query(
        "INSERT INTO application_events (application_id, type, occurred_at, origin)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'manual')",
    )
    .bind(id)
    .bind(kind)
    .execute(&mut **tx)
    .await?;
    recompute_status(tx, id).await
}

async fn status_of(tx: &mut Transaction<'_, Sqlite>, id: i64) -> Result<String, JobsError> {
    sqlx::query_scalar("SELECT status FROM applications WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(JobsError::NotFound(id))
}

/// applied → assessment → interview → offer. The event and the new status
/// are written in one transaction.
pub async fn advance(pool: &SqlitePool, id: i64) -> Result<ApplicationRow, JobsError> {
    let mut tx = pool.begin().await?;
    let status = status_of(&mut tx, id).await?;
    let next = STAGES
        .iter()
        .position(|s| *s == status)
        .and_then(|i| STAGES.get(i + 1))
        .ok_or_else(|| JobsError::BadTransition(format!("no stage after '{status}'")))?;
    write_event(&mut tx, id, next).await?;
    tx.commit().await?;
    get(pool, id).await
}

/// Closes an open application as rejected.
pub async fn reject(pool: &SqlitePool, id: i64) -> Result<ApplicationRow, JobsError> {
    let mut tx = pool.begin().await?;
    let status = status_of(&mut tx, id).await?;
    if !STAGES.contains(&status.as_str()) {
        return Err(JobsError::BadTransition(format!("already {status}")));
    }
    write_event(&mut tx, id, "rejected").await?;
    tx.commit().await?;
    get(pool, id).await
}

/// Removes the latest event and recomputes the status from what's left.
/// Refuses to remove the last one: an application with no events has no
/// status. (Taking back "mark applied" itself is `jobs::set_applied`.)
pub async fn undo(pool: &SqlitePool, id: i64) -> Result<ApplicationRow, JobsError> {
    let mut tx = pool.begin().await?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM application_events WHERE application_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if count <= 1 {
        return Err(JobsError::BadTransition("nothing to undo".into()));
    }
    sqlx::query(
        "DELETE FROM application_events WHERE id = (
           SELECT id FROM application_events WHERE application_id = ?
           ORDER BY occurred_at DESC, id DESC LIMIT 1)",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    recompute_status(&mut tx, id).await?;
    tx.commit().await?;
    get(pool, id).await
}

/// An application for something the scheduler never found (`job_id` null).
/// `applied_on` is a local 'YYYY-MM-DD'; stored at noon UTC so it reads
/// back as the same local date anywhere in the Americas. None = now.
pub async fn add(
    pool: &SqlitePool,
    company: &str,
    title: &str,
    applied_on: Option<&str>,
) -> Result<ApplicationRow, JobsError> {
    let (company, title) = (company.trim(), title.trim());
    if company.is_empty() {
        return Err(JobsError::BadTransition("company is required".into()));
    }
    let applied_at = match applied_on.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) if is_ymd(d) => Some(format!("{d}T12:00:00Z")),
        Some(d) => return Err(JobsError::BadTransition(format!("not a YYYY-MM-DD date: {d}"))),
        None => None,
    };

    let mut tx = pool.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO applications (job_id, company, title, status, applied_at)
         VALUES (NULL, ?, ?, 'applied', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))
         RETURNING id",
    )
    .bind(company)
    .bind(title)
    .bind(&applied_at)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO application_events (application_id, type, occurred_at, origin)
         SELECT id, 'applied', applied_at, 'manual' FROM applications WHERE id = ?",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    get(pool, id).await
}

/// Notes on an application with no posting. (One with a posting goes
/// through `jobs::save_notes`, which knows where the note lives.)
pub async fn save_notes(pool: &SqlitePool, id: i64, body: &str) -> Result<(), JobsError> {
    let body = Some(body.trim()).filter(|b| !b.is_empty());
    sqlx::query(
        "UPDATE applications
         SET notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(body)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, jobs};

    fn scratch_dir() -> std::path::PathBuf {
        let unique = format!(
            "job-trackwsp-apps-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn stages_advance_close_and_undo() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        tauri::async_runtime::block_on(async {
            sqlx::query(
                "INSERT INTO jobs (job_key, company, title, triple) VALUES ('k', 'co', 't', 'k')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let job_id = jobs::list(&pool).await.unwrap()[0].id;
            jobs::set_applied(&pool, job_id, true).await.unwrap();

            let app = &list(&pool).await.unwrap()[0];
            assert_eq!((app.company.as_str(), app.status.as_str()), ("co", "applied"));
            assert!(undo(&pool, app.id).await.is_err()); // only event

            let id = app.id;
            assert_eq!(advance(&pool, id).await.unwrap().status, "assessment");
            assert_eq!(advance(&pool, id).await.unwrap().status, "interview");
            let a = reject(&pool, id).await.unwrap();
            assert_eq!(a.status, "rejected");
            assert_eq!(a.events.len(), 4);
            assert!(advance(&pool, id).await.is_err());
            assert!(reject(&pool, id).await.is_err());

            // Same-second events still undo in insertion order (id tiebreak).
            assert_eq!(undo(&pool, id).await.unwrap().status, "interview");
            assert_eq!(advance(&pool, id).await.unwrap().status, "offer");
            assert!(advance(&pool, id).await.is_err());
        });

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn add_without_a_posting() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        tauri::async_runtime::block_on(async {
            let a = add(&pool, " acme ", "intern", Some("2026-09-01")).await.unwrap();
            assert_eq!(a.job_id, None);
            assert_eq!(a.company, "acme");
            assert_eq!(a.applied_at.as_deref(), Some("2026-09-01T12:00:00Z"));
            assert_eq!(a.events.len(), 1);
            assert_eq!(a.stage_since.as_deref(), Some("2026-09-01T12:00:00Z"));
            assert!(add(&pool, "  ", "x", None).await.is_err());
            assert!(add(&pool, "x", "x", Some("9/1/2026")).await.is_err());

            save_notes(&pool, a.id, "  referral from sam ").await.unwrap();
            assert_eq!(list(&pool).await.unwrap()[0].notes.as_deref(), Some("referral from sam"));
        });

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
