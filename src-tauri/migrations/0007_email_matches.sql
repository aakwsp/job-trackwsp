-- JT-16: how each extracted email was matched to an application and routed.
--
-- One row per email (the latest decision). `emails.status` moves on from
-- 'extracted' to 'auto' (applied automatically), 'checking' (waiting for the
-- user in INBOX), 'confirmed' or 'rejected' (the user decided).
CREATE TABLE email_matches (
  email_id          INTEGER PRIMARY KEY REFERENCES emails (id) ON DELETE CASCADE,
  extraction_id     INTEGER REFERENCES extractions (id) ON DELETE SET NULL,
  -- the one application it was matched to, if exactly one
  application_id    INTEGER REFERENCES applications (id) ON DELETE SET NULL,
  -- JSON array of application ids it could be (several = ambiguous)
  candidate_ids     TEXT NOT NULL DEFAULT '[]',
  -- no application, but this posting matches: "create application from posting"
  suggested_job_id  INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  score             REAL NOT NULL,
  -- JSON array of short reasons, e.g. ["req_id match", "domain lyft.com", "role 0.85"]
  reasons           TEXT NOT NULL DEFAULT '[]',
  -- write_event:<type> | attach_event | attach | none
  action            TEXT NOT NULL,
  -- the application_events row written or attached to
  event_id          INTEGER REFERENCES application_events (id) ON DELETE SET NULL,
  -- 1 if this email wrote `event_id` (so undo removes it); 0 if it only attached
  wrote_event       INTEGER NOT NULL DEFAULT 0 CHECK (wrote_event IN (0, 1)),
  -- why it's in checking, in a few words
  note              TEXT,
  -- the user undid, edited or rejected it: never auto-routed again
  user_touched      INTEGER NOT NULL DEFAULT 0 CHECK (user_touched IN (0, 1)),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX email_matches_application_id_idx ON email_matches (application_id);
