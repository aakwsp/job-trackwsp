mod applications;
mod db;
mod extract;
mod gmail;
mod jobs;
mod mail;
mod sync;

use std::time::Duration;

use sqlx::SqlitePool;
use tauri::{Emitter, Manager};
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

/// Runs blocking work (network, the OAuth listener) on Tauri's blocking
/// thread pool and awaits it.
///
/// Why: a Tauri command that is a plain `fn` runs inline in the IPC
/// handler, on the main thread that also drives the window, so anything
/// slow in it freezes the whole UI until it returns (the macro's
/// `body_blocking`). `async fn` commands run on the async runtime instead,
/// and `spawn_blocking` moves the blocking part onto threads meant for it.
/// The closure gets the `AppHandle` to look up managed state, because
/// `State<'_, T>` borrows can't move onto another thread.
async fn off_main_thread<T, E>(
    app: tauri::AppHandle,
    work: impl FnOnce(&tauri::AppHandle) -> Result<T, E> + Send + 'static,
    join_error: impl FnOnce(String) -> E,
) -> Result<T, E>
where
    T: Send + 'static,
    E: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || work(&app))
        .await
        .unwrap_or_else(|e| Err(join_error(e.to_string())))
}

/// Manual "sync now" from the UI. The sync itself is blocking (see `sync`'s
/// module doc; up to ~30s with Apps Script retries), so it runs off the main
/// thread.
#[tauri::command]
async fn sync_now(app: tauri::AppHandle) -> Result<sync::SyncCounts, sync::SyncError> {
    off_main_thread(
        app,
        |app| {
            let url = std::env::var("URL").map_err(|_| sync::SyncError::Config("URL not set".into()))?;
            let token =
                std::env::var("TOKEN").map_err(|_| sync::SyncError::Config("TOKEN not set".into()))?;
            sync::run_sync_blocking(&app.state::<SqlitePool>(), &url, &token)
        },
        |e| sync::SyncError::Config(format!("sync task failed: {e}")),
    )
    .await
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

fn gmail_join_error(e: String) -> gmail::GmailError {
    gmail::GmailError::Io(format!("gmail task failed: {e}"))
}

/// [ connect job account ]: runs the browser sign-in and returns the
/// connected address. Waits up to 5 minutes for the browser, off the main
/// thread (see `off_main_thread`) so the window stays usable meanwhile.
#[tauri::command]
async fn gmail_connect(app: tauri::AppHandle) -> Result<String, gmail::GmailError> {
    off_main_thread(
        app,
        |app| {
            let creds = gmail_credentials(app)?;
            let address =
                gmail::connect(&app.state::<gmail::GmailState>(), &app.state::<SqlitePool>(), &creds, |url| {
                    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
                })?;
            // Start the first poll (the backfill) now rather than at the
            // next 10-minute tick. Its own thread: connect returns at once,
            // and the status line follows along via `mail-polled`.
            let app = app.clone();
            std::thread::spawn(move || {
                if let Err(e) = poll_mail(&app) {
                    log::error!("mail poll after connecting failed: {e}");
                }
            });
            Ok(address)
        },
        gmail_join_error,
    )
    .await
}

/// [ cancel ] while the browser sign-in is open: the waiting
/// `gmail_connect` stops within ~100ms and closes its listener. Just sets a
/// flag, so it's fine as a plain (main-thread) command.
#[tauri::command]
fn gmail_cancel(state: tauri::State<'_, gmail::GmailState>) {
    state.cancel_connect();
}

/// The connected address, or null. A missing client file doesn't make this
/// fail: without it there's simply no way to check with Google. May call
/// Google (token refresh), hence off the main thread.
#[tauri::command]
async fn gmail_status(app: tauri::AppHandle) -> Result<Option<String>, gmail::GmailError> {
    off_main_thread(
        app,
        |app| {
            gmail::status(
                &app.state::<gmail::GmailState>(),
                &app.state::<SqlitePool>(),
                gmail_credentials(app).ok().as_ref(),
            )
        },
        gmail_join_error,
    )
    .await
}

/// [ disconnect ]: revoke at Google, then delete the keyring entry.
#[tauri::command]
async fn gmail_disconnect(app: tauri::AppHandle) -> Result<(), gmail::GmailError> {
    off_main_thread(
        app,
        |app| {
            gmail::disconnect(
                &app.state::<gmail::GmailState>(),
                &app.state::<SqlitePool>(),
                gmail_credentials(app).ok().as_ref(),
            )
        },
        gmail_join_error,
    )
    .await
}

/// "last checked hh:mm · n new" for the QUEUE status line.
#[tauri::command]
async fn mail_status(app: tauri::AppHandle) -> Result<mail::MailStatus, mail::MailError> {
    off_main_thread(
        app,
        full_mail_status,
        |e| mail::MailError::Api(mail::api::ApiError::Http(format!("mail task failed: {e}"))),
    )
    .await
}

/// [ check mail ]: one poll now (or nothing, if one is already running),
/// then the fresh status. The `mail-polled` event also fires.
#[tauri::command]
async fn mail_check(app: tauri::AppHandle) -> Result<mail::MailStatus, mail::MailError> {
    off_main_thread(
        app,
        |app| {
            let result = poll_mail(app);
            let status = full_mail_status(app)?;
            result.map(|()| status)
        },
        |e| mail::MailError::Api(mail::api::ApiError::Http(format!("mail task failed: {e}"))),
    )
    .await
}

/// Un-ignores one email: re-fetched from Gmail by id, since ignored mail is
/// stored without its content. Refuses blocked mail. For JT-18's recover
/// action; no UI calls it yet.
#[tauri::command]
async fn mail_restore(app: tauri::AppHandle, gmail_id: String) -> Result<(), mail::MailError> {
    off_main_thread(
        app,
        move |app| {
            let creds = gmail_credentials(app).map_err(mail::MailError::Gmail)?;
            mail::restore(&app.state::<gmail::GmailState>(), &app.state::<SqlitePool>(), &creds, &gmail_id)
        },
        |e| mail::MailError::Api(mail::api::ApiError::Http(format!("mail task failed: {e}"))),
    )
    .await
}

/// One poll with everything it needs from managed state, then a
/// `mail-polled` event so the UI refreshes its status line whichever
/// trigger started the poll. Blocking.
fn poll_mail(app: &tauri::AppHandle) -> Result<(), mail::MailError> {
    let result = mail::poll(
        &app.state::<gmail::GmailState>(),
        &app.state::<mail::MailState>(),
        &app.state::<SqlitePool>(),
        gmail_credentials(app).ok().as_ref(),
    );
    emit_mail_status(app);
    // Then hand the pending mail to the LLM, on its own thread so a manual
    // [ check mail ] returns as soon as the poll is done.
    spawn_extraction(app.clone());
    result
}

/// The status line's data: the poller's numbers plus the extraction state.
fn full_mail_status(app: &tauri::AppHandle) -> Result<mail::MailStatus, mail::MailError> {
    let mut status = mail::status(&app.state::<mail::MailState>(), &app.state::<SqlitePool>())?;
    let ex = app.state::<extract::ExtractState>();
    status.extracting = ex.is_running();
    status.extract_error = ex.last_error();
    // A keyring that can't be read counts as "no key" here; saving one
    // will report the keyring problem properly.
    status.needs_key = !extract::has_key(&gmail::store::KeyringStore).unwrap_or(false);
    Ok(status)
}

fn emit_mail_status(app: &tauri::AppHandle) {
    if let Ok(status) = full_mail_status(app) {
        let _ = app.emit("mail-polled", status);
    }
}

/// One extraction run over the pending mail (JT-15), then a status event.
/// Does nothing if one is already running or there's no Gemini key.
fn spawn_extraction(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let make_client = |key: String| -> Result<Box<dyn extract::gemini::LlmClient>, extract::gemini::CallError> {
            Ok(Box::new(extract::gemini::GeminiHttp::new(key)?))
        };
        let started = !app.state::<extract::ExtractState>().is_running();
        if started {
            // Let the status line show "parsing…" while it runs.
            emit_mail_status(&app);
        }
        if let Err(e) = extract::run(
            &app.state::<extract::ExtractState>(),
            &app.state::<SqlitePool>(),
            &gmail::store::KeyringStore,
            &make_client,
            &std::thread::sleep,
        ) {
            log::error!("extraction stopped: {e}");
        }
        emit_mail_status(&app);
    });
}

