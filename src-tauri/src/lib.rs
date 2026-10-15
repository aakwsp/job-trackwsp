mod db;
mod jobs;
mod sync;

use std::time::Duration;

use sqlx::SqlitePool;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const SYNC_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Minimal `.env` loader — the repo root's `.env` is just `URL=`/`TOKEN=`,
/// no quoting or interpolation, so pulling in a full dotenv crate for it
/// would be the only reason SQLx/reqwest/Tauri weren't already covering
/// everything CLAUDE.md names as this app's dependencies. Only sets a var
/// that isn't already in the environment, so a real `export` still wins.
///
/// Resolves `.env` relative to the build-time crate path, so this only
/// finds it when running from a source checkout (`npm run dev` / `cargo
/// tauri dev`) — a packaged, installed build has no repo root to find and
/// needs a real settings story, which is out of scope for JT-25.
fn load_dotenv() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        log::warn!(
            ".env not found at {} — URL/TOKEN must be set another way",
            path.display()
        );
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            if std::env::var(key).is_err() {
                std::env::set_var(key, value.trim());
            }
        }
    }
}

/// Manual "sync now" from the UI. Deliberately not `async fn`: everything
/// this calls is blocking (see `sync`'s module doc), and a non-async Tauri
/// command is dispatched by Tauri on a thread where that's fine, without us
/// needing to add tokio just to `.await` it.
#[tauri::command]
fn sync_now(pool: tauri::State<'_, SqlitePool>) -> Result<sync::SyncCounts, sync::SyncError> {
    let url = std::env::var("URL").map_err(|_| sync::SyncError::Config("URL not set".into()))?;
    let token =
        std::env::var("TOKEN").map_err(|_| sync::SyncError::Config("TOKEN not set".into()))?;
    sync::run_sync_blocking(&pool, &url, &token)
}

/// Every non-hidden job for the list view, with its `applied` flag. These
/// three are `async fn` (unlike `sync_now`) because they only touch SQLx,
/// which is async already — nothing blocking to keep off the runtime.
#[tauri::command]
async fn list_jobs(
    pool: tauri::State<'_, SqlitePool>,
) -> Result<Vec<jobs::JobRow>, jobs::JobsError> {
    jobs::list(&pool).await
}

/// Creates or removes the `applications` row for a job. Never writes `jobs`.
#[tauri::command]
async fn set_applied(
    pool: tauri::State<'_, SqlitePool>,
    job_id: i64,
    applied: bool,
) -> Result<(), jobs::JobsError> {
    jobs::set_applied(&pool, job_id, applied).await
}

/// Saves the note on a job (applied or not). Blank clears it.
#[tauri::command]
async fn save_notes(
    pool: tauri::State<'_, SqlitePool>,
    job_id: i64,
    body: String,
) -> Result<(), jobs::JobsError> {
    jobs::save_notes(&pool, job_id, &body).await
}

/// Opens a posting in the system browser. Done from Rust rather than
/// exposing the opener plugin to the frontend, so the http(s) check can't be
/// bypassed and no capability has to be granted to the webview.
#[tauri::command]
fn open_posting(app: tauri::AppHandle, url: String) -> Result<(), jobs::JobsError> {
    jobs::check_url(&url)?;
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|e| jobs::JobsError::Open(e.to_string()))
}

/// Runs once at startup, then every `SYNC_INTERVAL` — its own OS thread
/// rather than a tokio interval, same reasoning as `sync_now`. If URL/TOKEN
/// aren't set, logs once and never starts looping rather than spinning on a
/// config error forever.
fn spawn_background_sync(pool: SqlitePool) {
    let (Ok(url), Ok(token)) = (std::env::var("URL"), std::env::var("TOKEN")) else {
        log::warn!("URL/TOKEN not set — background sheet sync disabled");
        return;
    };

    std::thread::spawn(move || loop {
        match sync::run_sync_blocking(&pool, &url, &token) {
            Ok(counts) => log::info!(
                "sheet sync: inserted={} updated={} merged={} skipped={}",
                counts.inserted,
                counts.updated,
                counts.merged,
                counts.skipped
            ),
            Err(e) => log::error!("sheet sync failed: {e}"),
        }
        std::thread::sleep(SYNC_INTERVAL);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_dotenv();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            sync_now,
            list_jobs,
            set_applied,
            save_notes,
            open_posting
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Opening the DB and running migrations is quick, but still I/O — the
            // rest of `setup` (window creation etc.) shouldn't block on it, so we
            // use `block_on` rather than making `run()` itself async. Tauri
            // already runs on a tokio runtime under the hood, so this doesn't add
            // a second one.
            let app_data_dir = app.path().app_data_dir()?;
            let pool = tauri::async_runtime::block_on(db::connect(&app_data_dir))
                .expect("failed to set up the database");

            spawn_background_sync(pool.clone());
            app.manage(pool);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
