-- JT-14: what the mail poller stores per message, beyond 0001's columns.
--
-- status: 'pending' (passed the filter, waiting for the LLM in JT-15) or
-- 'ignored' (filtered out here, or later rejected by the LLM). No CHECK
-- constraint on purpose: JT-15 will add values, and SQLite can't alter a
-- CHECK without rebuilding the table.
-- filter_reason: why the filter decided what it did, for either status
-- ("ats: greenhouse.io", "list-unsubscribe header", ...), so an ignored
-- message can be explained and recovered (JT-18).
ALTER TABLE emails ADD COLUMN to_addr TEXT;
ALTER TABLE emails ADD COLUMN body_text TEXT;
-- Gmail label ids as a JSON array, e.g. ["INBOX","CATEGORY_UPDATES"]
ALTER TABLE emails ADD COLUMN label_ids TEXT;
ALTER TABLE emails ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE emails ADD COLUMN filter_reason TEXT;
ALTER TABLE emails ADD COLUMN fetched_at TEXT;

CREATE INDEX emails_status_idx ON emails (status);
