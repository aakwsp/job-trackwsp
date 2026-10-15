//! Read-only Gmail access to the job account (JT-13).
//!
//! Connecting is the OAuth "loopback" flow for desktop apps: listen on
//! 127.0.0.1 at a random port, open the system browser at Google's consent
//! page with that address as the redirect, and catch the redirect carrying
//! the one-time code. PKCE ties the code to this run, and a random `state`
//! guards against a forged redirect. The code is exchanged for tokens:
//!
//! - the refresh token goes in the OS keyring (`store`), under the connected
//!   address; it's what survives restarts
//! - the access token (about an hour) stays in memory and is refreshed from
//!   the keyring on demand
//!
//! Tokens are never logged, and never written to a file or the database.
//! The connected address (not a secret) is kept in `settings` so the app
//! knows which keyring entry to read.
//!
//! Everything here is blocking (reqwest::blocking, a std TcpListener), same
//! reasoning as `sync`: the Tauri commands are non-async, so Tauri already
//! runs them off the UI thread.

pub mod credentials;
pub mod store;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use oauth2::basic::{BasicClient, BasicErrorResponseType};
use oauth2::url::Url;
use oauth2::{
    reqwest, AccessToken, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet,
    EndpointSet, PkceCodeChallenge, RedirectUrl, RefreshToken, RequestTokenError, RevocationUrl, Scope,
    StandardRevocableToken, TokenResponse, TokenUrl,
};
use serde::Serialize;
use sqlx::SqlitePool;

use credentials::ClientCredentials;
use store::TokenStore;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const PROFILE_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
/// The only scope asked for: read mail, nothing else.
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
/// How long to wait for the browser to come back before giving up and
/// closing the listener.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh this long before Google's stated expiry, so a token is never
/// used in its last seconds.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);
const ADDRESS_KEY: &str = "gmail_address";

#[derive(Debug)]
pub enum GmailError {
    MissingCredentials(PathBuf),
    BadCredentials(String),
    Keyring(String),
    /// No connection, or Google said the grant is gone (`invalid_grant`:
    /// revoked, or expired after 7 days while the consent screen is in
    /// Testing). Either way: show connect again.
    NotConnected,
    AlreadyConnecting,
    Timeout,
    Denied(String),
    StateMismatch,
    NoRefreshToken,
    Http(String),
    Io(String),
    Db(sqlx::Error),
}

impl std::fmt::Display for GmailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GmailError::MissingCredentials(p) => write!(
                f,
                "no OAuth client file at {} — download the Desktop app client JSON from the Google Cloud console and put it there",
                p.display()
            ),
            GmailError::BadCredentials(m) => write!(f, "client_secret.json: {m}"),
            GmailError::Keyring(m) => write!(f, "keyring: {m}"),
            GmailError::NotConnected => write!(f, "gmail not connected"),
            GmailError::AlreadyConnecting => write!(f, "already connecting — finish in the browser tab"),
            GmailError::Timeout => write!(f, "no answer from the browser within 5 minutes — try connecting again"),
            GmailError::Denied(why) => write!(f, "google did not grant access ({why})"),
            GmailError::StateMismatch => write!(f, "the redirect didn't match this sign-in attempt — try again"),
            GmailError::NoRefreshToken => write!(f, "google returned no refresh token — try connecting again"),
            GmailError::Http(m) => write!(f, "{m}"),
            GmailError::Io(m) => write!(f, "{m}"),
            GmailError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for GmailError {}

// Same as the other command errors: the frontend only needs the message.
impl Serialize for GmailError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<sqlx::Error> for GmailError {
    fn from(e: sqlx::Error) -> Self {
        GmailError::Db(e)
    }
}

/// Process-wide Gmail state, managed by Tauri. Holds the in-memory access
/// token; the refresh token is only ever read from the keyring when needed.
pub struct GmailState {
    access: Mutex<Option<Cached>>,
    connecting: AtomicBool,
    store: Box<dyn TokenStore>,
}

struct Cached {
    address: String,
    token: AccessToken,
    good_until: Instant,
}

