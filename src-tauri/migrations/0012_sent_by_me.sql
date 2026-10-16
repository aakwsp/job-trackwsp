-- JT-42: the filter reason for the user's own sent mail is now "sent by
-- me". Renames the rows stored under the old wording; content stays
-- cleared as before.
UPDATE emails SET filter_reason = 'sent by me' WHERE filter_reason = 'sent by you';
