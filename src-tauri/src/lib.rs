mod applications;
mod db;
mod gmail;
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

/// Every application with its timeline, for the pipeline and the record.
#[tauri::command]
async fn list_applications(
    pool: tauri::State<'_, SqlitePool>,
) -> Result<Vec<applications::ApplicationRow>, jobs::JobsError> {
    applications::list(&pool).await
}

/// [ → next stage ]. Returns the updated application.
#[tauri::command]
async fn advance_stage(
    pool: tauri::State<'_, SqlitePool>,
    id: i64,
) -> Result<applications::ApplicationRow, jobs::JobsError> {
    applications::advance(&pool, id).await
}

/// [ mark rejected ].
#[tauri::command]
async fn mark_rejected(
    pool: tauri::State<'_, SqlitePool>,
    id: i64,
) -> Result<applications::ApplicationRow, jobs::JobsError> {
    applications::reject(&pool, id).await
}

/// [ undo ]: drops the latest event.
#[tauri::command]
async fn undo_event(
    pool: tauri::State<'_, SqlitePool>,
    id: i64,
) -> Result<applications::ApplicationRow, jobs::JobsError> {
    applications::undo(&pool, id).await
}

/// [ + add application ] for something the scheduler never found.
#[tauri::command]
async fn add_application(
    pool: tauri::State<'_, SqlitePool>,
    company: String,
    title: String,
    applied_on: Option<String>,
) -> Result<applications::ApplicationRow, jobs::JobsError> {
    applications::add(&pool, &company, &title, applied_on.as_deref()).await
}

/// Notes on an application with no posting.
#[tauri::command]
async fn save_application_notes(
    pool: tauri::State<'_, SqlitePool>,
    id: i64,
    body: String,
) -> Result<(), jobs::JobsError> {
    applications::save_notes(&pool, id, &body).await
}

/// The OAuth client file, from `<config dir>/job-trackwsp/client_secret.json`
/// (`~/.config/...` on Linux), resolved with Tauri's path API.
fn gmail_credentials(app: &tauri::AppHandle) -> Result<gmail::credentials::ClientCredentials, gmail::GmailError> {
    let dir = app
        .path()
        .config_dir()
        .map_err(|e| gmail::GmailError::Io(format!("no config dir: {e}")))?;
    gmail::credentials::load(&gmail::credentials::path_in(&dir))
}

/// [ connect job account ]: runs the browser sign-in and returns the
/// connected address. Blocking (up to the 5-minute timeout), so not
/// `async`: Tauri runs it off the UI thread.
#[tauri::command]
fn gmail_connect(
    app: tauri::AppHandle,
    pool: tauri::State<'_, SqlitePool>,
    state: tauri::State<'_, gmail::GmailState>,
) -> Result<String, gmail::GmailError> {
    let creds = gmail_credentials(&app)?;
    gmail::connect(&state, &pool, &creds, |url| {
        app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
    })
}

/// The connected address, or null. A missing client file doesn't make this
/// fail: without it there's simply no way to check with Google.
#[tauri::command]
fn gmail_status(
    app: tauri::AppHandle,
    pool: tauri::State<'_, SqlitePool>,
    state: tauri::State<'_, gmail::GmailState>,
) -> Result<Option<String>, gmail::GmailError> {
    gmail::status(&state, &pool, gmail_credentials(&app).ok().as_ref())
}

/// [ disconnect ]: revoke at Google, then delete the keyring entry.
#[tauri::command]
fn gmail_disconnect(
    app: tauri::AppHandle,
    pool: tauri::State<'_, SqlitePool>,
    state: tauri::State<'_, gmail::GmailState>,
) -> Result<(), gmail::GmailError> {
    gmail::disconnect(&state, &pool, gmail_credentials(&app).ok().as_ref())
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
                "sheet sync: inserted={} updated={} merged={} skipped={} removed={}{}",
                counts.inserted,
                counts.updated,
                counts.merged,
                counts.skipped,
                counts.removed,
                if counts.removal_skipped { " (removal pass skipped)" } else { "" }
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
            open_posting,
            list_applications,
            advance_stage,
            mark_rejected,
            undo_event,
            add_application,
            save_application_notes,
            gmail_connect,
            gmail_status,
            gmail_disconnect
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
            app.manage(gmail::GmailState::new(Box::new(gmail::store::KeyringStore)));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