impl GmailState {
    pub fn new(store: Box<dyn TokenStore>) -> Self {
        GmailState {
            access: Mutex::new(None),
            connecting: AtomicBool::new(false),
            store,
        }
    }
}

type GoogleClient = BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointSet, EndpointSet>;

fn google_client(creds: &ClientCredentials, redirect: Option<RedirectUrl>) -> GoogleClient {
    let client = BasicClient::new(ClientId::new(creds.client_id.clone()))
        .set_client_secret(ClientSecret::new(creds.client_secret.clone()))
        .set_auth_uri(AuthUrl::new(AUTH_URL.into()).expect("static url"))
        .set_token_uri(TokenUrl::new(TOKEN_URL.into()).expect("static url"))
        .set_revocation_url(RevocationUrl::new(REVOKE_URL.into()).expect("static url"));
    match redirect {
        Some(r) => client.set_redirect_uri(r),
        None => client,
    }
}

fn http() -> Result<reqwest::blocking::Client, GmailError> {
    reqwest::blocking::Client::builder()
        // Following redirects on token requests is an SSRF risk; oauth2's
        // docs ask for it off.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| GmailError::Http(e.to_string()))
}

/// The whole connect flow. Returns the connected address.
pub fn connect(
    state: &GmailState,
    pool: &SqlitePool,
    creds: &ClientCredentials,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, GmailError> {
    // One flow at a time: a second click while the browser tab is open
    // would otherwise start a second listener.
    if state.connecting.swap(true, Ordering::SeqCst) {
        return Err(GmailError::AlreadyConnecting);
    }
    let result = connect_inner(state, pool, creds, open_browser);
    state.connecting.store(false, Ordering::SeqCst);
    result
}

fn connect_inner(
    state: &GmailState,
    pool: &SqlitePool,
    creds: &ClientCredentials,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, GmailError> {
    // Port 0: the OS picks a free one. Bound to 127.0.0.1 only, so nothing
    // off this machine can reach it.
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| GmailError::Io(format!("can't listen: {e}")))?;
    let port = listener.local_addr().map_err(|e| GmailError::Io(e.to_string()))?.port();
    let redirect = RedirectUrl::new(format!("http://127.0.0.1:{port}/")).expect("valid url");
    let client = google_client(creds, Some(redirect));

    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(SCOPE.into()))
        .set_pkce_challenge(challenge)
        // offline + consent: Google only returns a refresh token when asked
        // for offline access, and only reliably on a fresh consent.
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .url();

    open_browser(url.as_str()).map_err(|e| GmailError::Io(format!("couldn't open the browser: {e}")))?;
    // `listener` is moved in and dropped when this returns, closing the
    // port whether it succeeded, failed or timed out.
    let code = wait_for_redirect(listener, &csrf, CONNECT_TIMEOUT)?;

    let http = http()?;
    let tokens = client
        .exchange_code(code)
        .set_pkce_verifier(verifier)
        .request(&http)
        .map_err(|e| GmailError::Http(format!("token exchange failed: {}", token_error_text(&e))))?;
    let refresh = tokens.refresh_token().ok_or(GmailError::NoRefreshToken)?;
    let address = profile_address(&http, tokens.access_token())?;

    // Keyring first: if there's no Secret Service this fails here and
    // nothing is recorded as connected.
    save_connection(state.store.as_ref(), pool, &address, refresh.secret())?;
    *state.access.lock().unwrap() = Some(Cached {
        address: address.clone(),
        token: tokens.access_token().clone(),
        good_until: good_until(tokens.expires_in()),
    });
    Ok(address)
}

fn good_until(expires_in: Option<Duration>) -> Instant {
    Instant::now() + expires_in.unwrap_or(Duration::from_secs(3600)).saturating_sub(EXPIRY_MARGIN)
}

