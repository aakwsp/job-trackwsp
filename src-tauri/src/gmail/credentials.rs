//! The OAuth client credentials for the Desktop app client created in the
//! Google Cloud console (JT-13). They live in
//! `~/.config/job-trackwsp/client_secret.json`, the file Google lets you
//! download, and are never copied into the repo.
//!
//! For an installed (desktop) app the "secret" isn't really secret, Google's
//! own docs say so, but it's still the user's file and stays out of git.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::GmailError;

#[derive(Debug, Clone, PartialEq)]
pub struct ClientCredentials {
    pub client_id: String,
    pub client_secret: String,
}

/// Where the file is expected: `<config dir>/job-trackwsp/client_secret.json`.
/// `config_dir` is the platform's config base (`~/.config` on Linux), from
/// Tauri's path API, so nothing here hardcodes a home directory.
pub fn path_in(config_dir: &Path) -> PathBuf {
    config_dir.join("job-trackwsp").join("client_secret.json")
}

/// Google's download wraps a desktop client in an `installed` object. A
/// "web" client has a `web` object instead and won't work with the
/// loopback flow, so it's rejected with a message saying so.
#[derive(Deserialize)]
struct File {
    installed: Option<Installed>,
    web: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct Installed {
    client_id: Option<String>,
    client_secret: Option<String>,
}

pub fn parse(json: &str) -> Result<ClientCredentials, GmailError> {
    let file: File = serde_json::from_str(json)
        .map_err(|e| GmailError::BadCredentials(format!("not valid JSON ({e})")))?;
    let Some(installed) = file.installed else {
        return Err(GmailError::BadCredentials(if file.web.is_some() {
            "this is a web client; create a Desktop app client instead".into()
        } else {
            "no `installed` section".into()
        }));
    };
    let field = |v: Option<String>, name: &str| {
        v.map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| GmailError::BadCredentials(format!("`installed.{name}` is missing")))
    };
    Ok(ClientCredentials {
        client_id: field(installed.client_id, "client_id")?,
        client_secret: field(installed.client_secret, "client_secret")?,
    })
}

/// Reads and parses the file. A missing file is its own error naming the
/// path, so the UI can say exactly where to put it.
pub fn load(path: &Path) -> Result<ClientCredentials, GmailError> {
    let json = std::fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GmailError::MissingCredentials(path.to_path_buf()),
        _ => GmailError::BadCredentials(format!("can't read {}: {e}", path.display())),
    })?;
    parse(&json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_installed_client() {
        let json = r#"{"installed":{"client_id":"123.apps.googleusercontent.com",
            "project_id":"job-trackwsp","client_secret":"GOCSPX-abc",
            "redirect_uris":["http://localhost"]}}"#;
        assert_eq!(
            parse(json).unwrap(),
            ClientCredentials {
                client_id: "123.apps.googleusercontent.com".into(),
                client_secret: "GOCSPX-abc".into(),
            }
        );
    }

    #[test]
    fn rejects_web_clients_missing_fields_and_garbage() {
        let msg = |json: &str| match parse(json) {
            Err(GmailError::BadCredentials(m)) => m,
            other => panic!("expected BadCredentials, got {other:?}"),
        };
        assert!(msg(r#"{"web":{"client_id":"x","client_secret":"y"}}"#).contains("Desktop app"));
        assert!(msg(r#"{"something":{}}"#).contains("installed"));
        assert!(msg(r#"{"installed":{"client_id":"x"}}"#).contains("client_secret"));
        assert!(msg(r#"{"installed":{"client_id":"  ","client_secret":"y"}}"#).contains("client_id"));
        assert!(msg("<html>nope</html>").contains("JSON"));
    }

    #[test]
    fn missing_file_names_the_path() {
        let path = std::env::temp_dir().join("job-trackwsp-no-such-dir/client_secret.json");
        match load(&path) {
            Err(GmailError::MissingCredentials(p)) => assert_eq!(p, path),
            other => panic!("expected MissingCredentials, got {other:?}"),
        }
    }

    #[test]
    fn path_is_under_the_app_folder() {
        assert_eq!(
            path_in(Path::new("/home/u/.config")),
            PathBuf::from("/home/u/.config/job-trackwsp/client_secret.json")
        );
    }
}
