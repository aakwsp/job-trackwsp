//! Where the refresh token lives: the OS keyring, via the Secret Service on
//! Linux (gnome-keyring, KeePassXC, ...). Behind a trait so the connection
//! logic can be tested with an in-memory mock instead of the real keyring.
//!
//! There is deliberately no fallback. If no Secret Service is reachable,
//! connecting fails with a message saying so; the token is never written to
//! a file or the database instead.

use super::GmailError;

/// Keyring "service" name. The "user" is the connected Gmail address.
pub const SERVICE: &str = "job-trackwsp";

pub trait TokenStore: Send + Sync {
    /// The stored refresh token for `account`, or None if there isn't one.
    fn get(&self, account: &str) -> Result<Option<String>, GmailError>;
    fn set(&self, account: &str, token: &str) -> Result<(), GmailError>;
    /// Removes it. Not an error if there was nothing to remove.
    fn delete(&self, account: &str) -> Result<(), GmailError>;
}

pub struct KeyringStore;

impl TokenStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, GmailError> {
        match entry(account)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keyring_error(e)),
        }
    }

    fn set(&self, account: &str, token: &str) -> Result<(), GmailError> {
        entry(account)?.set_password(token).map_err(keyring_error)
    }

    fn delete(&self, account: &str) -> Result<(), GmailError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keyring_error(e)),
        }
    }
}

fn entry(account: &str) -> Result<keyring::Entry, GmailError> {
    keyring::Entry::new(SERVICE, account).map_err(keyring_error)
}

/// keyring's errors describe the platform failure, never the secret, so
/// they're safe to show. The two "can't reach a store" cases get the
/// actionable message.
fn keyring_error(e: keyring::Error) -> GmailError {
    match e {
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_) => GmailError::Keyring(format!(
            "no usable Secret Service keyring ({e}). Start and unlock one \
             (gnome-keyring, or KeePassXC with Secret Service enabled) and try again; \
             the token is not stored anywhere else"
        )),
        other => GmailError::Keyring(other.to_string()),
    }
}

#[cfg(test)]
pub mod mock {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// In-memory stand-in. `unavailable` behaves like a machine with no
    /// Secret Service: every call fails.
    #[derive(Default)]
    pub struct MockStore {
        pub tokens: Mutex<HashMap<String, String>>,
        pub unavailable: bool,
    }

    impl MockStore {
        fn check(&self) -> Result<(), GmailError> {
            if self.unavailable {
                Err(GmailError::Keyring("no usable Secret Service keyring (mock)".into()))
            } else {
                Ok(())
            }
        }
    }

    impl TokenStore for MockStore {
        fn get(&self, account: &str) -> Result<Option<String>, GmailError> {
            self.check()?;
            Ok(self.tokens.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, token: &str) -> Result<(), GmailError> {
            self.check()?;
            self.tokens.lock().unwrap().insert(account.into(), token.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), GmailError> {
            self.check()?;
            self.tokens.lock().unwrap().remove(account);
            Ok(())
        }
    }
}
