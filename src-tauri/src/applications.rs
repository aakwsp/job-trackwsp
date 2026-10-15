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

/// Writes a stage event that came from an email (JT-16), inside the
/// caller's transaction, and recomputes the status like every other event
/// write. Returns the new event's id.
///
/// `occurred_at` is the email's date, but never earlier than the
/// application's latest event: the status is "the latest event", so an
/// event dated before (say) a manual "applied" clicked later would
/// silently not change the stage. Routing only writes forward moves, so
/// this only ever nudges a date later, never reorders the timeline.
pub async fn write_email_event(
    tx: &mut Transaction<'_, Sqlite>,
    id: i64,
    kind: &str,
    occurred_at: &str,
    email_id: i64,
) -> Result<i64, JobsError> {
    let latest: Option<String> =
        sqlx::query_scalar("SELECT MAX(occurred_at) FROM application_events WHERE application_id = ?")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    let at = match latest {
        Some(l) if l.as_str() > occurred_at => l,
        _ => occurred_at.to_string(),
    };
    let event_id: i64 = sqlx::query_scalar(
        "INSERT INTO application_events (application_id, type, occurred_at, origin, email_id)
         VALUES (?, ?, ?, 'email', ?) RETURNING id",
    )
    .bind(id)
    .bind(kind)
    .bind(at)
    .bind(email_id)
    .fetch_one(&mut **tx)
    .await?;
    recompute_status(tx, id).await?;
    Ok(event_id)
}

/// Removes one specific event (an email's auto-applied one, on undo) and
/// recomputes the status from what's left, in the caller's transaction.
/// Refuses to remove an application's only event.
pub async fn remove_event(tx: &mut Transaction<'_, Sqlite>, id: i64, event_id: i64) -> Result<(), JobsError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM application_events WHERE application_id = ?")
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    if count <= 1 {
        return Err(JobsError::BadTransition("can't remove an application's only event".into()));
    }
    let removed = sqlx::query("DELETE FROM application_events WHERE id = ? AND application_id = ?")
        .bind(event_id)
        .bind(id)
        .execute(&mut **tx)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(JobsError::BadTransition(format!("event {event_id} isn't on application {id}")));
    }
    recompute_status(tx, id).await
}

/// Unlinks an application from a posting it was wrongly attached to and
/// gives it its own company and title (as an application added by hand).
/// Its events, notes and dates stay as they are.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn detach_from_posting(pool: &SqlitePool, id: i64, company: &str, title: &str) -> Result<ApplicationRow, JobsError> {
    sqlx::query(
        "UPDATE applications SET job_id = NULL, company = ?, title = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?",
    )
    .bind(company)
    .bind(title)
    .bind(id)
    .execute(pool)
    .await?;
    get(pool, id).await
}

/// Records a stage event that happened in the past (a rejection you heard
/// about elsewhere, say), dated `occurred_at`, origin manual, and
/// recomputes the status. Refuses a date before the application's latest
/// event: the status is "the latest event", so such an event would land in
/// the middle of the timeline and silently not change anything.
// Only the one-off backfill runner calls this so far; a UI for dated
// events can come with INBOX (JT-18).
#[cfg_attr(not(test), allow(dead_code))]
pub async fn record_event_at(
    pool: &SqlitePool,
    id: i64,
    kind: &str,
    occurred_at: &str,
) -> Result<ApplicationRow, JobsError> {
    let mut tx = pool.begin().await?;
    let latest: Option<String> =
        sqlx::query_scalar("SELECT MAX(occurred_at) FROM application_events WHERE application_id = ?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if latest.as_deref().is_some_and(|l| l > occurred_at) {
        return Err(JobsError::BadTransition(format!(
            "{occurred_at} is before this application's latest event ({})",
            latest.unwrap_or_default()
        )));
    }
    sqlx::query(
        "INSERT INTO application_events (application_id, type, occurred_at, origin)
         VALUES (?, ?, ?, 'manual')",
    )
    .bind(id)
    .bind(kind)
    .bind(occurred_at)
    .execute(&mut *tx)
    .await?;
    recompute_status(&mut tx, id).await?;
    tx.commit().await?;
    get(pool, id).await
}

