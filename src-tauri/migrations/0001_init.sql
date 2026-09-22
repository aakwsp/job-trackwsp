-- Ported from backend/src/db/schema.ts (JT-24 Drizzle scaffold, removed in JT-25).
-- Timestamps are ISO-8601 text: 'YYYY-MM-DD' for dates that come from the
-- sheet, full 'YYYY-MM-DDTHH:MM:SSZ' for anything the app records. SQLite has
-- no date type, and text sorts correctly for both.

-- Postings mirrored from the Google Sheet inbox. Owned by the sync.
CREATE TABLE jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key            TEXT NOT NULL,
  company            TEXT NOT NULL,
  title              TEXT NOT NULL,
  city               TEXT,
  req_id             TEXT,
  url                TEXT,
  -- url with query/fragment/trailing slash stripped — JT-22 matching
  url_norm           TEXT,
  -- company|title|city, normalized — JT-22 matching
  triple             TEXT NOT NULL,
  deadline           TEXT,
  posting_status     TEXT NOT NULL DEFAULT 'open'
                       CHECK (posting_status IN ('open', 'closing', 'closed')),
  borderline         INTEGER NOT NULL DEFAULT 0 CHECK (borderline IN (0, 1)),
  borderline_reason  TEXT,
  source             TEXT,
  first_seen         TEXT,
  last_seen          TEXT,
  synced_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- dismissed by the user; the sync must not resurrect it
  hidden             INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);

CREATE UNIQUE INDEX jobs_job_key_idx ON jobs (job_key);
CREATE INDEX jobs_triple_idx ON jobs (triple);
CREATE INDEX jobs_url_norm_idx ON jobs (url_norm);
CREATE INDEX jobs_city_idx ON jobs (city);
CREATE INDEX jobs_deadline_idx ON jobs (deadline);

-- The user's applications. Never written by the sync.
-- job_id is nullable: the user can apply to something the scheduler never found.
-- status is stored (recomputed from the latest event on every event write).
CREATE TABLE applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  -- free-text fallback when there is no job_id
  company     TEXT,
  title       TEXT,
  status      TEXT NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn')),
  applied_at  TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX applications_job_id_idx ON applications (job_id);
CREATE INDEX applications_status_idx ON applications (status);

-- Raw Gmail messages the poller has seen.
CREATE TABLE emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail_id      TEXT NOT NULL,
  thread_id     TEXT,
  from_addr     TEXT,
  subject       TEXT,
  snippet       TEXT,
  received_at   TEXT,
  -- set once the LLM has run on it
  processed_at  TEXT
);

CREATE UNIQUE INDEX emails_gmail_id_idx ON emails (gmail_id);
CREATE INDEX emails_received_at_idx ON emails (received_at);

-- What the LLM pulled out of an email, awaiting the user's confirmation.
-- Nothing here changes an application until state = 'confirmed'.
CREATE TABLE extractions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id                 INTEGER NOT NULL REFERENCES emails (id) ON DELETE CASCADE,
  company                  TEXT,
  role                     TEXT,
  req_id                   TEXT,
  event_type               TEXT
                             CHECK (event_type IN ('applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn')),
  occurred_at              TEXT,
  confidence               INTEGER,
  -- best guess; the user can change it when confirming
  matched_application_id   INTEGER REFERENCES applications (id) ON DELETE SET NULL,
  state                    TEXT NOT NULL DEFAULT 'pending'
                             CHECK (state IN ('pending', 'confirmed', 'rejected')),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  resolved_at              TEXT
);

CREATE INDEX extractions_state_idx ON extractions (state);
CREATE INDEX extractions_email_id_idx ON extractions (email_id);

-- Timeline per application. The latest event determines applications.status.
CREATE TABLE application_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id   INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  type             TEXT NOT NULL
                     CHECK (type IN ('applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn')),
  occurred_at      TEXT NOT NULL,
  origin           TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'email')),
  email_id         INTEGER REFERENCES emails (id) ON DELETE SET NULL,
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX application_events_application_id_idx ON application_events (application_id);
CREATE INDEX application_events_occurred_at_idx ON application_events (occurred_at);
