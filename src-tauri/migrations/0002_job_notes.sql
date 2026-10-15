-- The user's notes on a posting they haven't applied to yet. A table of its
-- own rather than a column on `jobs`, because `jobs` is owned by the sync and
-- this is user data the sync must never touch.
--
-- Once the posting is marked applied, the note moves into
-- `applications.notes` (and back here on undo), so a posting has at most one
-- note, in exactly one place. See `jobs::set_applied` / `jobs::save_notes`.
CREATE TABLE job_notes (
  job_id      INTEGER PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