/// One step back: removes the latest event and recomputes the status from
/// what's left, in one transaction. Removing rather than writing a
/// backwards event keeps the timeline truthful. This is both the record's
/// [ undo ] and PIPELINE's ← (JT-35): from interview it returns to
/// assessment; from rejected/withdrawn it reopens at the stage before.
///
/// Stops at applied. That's the floor; taking back "mark applied" itself is
/// `jobs::set_applied`, which deletes the whole application. The event
/// count check is the same rule in another form (an application with no
/// events would have no status), kept in case history ever holds more than
/// one 'applied' event.
pub async fn undo(pool: &SqlitePool, id: i64) -> Result<ApplicationRow, JobsError> {
    let mut tx = pool.begin().await?;
    if status_of(&mut tx, id).await? == "applied" {
        return Err(JobsError::BadTransition("already at applied".into()));
    }
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

    /// ← (JT-35): each step back removes exactly one event, and the status
    /// is whatever the new latest event says.
    #[test]
    fn back_removes_one_event_and_recomputes_status() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");

        tauri::async_runtime::block_on(async {
            let id = add(&pool, "acme", "intern", None).await.unwrap().id;
            advance(&pool, id).await.unwrap(); // assessment
            advance(&pool, id).await.unwrap(); // interview
            let before = reject(&pool, id).await.unwrap();
            assert_eq!(before.events.len(), 4);

            // Rejected → reopened at interview.
            let after = undo(&pool, id).await.unwrap();
            assert_eq!(after.events.len(), before.events.len() - 1);
            assert_eq!(after.status, after.events.last().unwrap().kind);
            assert_eq!(after.status, "interview");
            // The removed event was the latest one; the rest are untouched.
            let ids = |a: &ApplicationRow| a.events.iter().map(|e| e.id).collect::<Vec<_>>();
            assert_eq!(ids(&after), ids(&before)[..3]);

            // And the stored status agrees with the returned row.
            let stored: String = sqlx::query_scalar("SELECT status FROM applications WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(stored, "interview");

            let a = undo(&pool, id).await.unwrap();
            assert_eq!((a.status.as_str(), a.events.len()), ("assessment", 2));
            let a = undo(&pool, id).await.unwrap();
            assert_eq!((a.status.as_str(), a.events.len()), ("applied", 1));

            // Hard stop at applied: refused, nothing removed.
            assert!(matches!(undo(&pool, id).await, Err(JobsError::BadTransition(_))));
            assert_eq!(list(&pool).await.unwrap()[0].events.len(), 1);
        });

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_event_at_dates_it_and_refuses_the_past() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");
        tauri::async_runtime::block_on(async {
            let id = add(&pool, "AMD", "Graphics Intern", Some("2026-09-15")).await.unwrap().id;
            let a = record_event_at(&pool, id, "rejected", "2026-09-21T12:00:00Z").await.unwrap();
            assert_eq!(a.status, "rejected");
            assert_eq!(a.events.last().unwrap().occurred_at, "2026-09-21T12:00:00Z");
            assert_eq!(a.events.last().unwrap().origin, "manual");
            // Before the latest event: refused, nothing written.
            assert!(record_event_at(&pool, id, "interview", "2026-09-01T12:00:00Z").await.is_err());
            assert_eq!(list(&pool).await.unwrap()[0].events.len(), 2);
        });
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One-off backfill on the real database from a JSON plan (see the
    /// JT-16 notes). Not run by default:
    ///   JT_DB_DIR=... JT_PLAN=plan.json cargo test --lib applications::tests::apply_backfill_plan -- --ignored --nocapture
    /// Plan: {"from_postings": [[job_id, applied_at]], "manual": [{company, title, applied_on, note}],
    ///        "rejections": [{"job_id"|"manual_title", "at"}]}. Skips anything already done.
    #[test]
    #[ignore]
    fn apply_backfill_plan() {
        let dir = std::path::PathBuf::from(std::env::var("JT_DB_DIR").expect("JT_DB_DIR"));
        let plan: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(std::env::var("JT_PLAN").expect("JT_PLAN")).unwrap()).unwrap();
        let pool = tauri::async_runtime::block_on(db::connect(&dir)).expect("connect");
        tauri::async_runtime::block_on(async {
            for item in plan["from_postings"].as_array().unwrap() {
                let (job, at) = (item[0].as_i64().unwrap(), item[1].as_str().unwrap());
                let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM applications WHERE job_id = ?")
                    .bind(job).fetch_one(&pool).await.unwrap();
                if exists > 0 { println!("job {job}: already has an application, skipped"); continue; }
                crate::jobs::set_applied_at(&pool, job, true, Some(at)).await.unwrap();
                println!("job {job}: applied {at}");
            }
            for m in plan["manual"].as_array().unwrap() {
                let (company, title) = (m["company"].as_str().unwrap(), m["title"].as_str().unwrap());
                let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM applications WHERE job_id IS NULL AND company = ? AND title = ?")
                    .bind(company).bind(title).fetch_one(&pool).await.unwrap();
                if exists > 0 { println!("{company} {title}: already exists, skipped"); continue; }
                let a = add(&pool, company, title, m["applied_on"].as_str()).await.unwrap();
                save_notes(&pool, a.id, m["note"].as_str().unwrap_or("")).await.unwrap();
                println!("manual #{}: {company} — {title}, applied {:?}", a.id, a.applied_at);
            }
            for d in plan["detach"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
                let id = d["application_id"].as_i64().unwrap();
                let job: Option<i64> = sqlx::query_scalar("SELECT job_id FROM applications WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
                if job.is_none() { println!("application {id}: already detached, skipped"); continue; }
                let a = detach_from_posting(&pool, id, d["company"].as_str().unwrap(), d["title"].as_str().unwrap()).await.unwrap();
                let note = d["note"].as_str().unwrap_or("");
                let notes = match a.notes.as_deref() { Some(n) if !n.is_empty() => format!("{n}\n{note}"), _ => note.to_string() };
                save_notes(&pool, id, &notes).await.unwrap();
                println!("application {id}: detached from job {}, now {} — {}", job.unwrap(), a.company, a.title);
            }
            for r in plan["rejections"].as_array().unwrap() {
                let id: i64 = match (r.get("job_id"), r.get("manual_title"), r.get("application_id")) {
                    (_, _, Some(a)) => a.as_i64().unwrap(),
                    (Some(j), _, _) => sqlx::query_scalar("SELECT id FROM applications WHERE job_id = ?").bind(j.as_i64().unwrap()).fetch_one(&pool).await.unwrap(),
                    (_, Some(t), _) => sqlx::query_scalar("SELECT id FROM applications WHERE job_id IS NULL AND title = ?").bind(t.as_str().unwrap()).fetch_one(&pool).await.unwrap(),
                    _ => panic!("rejection needs job_id or manual_title"),
                };
                let status: String = sqlx::query_scalar("SELECT status FROM applications WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
                if status == "rejected" { println!("application {id}: already rejected, skipped"); continue; }
                let a = record_event_at(&pool, id, "rejected", r["at"].as_str().unwrap()).await.unwrap();
                println!("application {id}: {} at {}", a.status, a.events.last().unwrap().occurred_at);
            }
            if plan["redecode_bodies"].as_bool() == Some(true) {
                // Plain-text bodies stored before entities were decoded
                // there; only rows that still have a body and an entity.
                let rows: Vec<(i64, String)> = sqlx::query_as(
                    "SELECT id, body_text FROM emails WHERE body_text LIKE '%&%;%'",
                ).fetch_all(&pool).await.unwrap();
                let mut changed = 0;
                for (id, body) in rows {
                    let fixed = crate::mail::mime::decode_entities(&body);
                    if fixed != body {
                        sqlx::query("UPDATE emails SET body_text = ? WHERE id = ?").bind(fixed).bind(id).execute(&pool).await.unwrap();
                        changed += 1;
                    }
                }
                println!("bodies re-decoded: {changed}");
            }
        });
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
