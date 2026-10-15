//! INBOX (JT-18): what the email list and the detail pane show. Read-only
//! queries plus read/unread; the actions (confirm, edit, reject, undo,
//! change match, create from posting) are `routing`'s.
//!
//! Blocked and ignored mail never appears in `list`. Ignored mail is listed
//! separately (`ignored`) with only who / what / when, so it can be put
//! back with `mail::restore`.

use serde::Serialize;
use sqlx::SqlitePool;

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

/// One row of the email list. Mirrors `InboxRow` in types.ts.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct InboxRow {
    pub id: i64,
    /// pending (waiting for the LLM) | extracted | checking | auto |
    /// confirmed | rejected
    pub status: String,
    /// The matched application's company, else the extracted one, else the
    /// sender.
    pub company: Option<String>,
    pub event_type: Option<String>,
    /// The routing score (JT-16), not Gemini's confidence. Null until
    /// routed.
    pub score: Option<f64>,
    pub subject: Option<String>,
    pub received_at: Option<String>,
    pub read: bool,
    pub application_id: Option<i64>,
}

const LIST_SQL: &str = "
    SELECT e.id, e.status,
           COALESCE(j.company, a.company, x.company, e.from_addr) AS company,
           x.event_type, m.score, e.subject, e.received_at,
           e.read_at IS NOT NULL AS read, m.application_id
    FROM emails e
    LEFT JOIN extractions x ON x.id = (SELECT MAX(id) FROM extractions WHERE email_id = e.id)
    LEFT JOIN email_matches m ON m.email_id = e.id
    LEFT JOIN applications a ON a.id = m.application_id
    LEFT JOIN jobs j ON j.id = a.job_id
    WHERE e.status NOT IN ('ignored', 'blocked')
    ORDER BY e.received_at DESC, e.id DESC";

/// Every email INBOX shows, newest first (the UI re-sorts and splits off
/// `checking`).
pub fn list(pool: &SqlitePool) -> Result<Vec<InboxRow>, sqlx::Error> {
    block_on(sqlx::query_as::<_, InboxRow>(LIST_SQL).fetch_all(pool))
}

/// An ignored email: only what the "n ignored" list shows.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct IgnoredRow {
    pub id: i64,
    pub gmail_id: String,
    pub from_addr: Option<String>,
    pub subject: Option<String>,
    pub received_at: Option<String>,
    pub filter_reason: Option<String>,
}

