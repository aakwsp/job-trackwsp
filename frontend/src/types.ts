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
  applied: boolean
  applied_at: string | null // full ISO timestamp, UTC
  notes: string | null
}

// Mirrors `sync::SyncCounts` in src-tauri/src/sync/mod.rs.
export type SyncCounts = {
  inserted: number
  updated: number
  merged: number
  skipped: number
}

// What the diamond says about a posting, one per posting (first match in
// `statusOf`). Past due is red, and also gets a red flag square.
export type StatusKey = 'applied' | 'closing' | 'deadline' | 'rolling' | 'pastdue'

// The square flags. Keys of `FLAGS` in lib/jobs.ts.
export type FlagKey = 'pastdue' | 'stale' | 'borderline'

// Checked rows in each filter group. Empty = that group doesn't filter.
// Within a group it's OR (any checked row matches); across groups AND.
export type Filters = {
  query: string
  city: string // substring of the city, '' = any
  statuses: StatusKey[]
  flags: FlagKey[]
}

// The status colours, shared by the stripe, the diamond and the flag
// squares. Matches the `data-color` selectors in index.css. 'red' is past
// due (`--status-overdue`).
export type StatusColor = 'green' | 'pink' | 'blue' | 'sand' | 'red'

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
