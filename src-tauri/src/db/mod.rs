//! Connection + migrations for the local SQLite database.
//!
//! Ported from `backend/src/db/client.ts` (JT-24 Drizzle scaffold, removed in
//! JT-25): same pragmas (WAL, foreign keys on), same idea of a single pooled
//! connection managed as Tauri state. The schema itself moved to
//! `migrations/0001_init.sql`, translated column-for-column from
//! `backend/src/db/schema.ts`.

use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

/// Filename of the SQLite database inside the platform app-data dir. Never
/// the repo — CLAUDE.md is explicit that this isn't a checked-in file like
/// the old `backend/data.sqlite` was.
const DB_FILENAME: &str = "data.sqlite";

/// Opens (creating if needed) the database under `app_data_dir` and runs any
/// pending migrations. `app_data_dir` is expected to already resolve to the
/// platform-specific app-data directory (see `tauri::Manager::path`).
pub async fn connect(app_data_dir: &Path) -> sqlx::Result<SqlitePool> {
    std::fs::create_dir_all(app_data_dir).map_err(sqlx::Error::Io)?;
    let db_path = app_data_dir.join(DB_FILENAME);

    let options = SqliteConnectOptions::from_str(&db_path.to_string_lossy())?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        // Overwrite deleted or replaced content with zeros instead of
        // leaving it in free pages. Ignored and blocked mail has its body
        // cleared (mail::refilter); this makes the clearing real on disk.
        .pragma("secure_delete", "ON");

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // Path is relative to CARGO_MANIFEST_DIR (src-tauri/), not to this file.
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No `tempfile` crate on hand, so a PID + timestamp-suffixed dir under
    /// the OS temp dir stands in for one; cleaned up at the end of the test.
    fn scratch_dir() -> std::path::PathBuf {
        let unique = format!(
            "job-trackwsp-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn connect_creates_db_and_runs_migrations() {
        let dir = scratch_dir();
        let pool = tauri::async_runtime::block_on(connect(&dir)).expect("connect");

        assert!(dir.join(DB_FILENAME).exists());

        let tables: Vec<String> = tauri::async_runtime::block_on(async {
            sqlx::query_scalar(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%' ORDER BY name",
            )
            .fetch_all(&pool)
            .await
            .expect("list tables")
        });
        assert_eq!(
            tables,
            vec![
                "application_events",
                "applications",
                "email_matches",
                "emails",
                "extractions",
                "job_notes",
                "jobs",
                "llm_match_hints",
                "settings",
            ]
        );

        // Foreign keys pragma is per-connection, not persisted — confirm the
        // option actually took on this pool rather than trusting the builder.
        let fk_on: i64 = tauri::async_runtime::block_on(async {
            sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&pool)
                .await
                .expect("read pragma")
        });
        assert_eq!(fk_on, 1);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
