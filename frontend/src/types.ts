// Mirrors `jobs::JobRow` in src-tauri/src/jobs.rs. serde serializes the Rust
// struct field-for-field, so names must match exactly; `Option<T>` arrives
// as `T | null`.
export type Job = {
  id: number
  company: string
  title: string
  city: string | null
  req_id: string | null
  url: string | null
  deadline: string | null // 'YYYY-MM-DD'
  posting_status: 'open' | 'closing' | 'closed'
  borderline: boolean
  borderline_reason: string | null
  source: string | null
  first_seen: string | null // 'YYYY-MM-DD'
  last_seen: string | null
  removed_at: string | null // full ISO timestamp; set once it's gone from the sheet
  applied: boolean
  applied_at: string | null // full ISO timestamp, UTC
  app_status: AppStatus | null // the application's status; null when not applied
  notes: string | null
}

// Mirrors `sync::SyncCounts` in src-tauri/src/sync/mod.rs.
export type SyncCounts = {
  inserted: number
  updated: number
  merged: number
  skipped: number
  removed: number
  removal_skipped: boolean
}

// What the diamond says about a posting, one per posting (first match in
// `statusOf`). Past due is grey (`--text-dim`): the posting is closed.
export type StatusKey = 'applied' | 'closing' | 'deadline' | 'rolling' | 'pastdue'

// The square flags. Keys of `FLAGS` in lib/jobs.ts.
export type FlagKey = 'rejected' | 'stale' | 'borderline' | 'removed'

// A filter row that isn't off. Include = show only matches; exclude = hide
// matches.
export type FilterMode = 'include' | 'exclude'

// The panel's rows that aren't off, per group; a row missing from its map
// is off. Any matching exclude hides a posting. Includes are OR within a
// group and AND across groups, and a group with no includes doesn't filter.
// `Partial<Record<K, V>>`: an object whose keys are some (not necessarily
// all) of K.
export type Filters = {
  query: string
  city: string // substring of the city, '' = any
  statuses: Partial<Record<StatusKey, FilterMode>>
  flags: Partial<Record<FlagKey, FilterMode>>
}

// The status colours, shared by the stripe, the diamond and the flag
// squares. Matches the `data-color` selectors in index.css. 'dim' is the
// existing `--text-dim` grey, for things that are closed: past due, rejected.
export type StatusColor = 'green' | 'pink' | 'blue' | 'sand' | 'dim'

// Pipeline stages. The first four are open, in order; the last two close an
// application. Same values as the CHECK constraints in 0001_init.sql.
export type Stage = 'applied' | 'assessment' | 'interview' | 'offer'
export type AppStatus = Stage | 'rejected' | 'withdrawn'

// Mirrors `applications::EventRow` in src-tauri/src/applications.rs.
export type AppEvent = {
  id: number
  application_id: number
  type: AppStatus
  occurred_at: string // full ISO timestamp, UTC
  origin: 'manual' | 'email'
  note: string | null
}

// Mirrors `applications::ApplicationRow`.
export type Application = {
  id: number
  job_id: number | null // null: added by hand, the scheduler never found it
  company: string
  title: string
  status: AppStatus
  applied_at: string | null // full ISO timestamp, UTC
  stage_since: string | null // when the latest event happened
  notes: string | null
  events: AppEvent[] // oldest first
}

// Mirrors `mail::MailStatus` in src-tauri/src/mail/mod.rs (JT-14).
export type MailStatus = {
  last_checked_at: string | null // full ISO timestamp, UTC; null before the first poll
  last_new: number // messages from that poll that passed the filter
  checking: boolean // a poll is running now
}
