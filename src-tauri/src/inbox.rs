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

/// `%text%` for LIKE, with LIKE's own wildcards escaped (`\\` is the
/// ESCAPE character in the queries). None for a blank search.
fn like_pattern(query: Option<&str>) -> Option<String> {
    let q = query?.trim();
    if q.is_empty() {
        return None;
    }
    let escaped: String = q
        .chars()
        .flat_map(|c| match c {
            '%' | '_' | '\\' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    Some(format!("%{escaped}%"))
}

// Search (JT-18): company, role, subject, sender and body, case-insensitive
// (SQLite's LIKE is, for ASCII). `?1` is the pattern or NULL for no search.
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
      AND (?1 IS NULL
           OR COALESCE(j.company, '') LIKE ?1 ESCAPE '\\' OR COALESCE(a.company, '') LIKE ?1 ESCAPE '\\'
           OR COALESCE(x.company, '') LIKE ?1 ESCAPE '\\'
           OR COALESCE(j.title, '') LIKE ?1 ESCAPE '\\' OR COALESCE(a.title, '') LIKE ?1 ESCAPE '\\'
           OR COALESCE(x.role, '') LIKE ?1 ESCAPE '\\'
           OR COALESCE(e.subject, '') LIKE ?1 ESCAPE '\\' OR COALESCE(e.from_addr, '') LIKE ?1 ESCAPE '\\'
           OR COALESCE(e.body_text, '') LIKE ?1 ESCAPE '\\')
    ORDER BY e.received_at DESC, e.id DESC";

/// Every email INBOX shows, newest first (the UI re-sorts and splits off
/// `checking`), optionally only those matching a search.
pub fn list(pool: &SqlitePool, query: Option<&str>) -> Result<Vec<InboxRow>, sqlx::Error> {
    block_on(sqlx::query_as::<_, InboxRow>(LIST_SQL).bind(like_pattern(query)).fetch_all(pool))
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
    pub applied_at: Option<String>,
    /// The posting's city (None without a posting).
    pub city: Option<String>,
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

/// One node of an application's timeline (JT-18: one timeline everywhere,
/// INBOX and the record). Mirrors `TimelineNode`. `kind` is "email" (a
/// diamond in its stage colour) or "event" (a square: first seen, applied
/// by hand, a manual stage change). Events an email wrote aren't nodes of
/// their own: that email's diamond is the event.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TimelineNode {
    pub kind: String,
    /// Emails only.
    pub email_id: Option<i64>,
    /// An email's extracted type (applied, follow_up...), an event's type
    /// (applied, assessment, rejected...), or "first_seen".
    pub event_type: Option<String>,
    /// Emails: auto / confirmed (filled) or checking (hollow).
    pub status: Option<String>,
    /// received_at, occurred_at, or the posting's first_seen (a date).
    pub at: Option<String>,
    pub read: bool,
}

/// One application's timeline, oldest first: its posting's first sighting,
/// its manual events and the emails matched to it (not ones the user
/// rejected).
pub fn timeline(pool: &SqlitePool, application_id: i64) -> Result<Vec<TimelineNode>, sqlx::Error> {
    let mut nodes: Vec<TimelineNode> = block_on(
        sqlx::query_as(
            "SELECT 'email' AS kind, e.id AS email_id, x.event_type, e.status, e.received_at AS at,
                    e.read_at IS NOT NULL AS read
             FROM email_matches m
             JOIN emails e ON e.id = m.email_id
             LEFT JOIN extractions x ON x.id = (SELECT MAX(id) FROM extractions WHERE email_id = e.id)
             WHERE m.application_id = ?1 AND e.status IN ('auto', 'confirmed', 'checking')
             UNION ALL
             SELECT 'event', NULL, ev.type, NULL, ev.occurred_at, 1
             FROM application_events ev WHERE ev.application_id = ?1 AND ev.origin = 'manual'
             UNION ALL
             SELECT 'event', NULL, 'first_seen', NULL, j.first_seen, 1
             FROM applications a JOIN jobs j ON j.id = a.job_id
             WHERE a.id = ?1 AND j.first_seen IS NOT NULL",
        )
        .bind(application_id)
        .fetch_all(pool),
    )?;
    // Text sorts as time ('2026-09-17' before '2026-09-17T…'); on a tie
    // events come first, then emails by id.
    nodes.sort_by(|a, b| {
        (a.at.as_deref().unwrap_or(""), a.kind != "event", a.email_id).cmp(&(b.at.as_deref().unwrap_or(""), b.kind != "event", b.email_id))
    });
    Ok(nodes)
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

/// Every application with at least one matched email; with a search, only
/// emails that match count (an application whose company or role matches
/// counts all of them).
pub fn jobs(pool: &SqlitePool, query: Option<&str>) -> Result<Vec<JobRow>, sqlx::Error> {
    block_on(
        sqlx::query_as(
            "SELECT a.id AS application_id, COALESCE(j.company, a.company, '') AS company,
                    COALESCE(j.title, a.title, '') AS title, a.status,
                    COUNT(e.id) AS emails, SUM(e.read_at IS NULL) AS unread, MAX(e.received_at) AS latest
             FROM email_matches m
             JOIN emails e ON e.id = m.email_id AND e.status IN ('auto', 'confirmed', 'checking')
             JOIN applications a ON a.id = m.application_id
             LEFT JOIN jobs j ON j.id = a.job_id
             LEFT JOIN extractions x ON x.id = (SELECT MAX(id) FROM extractions WHERE email_id = e.id)
             WHERE ?1 IS NULL
                OR COALESCE(j.company, a.company, '') LIKE ?1 ESCAPE '\\' OR COALESCE(j.title, a.title, '') LIKE ?1 ESCAPE '\\'
                OR COALESCE(x.company, '') LIKE ?1 ESCAPE '\\' OR COALESCE(x.role, '') LIKE ?1 ESCAPE '\\'
                OR COALESCE(e.subject, '') LIKE ?1 ESCAPE '\\' OR COALESCE(e.from_addr, '') LIKE ?1 ESCAPE '\\'
                OR COALESCE(e.body_text, '') LIKE ?1 ESCAPE '\\'
             GROUP BY a.id
             ORDER BY latest DESC",
        )
        .bind(like_pattern(query))
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
                        COALESCE(j.title, a.title, '') AS title, a.status, a.applied_at, j.city
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
                applied_at: a.applied_at.clone(),
                city: a.city.clone(),
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

        let rows = list(&pool, None).unwrap();
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
        let ids: Vec<Option<i64>> = t.iter().map(|n| n.email_id).collect();
        assert_eq!(ids, [Some(first), Some(second)]); // oldest first; the rejected one is out
        assert_eq!((t[0].status.as_deref(), t[1].event_type.as_deref()), (Some("auto"), Some("interview")));

        // Manual events and the posting's first sighting are squares; an
        // event an email wrote is that email's diamond, not a node of its own.
        block_on(async {
            sqlx::query("INSERT INTO jobs (job_key, company, title, triple, first_seen) VALUES ('k', 'Acme', 'Backend Intern', 'k', '2026-08-20')")
                .execute(&pool).await.unwrap();
            sqlx::query("UPDATE applications SET job_id = 1 WHERE id = 1").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO application_events (application_id, type, occurred_at, origin) VALUES (1, 'applied', '2026-08-25T00:00:00Z', 'manual')")
                .execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO application_events (application_id, type, occurred_at, origin, email_id) VALUES (1, 'interview', '2026-09-10T00:00:00Z', 'email', ?)")
                .bind(second).execute(&pool).await.unwrap();
        });
        let t = timeline(&pool, 1).unwrap();
        let kinds: Vec<(&str, Option<&str>)> = t.iter().map(|n| (n.kind.as_str(), n.event_type.as_deref())).collect();
        assert_eq!(kinds, [("event", Some("first_seen")), ("event", Some("applied")), ("email", Some("applied")), ("email", Some("interview"))]);

        let j = jobs(&pool, None).unwrap();
        assert_eq!(j.len(), 2);
        assert_eq!((j[0].company.as_str(), j[0].emails), ("Beta", 1)); // latest activity first
        assert_eq!((j[1].emails, j[1].unread), (2, 1));

        // The detail carries its application's timeline.
        assert_eq!(detail(&pool, second).unwrap().unwrap().timeline.len(), 4);
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_covers_company_role_subject_sender_and_body() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).unwrap();
        let a = email(&pool, "a", "auto", "2026-09-01T00:00:00Z");
        let b = email(&pool, "b", "checking", "2026-09-02T00:00:00Z");
        let hidden = email(&pool, "h", "ignored", "2026-09-03T00:00:00Z");
        block_on(async {
            sqlx::query("UPDATE emails SET body_text = 'Your Robinhood interview is booked' WHERE id = ?").bind(b).execute(&pool).await.unwrap();
            sqlx::query("UPDATE emails SET body_text = 'Robinhood too', subject = '100% match' WHERE id = ?").bind(hidden).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO extractions (email_id, company, role, event_type) VALUES (?, 'Lyft', 'Data Engineer Intern', 'applied')")
                .bind(a).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO applications (company, title) VALUES ('Lyft', 'Data Engineer Intern')").execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO email_matches (email_id, application_id, score, reasons, action) VALUES (?, 1, 0.9, '[]', 'attach')")
                .bind(a).execute(&pool).await.unwrap();
        });
        let ids = |q: &str| list(&pool, Some(q)).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids("lyft"), [a]); // company (case-insensitive)
        assert_eq!(ids("data engineer"), [a]); // role
        assert_eq!(ids("subject b"), [b]); // subject
        assert_eq!(ids("acme.com"), [b, a]); // sender
        assert_eq!(ids("ROBINHOOD"), [b]); // body, and never ignored mail
        assert!(ids("100%").is_empty()); // % is literal, and that one is ignored
        assert!(ids("zzz").is_empty());
        assert_eq!(list(&pool, Some("   ")).unwrap().len(), 2); // blank = no search

        assert_eq!(jobs(&pool, Some("lyft")).unwrap().len(), 1);
        assert!(jobs(&pool, Some("robinhood")).unwrap().is_empty());
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
