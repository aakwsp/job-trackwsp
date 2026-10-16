-- JT-18: when the user opened an email in INBOX. NULL = unread. Opening an
-- email sets it; the `m` key toggles it back and forth.
ALTER TABLE emails ADD COLUMN read_at TEXT;