/// Accepts connections until the OAuth redirect arrives, the user denies,
/// or `timeout` passes. Anything that isn't the redirect (a favicon
/// request, say) gets a 404 and the wait goes on.
fn wait_for_redirect(listener: TcpListener, csrf: &CsrfToken, timeout: Duration) -> Result<AuthorizationCode, GmailError> {
    listener.set_nonblocking(true).map_err(|e| GmailError::Io(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    loop {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(GmailError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(GmailError::Io(e.to_string())),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            continue;
        }
        // "GET /?state=...&code=... HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or("/");
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
            respond(&mut stream, 400, "bad request");
            continue;
        };
        if url.path() != "/" {
            respond(&mut stream, 404, "not found");
            continue;
        }
        let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());

        if let Some(error) = param("error") {
            respond(&mut stream, 200, "not connected. you can close this tab.");
            return Err(GmailError::Denied(error));
        }
        if param("state").as_deref() != Some(csrf.secret().as_str()) {
            respond(&mut stream, 400, "this sign-in link is stale. you can close this tab.");
            return Err(GmailError::StateMismatch);
        }
        let Some(code) = param("code") else {
            respond(&mut stream, 400, "no code in the redirect. you can close this tab.");
            continue;
        };
        respond(&mut stream, 200, "connected, you can close this tab.");
        return Ok(AuthorizationCode::new(code));
    }
}

/// The tiny page the browser lands on: the app's colours and type, one line.
fn respond(stream: &mut std::net::TcpStream, status: u16, message: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>job tracker</title>\
         <body style=\"margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
         background:#141216;color:#d8cab8;font:14px 'Space Mono',monospace\">{message}</body>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// `users/me/profile` → the address the token belongs to.
fn profile_address(http: &reqwest::blocking::Client, token: &AccessToken) -> Result<String, GmailError> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Profile {
        email_address: String,
    }
    let resp = http
        .get(PROFILE_URL)
        .bearer_auth(token.secret())
        .send()
        .map_err(|e| GmailError::Http(format!("gmail profile request failed: {e}")))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(GmailError::NotConnected);
    }
    let resp = resp
        .error_for_status()
        .map_err(|e| GmailError::Http(format!("gmail profile request failed: {e}")))?;
    // reqwest is built without its `json` feature here, so parse the text.
    let body = resp
        .text()
        .map_err(|e| GmailError::Http(format!("gmail profile request failed: {e}")))?;
    Ok(serde_json::from_str::<Profile>(&body)
        .map_err(|e| GmailError::Http(format!("unexpected gmail profile response: {e}")))?
        .email_address)
}

/// A token-endpoint error as text. Only the error code and Google's
/// description, never the request or the raw body, so nothing secret can
/// end up in a message or a log.
fn token_error_text<RE: std::error::Error + 'static>(
    e: &RequestTokenError<RE, oauth2::StandardErrorResponse<BasicErrorResponseType>>,
) -> String {
    match e {
        RequestTokenError::ServerResponse(r) => match r.error_description() {
            Some(d) => format!("{} ({d})", r.error()),
            None => r.error().to_string(),
        },
        RequestTokenError::Request(_) => "network error".into(),
        RequestTokenError::Parse(_, _) => "unexpected response from google".into(),
        RequestTokenError::Other(m) => m.clone(),
    }
}

fn is_invalid_grant<RE: std::error::Error + 'static>(
    e: &RequestTokenError<RE, oauth2::StandardErrorResponse<BasicErrorResponseType>>,
) -> bool {
    matches!(e, RequestTokenError::ServerResponse(r) if *r.error() == BasicErrorResponseType::InvalidGrant)
}

