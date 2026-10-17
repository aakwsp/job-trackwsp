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
  // JT-38: the places `city` names (lowercase, accents folded, in the
  // posting's order) and their hubs: the JOBS sections it appears in.
  // `city` stays the raw text from the sheet.
  cities: string[]
  hubs: string[]
}

// Mirrors `jobs::JobSort` (JT-39): the JOBS toolbar's sort, done in Rust.
export type JobSort = 'deadline' | 'first_seen' | 'last_seen' | 'company' | 'status'

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
  city: string // substring of any of its cities or hubs, '' = any
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
  total: number // every stored email, whatever its status
  ignored: number // ignored or blocked: never in INBOX's lists
  checking: boolean // a poll is running now
  parsed: number // emails the LLM has read (JT-15)
  waiting: number // pending emails waiting for the LLM
  extracting: boolean // the LLM is working through them now
  extract_error: string | null // why the last LLM run stopped early (bad key, ...)
  needs_key: boolean // no Gemini API key stored yet
}

// ── INBOX (JT-18). Mirrors src-tauri/src/inbox.rs. ──────────────────────

export type InboxStatus = 'pending' | 'extracted' | 'checking' | 'auto' | 'confirmed' | 'rejected'

export type InboxRow = {
  id: number
  status: InboxStatus
  company: string | null
  event_type: string | null
  score: number | null // routing score (JT-16), not Gemini's confidence
  subject: string | null
  received_at: string | null
  read: boolean
  application_id: number | null
}

export type IgnoredRow = {
  id: number
  gmail_id: string
  from_addr: string | null
  subject: string | null
  received_at: string | null
  filter_reason: string | null
}

export type AppRef = { id: number; company: string; title: string; status: string; applied_at: string | null; city: string | null }

// [ + new job ] in INBOX (routing::NewJob).
// `cities`: zero, one or several; Rust joins them into `jobs.city` with " / ".
export type NewJob = { company: string; title: string; cities: string[]; req_id?: string; url?: string }

export type InboxDetail = {
  email: {
    id: number
    gmail_id: string
    thread_id: string | null
    status: InboxStatus
    from_addr: string | null
    subject: string | null
    received_at: string | null
    body_text: string | null // plain text only; never rendered as HTML
    read: boolean
    extract_error: string | null
  }
  extraction: {
    id: number
    company: string | null
    role: string | null
    req_id: string | null
    event_type: string
    occurred_at: string | null
    confidence: number | null // Gemini's
    field_confidence: string | null // JSON object
  } | null
  match: {
    application: AppRef | null
    candidates: AppRef[]
    suggested_job: { id: number; company: string; title: string } | null
    score: number
    reasons: string[]
    action: string // write_event:<type> | attach_event | attach | none
    note: string | null
    wrote_event: boolean
  } | null
  applications: AppRef[]
  timeline: TimelineNode[] // the matched application's timeline, oldest first
}

// Corrections for routing::edit (JT-16). Omitted = unchanged.
export type RouteEdit = {
  company?: string
  role?: string
  req_id?: string
  event_type?: string
  event_date?: string
  application_id?: number
}

// One node of an application's timeline (JT-18): an email (diamond) or an
// event that isn't one (square: first seen, applied by hand, a manual stage
// change). Mirrors inbox::TimelineNode.
export type TimelineNode = {
  kind: 'email' | 'event'
  email_id: number | null // emails only
  event_type: string | null // email: extracted type; event: its type or 'first_seen'
  status: InboxStatus | null // emails only
  at: string | null // received / occurred; first_seen is a plain date
  read: boolean
}

export type InboxJob = {
  application_id: number
  company: string
  title: string
  status: string
  emails: number
  unread: number
  latest: string | null
}
