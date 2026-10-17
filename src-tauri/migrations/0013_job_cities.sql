-- JT-38: the places a posting names, parsed from `jobs.city` (which stays
-- the raw text: it's part of job_key). Rows are written by Rust
-- (`cities::rebuild_job`, `cities::ensure`), never by hand: SQL can't run
-- the parser, so the backfill happens on open, right after migrations.
-- `position` keeps the order the posting lists them in.
CREATE TABLE job_cities (
  job_id   INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  city     TEXT    NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (job_id, city)
);
CREATE INDEX job_cities_city ON job_cities (city);
