-- JT-16: Gemini's answer to "which of these applications is this email
-- about?", asked only when matching stays ambiguous. Kept per email and
-- candidate set, so the same question isn't asked (or paid for) twice. Its
-- answer is evidence for routing, never a decision on its own.
CREATE TABLE llm_match_hints (
  email_id       INTEGER NOT NULL REFERENCES emails (id) ON DELETE CASCADE,
  -- JSON array of the candidate application ids, sorted
  candidate_ids  TEXT NOT NULL,
  -- the application it picked, or NULL for "none / can't tell"
  pick           INTEGER,
  confidence     REAL,
  model          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (email_id, candidate_ids)
);
