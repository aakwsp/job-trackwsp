-- JT-26: when the posting disappeared from the sheet. NULL while it's still
-- there. Its own column rather than a posting_status value, because the sync
-- overwrites posting_status from the sheet on every run, and "the sheet no
-- longer lists it" is a different fact from anything the sheet says.
--
-- Set by the sync's removal pass (sync::mark_removed), cleared if the
-- posting comes back. Never set on a job that has an application.
ALTER TABLE jobs ADD COLUMN removed_at TEXT;