/// Whether a Gemini key is stored (the QUEUE page asks for one if not).
#[tauri::command]
async fn llm_key_status(app: tauri::AppHandle) -> Result<bool, String> {
    off_main_thread(app, |_| extract::has_key(&gmail::store::KeyringStore), |e| e).await
}

/// [ save key ]: stores the Gemini key in the OS keyring (service
/// job-trackwsp, user gemini-api-key), then starts extracting. The key is
/// never logged or written anywhere else.
#[tauri::command]
async fn llm_save_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    off_main_thread(
        app,
        move |app| {
            extract::save_key(&gmail::store::KeyringStore, &key)?;
            spawn_extraction(app.clone());
            Ok(())
        },
        |e| e,
    )
    .await
}

/// Polls on app start, then every `POLL_INTERVAL`, on its own thread (like
/// the sheet sync). Disconnected Gmail makes each poll a quiet no-op.
fn spawn_mail_poller(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        if let Err(e) = poll_mail(&app) {
            log::error!("mail poll failed: {e}");
        }
        std::thread::sleep(mail::POLL_INTERVAL);
    });
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
            gmail_cancel,
            gmail_status,
            gmail_disconnect,
            mail_status,
            mail_check,
            mail_restore,
            llm_key_status,
            llm_save_key
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
            app.manage(mail::MailState::default());
            app.manage(extract::ExtractState::default());
            spawn_mail_poller(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    /// The pattern `off_main_thread` relies on: blocking code on the
    /// blocking pool calling `block_on` for its SQLx work (as `sync` and
    /// `gmail` do) must not panic with "runtime within a runtime".
    #[test]
    fn block_on_inside_spawn_blocking() {
        let n = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| tauri::async_runtime::block_on(async { 41 + 1 }))
                .await
                .unwrap()
        });
        assert_eq!(n, 42);
    }
}
