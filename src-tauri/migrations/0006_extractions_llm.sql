-- JT-15: LLM extraction results.
--
-- `extractions` is rebuilt rather than altered: its event_type CHECK only
-- allowed application statuses (applied ... withdrawn), and the LLM's event
-- types are different (rejection, follow_up, scheduling, job_alert,
-- not_job). SQLite can't change a CHECK in place. Nothing had written to
-- the table before this, but the copy keeps any rows anyway.
--
-- One row per email per extraction run, holding exactly what the model
-- returned (`raw_response`), so later edits can be compared against it.
-- Matching to applications (`matched_application_id`, `state`) is JT-16.
CREATE TABLE extractions_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id                 INTEGER NOT NULL REFERENCES emails (id) ON DELETE CASCADE,
  company                  TEXT,
  role                     TEXT,
  req_id                   TEXT,
  event_type               TEXT NOT NULL
                             CHECK (event_type IN ('applied', 'assessment', 'interview', 'offer', 'rejection',
                                                   'follow_up', 'scheduling', 'job_alert', 'not_job')),
  -- the event's own date if the email gives one, else the email's date
  occurred_at              TEXT,
  -- overall confidence, 0 to 1
  confidence               REAL,
  -- {"company": 0.9, "role": 0.8, "req_id": 0.1, "event_type": 0.95, "event_date": 0.7}
  field_confidence         TEXT,
  model                    TEXT,
  -- the model's JSON exactly as returned
  raw_response             TEXT,
  matched_application_id   INTEGER REFERENCES applications (id) ON DELETE SET NULL,
  state                    TEXT NOT NULL DEFAULT 'pending'
                             CHECK (state IN ('pending', 'confirmed', 'rejected')),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  resolved_at              TEXT
);

INSERT INTO extractions_new (id, email_id, company, role, req_id, event_type, occurred_at, confidence,
                             matched_application_id, state, created_at, resolved_at)
SELECT id, email_id, company, role, req_id,
       CASE event_type WHEN 'rejected' THEN 'rejection' WHEN 'withdrawn' THEN 'follow_up' ELSE COALESCE(event_type, 'not_job') END,
       occurred_at, confidence / 100.0, matched_application_id, state, created_at, resolved_at
FROM extractions;

DROP TABLE extractions;
ALTER TABLE extractions_new RENAME TO extractions;
CREATE INDEX extractions_state_idx ON extractions (state);
CREATE INDEX extractions_email_id_idx ON extractions (email_id);
CREATE INDEX extractions_event_type_idx ON extractions (event_type);

-- Why the last extraction attempt for an email failed (it stays pending and
-- is retried next poll). NULL once it succeeds.
ALTER TABLE emails ADD COLUMN extract_error TEXT;
