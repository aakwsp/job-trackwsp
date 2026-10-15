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
}

// Mirrors `sync::SyncCounts` in src-tauri/src/sync/mod.rs.
export type SyncCounts = {
  inserted: number
  updated: number
  merged: number
  skipped: number
}

// What the diamond says about a posting. Past due shares sand with rolling
// but is its own status, so it can have its own label and filter row.
export type StatusKey = 'applied' | 'closing' | 'deadline' | 'rolling' | 'pastdue'

// The square flags. Keys of `FLAGS` in lib/jobs.ts.
export type FlagKey = 'stale' | 'borderline'

// Checked rows in each filter group. Empty = that group doesn't filter.
// Within a group it's OR (any checked row matches); across groups AND.
export type Filters = {
  query: string
  city: string // substring of the city, '' = any
  statuses: StatusKey[]
  flags: FlagKey[]
}

// The four status colours, shared by the stripe, the diamond and the flag
// squares. Matches the `data-color` selectors in index.css.
export type StatusColor = 'green' | 'pink' | 'blue' | 'sand'
