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

export type Filters = {
  query: string
  city: string // '' = any
  source: string // '' = any
  unappliedOnly: boolean
  closingOnly: boolean
  hideBorderline: boolean
}

// What decides a row's 3px left edge. Matches the `data-status` selectors
// on `.row` in index.css.
export type RowStatus = 'applied' | 'closing' | 'borderline' | 'none'