pub fn ignored(pool: &SqlitePool) -> Result<Vec<IgnoredRow>, sqlx::Error> {
    block_on(
        sqlx::query_as::<_, IgnoredRow>(
            "SELECT id, gmail_id, from_addr, subject, received_at, filter_reason
             FROM emails WHERE status = 'ignored' ORDER BY received_at DESC, id DESC",
        )
        .fetch_all(pool),
    )
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct EmailPart {
    pub id: i64,
    pub gmail_id: String,
    pub thread_id: Option<String>,
    pub status: String,
    pub from_addr: Option<String>,
    pub subject: Option<String>,
    pub received_at: Option<String>,
    /// Plain text only (HTML was stripped when it was stored).
    pub body_text: Option<String>,
    pub read: bool,
    pub extract_error: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ExtractionPart {
    pub id: i64,
    pub company: Option<String>,
    pub role: Option<String>,
    pub req_id: Option<String>,
    pub event_type: String,
    pub occurred_at: Option<String>,
    /// Gemini's overall confidence.
    pub confidence: Option<f64>,
    /// JSON object of per-field confidences.
    pub field_confidence: Option<String>,
}

/// An application as the detail pane names it.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AppRef {
    pub id: i64,
    pub company: String,
    pub title: String,
    pub status: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct JobRef {
    pub id: i64,
    pub company: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct MatchPart {
    pub application: Option<AppRef>,
    pub candidates: Vec<AppRef>,
    pub suggested_job: Option<JobRef>,
    pub score: f64,
    pub reasons: Vec<String>,
    pub action: String,
    pub note: Option<String>,
    pub wrote_event: bool,
}

/// One node of an application's email timeline. Mirrors `TimelineNode`.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TimelineNode {
    pub email_id: i64,
    pub event_type: Option<String>,
    /// auto / confirmed (filled node) or checking (hollow).
    pub status: String,
    pub received_at: Option<String>,
    pub read: bool,
}

/// The emails matched to one application, oldest first: the horizontal
/// timeline in INBOX and in the record's emails tab. Emails the user
/// rejected aren't part of it.
pub fn timeline(pool: &SqlitePool, application_id: i64) -> Result<Vec<TimelineNode>, sqlx::Error> {
    block_on(
        sqlx::query_as(
            "SELECT e.id AS email_id, x.event_type, e.status, e.received_at, e.read_at IS NOT NULL AS read
             FROM email_matches m
             JOIN emails e ON e.id = m.email_id
             LEFT JOIN extractions x ON x.id = (SELECT MAX(id) FROM extractions WHERE email_id = e.id)
             WHERE m.application_id = ? AND e.status IN ('auto', 'confirmed', 'checking')
             ORDER BY e.received_at, e.id",
        )
        .bind(application_id)
        .fetch_all(pool),
    )
}

/// One application in the by-job list. Mirrors `InboxJob`.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct JobRow {
    pub application_id: i64,
    pub company: String,
    pub title: String,
    pub status: String,
    pub emails: i64,
    pub unread: i64,
    /// Newest email's received_at, for "latest activity".
    pub latest: Option<String>,
}

/// Every application with at least one matched email.
pub fn jobs(pool: &SqlitePool) -> Result<Vec<JobRow>, sqlx::Error> {
    block_on(
        sqlx::query_as(
            "SELECT a.id AS application_id, COALESCE(j.company, a.company, '') AS company,
                    COALESCE(j.title, a.title, '') AS title, a.status,
                    COUNT(e.id) AS emails, SUM(e.read_at IS NULL) AS unread, MAX(e.received_at) AS latest
             FROM email_matches m
             JOIN emails e ON e.id = m.email_id AND e.status IN ('auto', 'confirmed', 'checking')
             JOIN applications a ON a.id = m.application_id
             LEFT JOIN jobs j ON j.id = a.job_id
             GROUP BY a.id
             ORDER BY latest DESC",
        )
        .fetch_all(pool),
    )
}

/// Everything the detail pane shows for one email. Mirrors `InboxDetail`.
#[derive(Debug, Serialize)]
pub struct Detail {
    pub email: EmailPart,
    pub extraction: Option<ExtractionPart>,
    pub r#match: Option<MatchPart>,
    /// Every application, for [ change match ].
    pub applications: Vec<AppRef>,
    /// The matched application's email timeline (empty when unmatched).
    pub timeline: Vec<TimelineNode>,
}

pub fn detail(pool: &SqlitePool, email_id: i64) -> Result<Option<Detail>, sqlx::Error> {
    let email: Option<EmailPart> = block_on(
        sqlx::query_as(
            "SELECT id, gmail_id, thread_id, status, from_addr, subject, received_at, body_text,
                    read_at IS NOT NULL AS read, extract_error
             FROM emails WHERE id = ? AND status NOT IN ('ignored', 'blocked')",
        )
        .bind(email_id)
        .fetch_optional(pool),
    )?;
    let Some(email) = email else { return Ok(None) };
    let extraction: Option<ExtractionPart> = block_on(
        sqlx::query_as(
            "SELECT id, company, role, req_id, event_type, occurred_at, confidence, field_confidence
             FROM extractions WHERE email_id = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(email_id)
        .fetch_optional(pool),
    )?;
    let applications: Vec<AppRef> =
        block_on(
            sqlx::query_as(
                "SELECT a.id, COALESCE(j.company, a.company, '') AS company,
                        COALESCE(j.title, a.title, '') AS title, a.status
                 FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
                 ORDER BY company, title",
            )
            .fetch_all(pool),
        )?;
    type M = (Option<i64>, String, Option<i64>, f64, String, String, Option<String>, bool);
    let m: Option<M> = block_on(
        sqlx::query_as(
            "SELECT application_id, candidate_ids, suggested_job_id, score, reasons, action, note, wrote_event
             FROM email_matches WHERE email_id = ?",
        )
        .bind(email_id)
        .fetch_optional(pool),
    )?;
    let r#match = match m {
        None => None,
        Some((app, cands, job, score, reasons, action, note, wrote)) => {
            let ids: Vec<i64> = serde_json::from_str(&cands).unwrap_or_default();
            let find = |id: i64| applications.iter().find(|a| a.id == id).map(|a| AppRef {
                id: a.id,
                company: a.company.clone(),
                title: a.title.clone(),
                status: a.status.clone(),
            });
            let suggested_job = match job {
                Some(id) => block_on(sqlx::query_as("SELECT id, company, title FROM jobs WHERE id = ?").bind(id).fetch_optional(pool))?,
                None => None,
            };
            Some(MatchPart {
                application: app.and_then(find),
                candidates: ids.into_iter().filter_map(find).collect(),
                suggested_job,
                score,
                reasons: serde_json::from_str(&reasons).unwrap_or_default(),
                action,
                note,
                wrote_event: wrote,
            })
        }
    };
    let timeline = match r#match.as_ref().and_then(|m| m.application.as_ref()) {
        Some(a) => timeline(pool, a.id)?,
        None => Vec::new(),
    };
    Ok(Some(Detail { email, extraction, r#match, applications, timeline }))
}

/// Marks an email read (now) or unread.
pub fn set_read(pool: &SqlitePool, email_id: i64, read: bool) -> Result<(), sqlx::Error> {
    block_on(
        sqlx::query(
            "UPDATE emails SET read_at = CASE WHEN ? THEN COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) END
             WHERE id = ?",
        )
        .bind(read)
        .bind(email_id)
        .execute(pool),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn scratch_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "job-trackwsp-inbox-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    fn email(pool: &SqlitePool, gmail: &str, status: &str, received: &str) -> i64 {
        block_on(
            sqlx::query_scalar(
                "INSERT INTO emails (gmail_id, thread_id, from_addr, subject, received_at, body_text, status, filter_reason)
                 VALUES (?, 't', 'Acme <jobs@acme.com>', ?, ?, 'body', ?, 'r') RETURNING id",
            )
            .bind(gmail)
            .bind(format!("subject {gmail}"))
            .bind(received)
            .bind(status)
            .fetch_one(pool),
        )
        .unwrap()
    }

    #[test]
    fn list_hides_ignored_and_blocked_and_shows_routing_score() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).unwrap();
        let a = email(&pool, "a", "auto", "2026-09-01T00:00:00Z");
        let c = email(&pool, "c", "checking", "2026-09-03T00:00:00Z");
        email(&pool, "i", "ignored", "2026-09-04T00:00:00Z");
        email(&pool, "b", "blocked", "2026-09-05T00:00:00Z");
        let p = email(&pool, "p", "pending", "2026-09-02T00:00:00Z");
        block_on(async {
            sqlx::query("INSERT INTO extractions (email_id, company, event_type, confidence) VALUES (?, 'Acme', 'interview', 0.99)")
                .bind(a).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO email_matches (email_id, score, reasons, action) VALUES (?, 0.83, '[\"company acme\"]', 'attach')")
                .bind(a).execute(&pool).await.unwrap();
        });

        let rows = list(&pool).unwrap();
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        assert_eq!(ids, [c, p, a]); // newest first, no ignored / blocked
        let auto = rows.iter().find(|r| r.id == a).unwrap();
        assert_eq!(auto.score, Some(0.83)); // routing score, not Gemini's 0.99
        assert_eq!(auto.company.as_deref(), Some("Acme"));
        assert_eq!(auto.event_type.as_deref(), Some("interview"));
        assert!(!auto.read);

        let ign = ignored(&pool).unwrap();
        assert_eq!(ign.len(), 1);
        assert_eq!(ign[0].subject.as_deref(), Some("subject i"));
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timeline_and_jobs() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).unwrap();
        let first = email(&pool, "1", "auto", "2026-09-01T00:00:00Z");
        let second = email(&pool, "2", "checking", "2026-09-10T00:00:00Z");
        let gone = email(&pool, "3", "rejected", "2026-09-05T00:00:00Z");
        let other = email(&pool, "4", "auto", "2026-09-20T00:00:00Z");
        block_on(async {
            sqlx::query("INSERT INTO applications (company, title) VALUES ('Acme', 'Backend Intern'), ('Beta', 'Data Intern')")
                .execute(&pool).await.unwrap();
            for (e, app, t) in [(first, 1, "applied"), (second, 1, "interview"), (gone, 1, "follow_up"), (other, 2, "applied")] {
                sqlx::query("INSERT INTO extractions (email_id, event_type) VALUES (?, ?)").bind(e).bind(t).execute(&pool).await.unwrap();
                sqlx::query("INSERT INTO email_matches (email_id, application_id, score, reasons, action) VALUES (?, ?, 0.9, '[]', 'attach')")
                    .bind(e).bind(app).execute(&pool).await.unwrap();
            }
        });
        set_read(&pool, first, true).unwrap();

        let t = timeline(&pool, 1).unwrap();
        let ids: Vec<i64> = t.iter().map(|n| n.email_id).collect();
        assert_eq!(ids, [first, second]); // oldest first; the rejected one is out
        assert_eq!((t[0].status.as_str(), t[1].event_type.as_deref()), ("auto", Some("interview")));

        let j = jobs(&pool).unwrap();
        assert_eq!(j.len(), 2);
        assert_eq!((j[0].company.as_str(), j[0].emails), ("Beta", 1)); // latest activity first
        assert_eq!((j[1].emails, j[1].unread), (2, 1));

        // The detail carries its application's timeline.
        assert_eq!(detail(&pool, second).unwrap().unwrap().timeline.len(), 2);
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detail_and_read_toggle() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).unwrap();
        let id = email(&pool, "x", "checking", "2026-09-01T00:00:00Z");
        let hidden = email(&pool, "y", "blocked", "2026-09-01T00:00:00Z");
        block_on(async {
            sqlx::query("INSERT INTO applications (company, title) VALUES ('Acme', 'Backend Intern'), ('Acme', 'Frontend Intern')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO extractions (email_id, company, role, event_type, confidence, field_confidence) VALUES (?, 'Acme', 'Intern', 'applied', 0.9, '{\"role\":0.4}')")
                .bind(id).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO email_matches (email_id, candidate_ids, score, reasons, action, note) VALUES (?, '[1,2]', 0.1, '[\"2 candidates\"]', 'none', '2 applications could match')")
                .bind(id).execute(&pool).await.unwrap();
        });

        let d = detail(&pool, id).unwrap().unwrap();
        assert_eq!(d.email.body_text.as_deref(), Some("body"));
        assert_eq!(d.extraction.as_ref().unwrap().role.as_deref(), Some("Intern"));
        let m = d.r#match.unwrap();
        assert_eq!(m.candidates.len(), 2);
        assert!(m.application.is_none());
        assert_eq!(m.reasons, ["2 candidates"]);
        assert_eq!(d.applications.len(), 2);
        // Blocked mail has no detail at all.
        assert!(detail(&pool, hidden).unwrap().is_none());

        assert!(!d.email.read);
        set_read(&pool, id, true).unwrap();
        assert!(detail(&pool, id).unwrap().unwrap().email.read);
        set_read(&pool, id, false).unwrap();
        assert!(!detail(&pool, id).unwrap().unwrap().email.read);
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
