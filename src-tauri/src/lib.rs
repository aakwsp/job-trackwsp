mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
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
      app.manage(pool);

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