/// A valid access token for the connected account: the cached one, or a
/// fresh one from the keyring's refresh token. `invalid_grant` means the
/// grant is gone, so the connection is forgotten and the caller gets
/// `NotConnected`. Nothing calls this for mail yet; the email poller will.
pub fn access_token(state: &GmailState, pool: &SqlitePool, creds: &ClientCredentials) -> Result<AccessToken, GmailError> {
    let address = connected_address(state.store.as_ref(), pool)?.ok_or(GmailError::NotConnected)?;
    if let Some(c) = state.access.lock().unwrap().as_ref() {
        if c.address == address && Instant::now() < c.good_until {
            return Ok(c.token.clone());
        }
    }
    let refresh = state.store.get(&address)?.ok_or(GmailError::NotConnected)?;
    let fresh = google_client(creds, None)
        .exchange_refresh_token(&RefreshToken::new(refresh))
        .request(&http()?);
    let tokens = match fresh {
        Ok(t) => t,
        Err(e) if is_invalid_grant(&e) => {
            forget(state, pool, &address)?;
            return Err(GmailError::NotConnected);
        }
        Err(e) => return Err(GmailError::Http(format!("token refresh failed: {}", token_error_text(&e)))),
    };
    let token = tokens.access_token().clone();
    *state.access.lock().unwrap() = Some(Cached {
        address,
        token: token.clone(),
        good_until: good_until(tokens.expires_in()),
    });
    Ok(token)
}

/// The connected address, or None. Checks with Google (by getting an access
/// token, cached for the hour), so a revoked or expired grant shows as
/// disconnected. If Google can't be reached, the stored connection is
/// reported as is rather than calling an offline machine disconnected.
pub fn status(state: &GmailState, pool: &SqlitePool, creds: Option<&ClientCredentials>) -> Result<Option<String>, GmailError> {
    let Some(address) = connected_address(state.store.as_ref(), pool)? else {
        return Ok(None);
    };
    let Some(creds) = creds else {
        return Ok(Some(address));
    };
    match access_token(state, pool, creds) {
        Ok(_) => Ok(Some(address)),
        Err(GmailError::NotConnected) => Ok(None),
        Err(e) => {
            log::warn!("gmail status: couldn't confirm the connection: {e}");
            Ok(Some(address))
        }
    }
}

/// Revokes the grant at Google, then forgets it locally. The local part
/// happens even if Google can't be reached: disconnect should always leave
/// the app disconnected.
pub fn disconnect(state: &GmailState, pool: &SqlitePool, creds: Option<&ClientCredentials>) -> Result<(), GmailError> {
    let Some(address) = connected_address(state.store.as_ref(), pool)? else {
        return Ok(());
    };
    if let (Some(creds), Some(refresh)) = (creds, state.store.get(&address)?) {
        let revoked = google_client(creds, None)
            .revoke_token(StandardRevocableToken::RefreshToken(RefreshToken::new(refresh)))
            .map_err(|e| e.to_string())
            .and_then(|req| http().map_err(|e| e.to_string()).and_then(|h| req.request(&h).map_err(|_| "request failed".to_string())));
        if let Err(e) = revoked {
            log::warn!("gmail disconnect: revoking at google failed ({e}); forgetting locally anyway");
        }
    }
    forget(state, pool, &address)
}

// ── connection bookkeeping (tested with the mock store) ──────────────────

/// Records a new connection: token into the keyring, then the address into
/// `settings`. If the keyring refuses, nothing is recorded.
fn save_connection(store: &dyn TokenStore, pool: &SqlitePool, address: &str, refresh: &str) -> Result<(), GmailError> {
    store.set(address, refresh)?;
    block_on(
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(ADDRESS_KEY)
            .bind(address)
            .execute(pool),
    )?;
    Ok(())
}

/// The stored address, if its keyring entry still exists. An address with
/// no token (deleted from the keyring by hand, say) is cleaned up and
/// reported as not connected.
fn connected_address(store: &dyn TokenStore, pool: &SqlitePool) -> Result<Option<String>, GmailError> {
    let address: Option<String> = block_on(
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(ADDRESS_KEY)
            .fetch_optional(pool),
    )?;
    let Some(address) = address else { return Ok(None) };
    if store.get(&address)?.is_some() {
        Ok(Some(address))
    } else {
        clear_address(pool)?;
        Ok(None)
    }
}

fn forget(state: &GmailState, pool: &SqlitePool, address: &str) -> Result<(), GmailError> {
    *state.access.lock().unwrap() = None;
    state.store.delete(address)?;
    clear_address(pool)
}

