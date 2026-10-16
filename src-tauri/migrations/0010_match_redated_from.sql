-- JT-18: an "applied" email older than the applied event it attaches to
-- moves that event (and applications.applied_at) back to the email's date.
-- The date it had before, so undoing the email puts it back. NULL = the
-- email didn't move anything.
ALTER TABLE email_matches ADD COLUMN redated_from TEXT;
