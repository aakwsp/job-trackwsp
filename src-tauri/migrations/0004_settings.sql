-- Small app-level values that aren't secrets. First use (JT-13): the Gmail
-- address the job account is connected as, which is also the keyring user
-- its refresh token is stored under. The token itself never lives here; it
-- is only in the OS keyring (Secret Service).
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