fn clear_address(pool: &SqlitePool) -> Result<(), GmailError> {
    block_on(sqlx::query("DELETE FROM settings WHERE key = ?").bind(ADDRESS_KEY).execute(pool))?;
    Ok(())
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

#[cfg(test)]
mod tests {
    use super::store::mock::MockStore;
    use super::*;
    use crate::db;

    fn scratch_dir() -> PathBuf {
        let unique = format!(
            "job-trackwsp-gmail-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        std::env::temp_dir().join(unique)
    }

    fn state(store: MockStore) -> GmailState {
        GmailState::new(Box::new(store))
    }

    #[test]
    fn save_status_and_forget() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        let st = state(MockStore::default());

        assert_eq!(connected_address(st.store.as_ref(), &pool).unwrap(), None);
        save_connection(st.store.as_ref(), &pool, "jobs@example.com", "refresh-1").unwrap();
        assert_eq!(
            connected_address(st.store.as_ref(), &pool).unwrap().as_deref(),
            Some("jobs@example.com")
        );
        // No credentials → status reports the stored connection as is.
        assert_eq!(status(&st, &pool, None).unwrap().as_deref(), Some("jobs@example.com"));

        // Disconnect without credentials skips the revoke but still forgets.
        disconnect(&st, &pool, None).unwrap();
        assert_eq!(st.store.get("jobs@example.com").unwrap(), None);
        assert_eq!(status(&st, &pool, None).unwrap(), None);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn address_without_a_keyring_entry_is_not_connected() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        let st = state(MockStore::default());

        save_connection(st.store.as_ref(), &pool, "jobs@example.com", "refresh-1").unwrap();
        st.store.delete("jobs@example.com").unwrap(); // removed from the keyring by hand
        assert_eq!(connected_address(st.store.as_ref(), &pool).unwrap(), None);
        // ...and the stale address was cleaned up.
        let left: Option<String> = block_on(
            sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
                .bind(ADDRESS_KEY)
                .fetch_optional(&pool),
        )
        .unwrap();
        assert_eq!(left, None);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_secret_service_records_nothing() {
        let dir = scratch_dir();
        let pool = block_on(db::connect(&dir)).expect("connect");
        let st = state(MockStore {
            unavailable: true,
            ..Default::default()
        });

        let err = save_connection(st.store.as_ref(), &pool, "jobs@example.com", "refresh-1").unwrap_err();
        assert!(matches!(err, GmailError::Keyring(_)));
        // Not connected, and the token went nowhere else: no address saved.
        let rows: i64 = block_on(sqlx::query_scalar("SELECT COUNT(*) FROM settings").fetch_one(&pool)).unwrap();
        assert_eq!(rows, 0);

        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn redirect_listener_times_out_and_closes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let csrf = CsrfToken::new("s".into());
        assert!(matches!(
            wait_for_redirect(listener, &csrf, Duration::from_millis(200)),
            Err(GmailError::Timeout)
        ));
        // The listener was dropped with the call: the port no longer accepts.
        assert!(std::net::TcpStream::connect(addr).is_err());
    }

    #[test]
    fn redirect_listener_checks_state_and_skips_other_paths() {
        use std::io::Read;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let get = |path: &str| {
                let mut s = std::net::TcpStream::connect(addr).unwrap();
                write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
                let mut body = String::new();
                let _ = s.read_to_string(&mut body);
                body
            };
            assert!(get("/favicon.ico").starts_with("HTTP/1.1 404"));
            get("/?state=right&code=the-code")
        });
        let code = wait_for_redirect(listener, &CsrfToken::new("right".into()), Duration::from_secs(5)).unwrap();
        assert_eq!(code.secret(), "the-code");
        assert!(client.join().unwrap().contains("connected, you can close this tab."));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut s = std::net::TcpStream::connect(addr).unwrap();
            write!(s, "GET /?state=forged&code=x HTTP/1.1\r\n\r\n").unwrap();
        });
        assert!(matches!(
            wait_for_redirect(listener, &CsrfToken::new("right".into()), Duration::from_secs(5)),
            Err(GmailError::StateMismatch)
        ));
    }
}
