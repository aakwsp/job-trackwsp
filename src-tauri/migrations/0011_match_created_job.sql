-- JT-18: [ + new job ] in INBOX creates a manual posting (jobs.source =
-- 'manual') and an application on it from an email. The posting it
-- created, so undoing that email removes both again.
ALTER TABLE email_matches ADD COLUMN created_job_id INTEGER REFERENCES jobs (id) ON DELETE SET NULL;
