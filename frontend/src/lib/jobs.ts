import type { FilterMode, FlagKey, Filters, Job, JobSort, StatusColor, StatusKey } from '../types'

export const CLOSING_SOON_DAYS = 7
export const STALE_DAYS = 30

// What the app starts with (when nothing is saved) and what the top-level
// [ clear ] goes back to: nothing checked, so nothing is hidden.
// Removed postings (gone from the sheet, JT-26) are excluded unless you
// choose otherwise, so the list matches the sheet out of the box.
export const DEFAULT_FILTERS: Filters = {
  query: '',
  city: '',
  statuses: {},
  flags: { removed: 'exclude' },
}

// 'YYYY-MM-DD' → whole days since the epoch. Going through Date.UTC (not
// `new Date('2026-10-14')` minus `new Date()`) keeps time zones and DST out
// of the subtraction.
function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A Date as 'YYYY-MM-DD' in local time. */
function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayYmd(): string {
  return ymdOf(new Date())
}

/**
 * A full ISO timestamp the app recorded (UTC, e.g. `applied_at`) as the local
 * 'YYYY-MM-DD'. Applying at 9pm in Toronto is already tomorrow in UTC, so
 * slicing the string would show the wrong day.
 */
export function localYmd(iso: string): string {
  return ymdOf(new Date(iso))
}

export function addDays(ymd: string, n: number): string {
  const d = new Date((dayNumber(ymd) + n) * 86_400_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Days from today (local) until the deadline; negative once it has passed. */
export function daysLeft(deadline: string | null): number | null {
  if (!deadline) return null
  const days = dayNumber(deadline) - dayNumber(todayYmd())
  return Number.isNaN(days) ? null : days
}

export function isExpired(job: Job): boolean {
  const days = daysLeft(job.deadline)
  return days !== null && days < 0
}

export function isClosingSoon(job: Job): boolean {
  const days = daysLeft(job.deadline)
  return days !== null && days >= 0 && days <= CLOSING_SOON_DAYS
}

/** Whole days since 'YYYY-MM-DD' (local); null if missing or unparseable. */
export function daysSince(ymd: string | null): number | null {
  if (!ymd) return null
  const days = dayNumber(todayYmd()) - dayNumber(ymd)
  return Number.isNaN(days) ? null : days
}

/** "today" / "3d ago" for a 'YYYY-MM-DD'; '' if missing. */
export function agoText(ymd: string | null): string {
  const days = daysSince(ymd)
  if (days === null) return ''
  return days <= 0 ? 'today' : `${days}d ago`
}

// LINE view only: a character cap keeps the rows a steady rhythm. The card
// views truncate by width in CSS instead. Full title is in the detail card.
export const LINE_TITLE_MAX = 60

export function clipTitle(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max).trimEnd()}…` : title
}

// The date slot of the meta line: the deadline, or "rolling".
export function dateText(job: Job): string {
  return job.deadline ?? 'rolling'
}

// One entry per diamond state, in filter-panel order. `label` is used for
// the meta-line label and the filter row alike.
export type Status = { key: StatusKey; color: StatusColor; label: string }

export const STATUSES: Status[] = [
  { key: 'applied', color: 'green', label: 'applied' },
  { key: 'closing', color: 'pink', label: 'closing soon' },
  { key: 'deadline', color: 'blue', label: 'has deadline' },
  { key: 'rolling', color: 'sand', label: 'rolling' },
  { key: 'pastdue', color: 'dim', label: 'past due' },
]

// First match wins.
export function statusOf(job: Job): StatusKey {
  if (job.applied) return 'applied'
  if (isClosingSoon(job)) return 'closing'
  if (isExpired(job)) return 'pastdue'
  if (job.deadline) return 'deadline'
  return 'rolling'
}

export function statusInfo(job: Job): Status {
  const key = statusOf(job)
  return STATUSES.find((s) => s.key === key)!
}

// Stripe + diamond colour.
export function stripeColor(job: Job): StatusColor {
  return statusInfo(job).color
}

// The squares left of the diamond, in display order (left to right). Each
// flag owns a fixed slot whether or not it's showing, so diamonds line up
// across cards. The same entry drives the square, its meta-line label and
// its filter row: adding a flag is adding an entry here, nothing else.
export type Flag = {
  key: FlagKey
  color: StatusColor
  label: string // meta-line label (DEFAULT / LINE) and filter row
  short: string // meta-line label in COMPACT
  hint: string // hover tooltip on the square
  test: (job: Job) => boolean
}

export const FLAGS: Flag[] = [
  {
    // The posting stays green (it was applied); the grey square says how it
    // ended. `app_status` comes from the application, so a rejection marked
    // in PIPELINE shows up here too (App patches it after the move).
    key: 'rejected',
    color: 'dim',
    label: 'rejected',
    short: 'R✕',
    hint: 'application rejected',
    test: (job) => job.app_status === 'rejected',
  },
  {
    key: 'stale',
    color: 'pink',
    label: `${STALE_DAYS}+ days`,
    short: `${STALE_DAYS}+`,
    hint: `first seen ${STALE_DAYS}+ days ago`,
    test: (job) => (daysSince(job.first_seen) ?? 0) >= STALE_DAYS,
  },
  {
    key: 'borderline',
    color: 'blue',
    label: 'borderline',
    short: 'B',
    hint: 'borderline',
    test: (job) => job.borderline,
  },
  {
    // Gone from the sheet (JT-26). Excluded by default (DEFAULT_FILTERS), so
    // the square only shows once you include these rows.
    key: 'removed',
    color: 'dim',
    label: 'removed',
    short: 'RM',
    hint: 'no longer in the sheet',
    test: (job) => job.removed_at !== null,
  },
]

export function activeFlags(job: Job): Flag[] {
  return FLAGS.filter((f) => f.test(job))
}

export type LabelSpec = { key: string; color: StatusColor; text: string }

/**
 * The bordered labels for one posting: squares first, then the diamond, in
 * marker order. `short` abbreviates the square labels (COMPACT); diamond
 * labels are always full words.
 */
export function labelsFor(job: Job, short = false): LabelSpec[] {
  const status = statusInfo(job)
  return [
    ...activeFlags(job).map((f) => ({ key: f.key, color: f.color, text: short ? f.short : f.label })),
    { key: status.key, color: status.color, text: status.label },
  ]
}

/** Every flag in slot order, with whether it's showing for this job. */
export function flagSlots(job: Job): { flag: Flag; on: boolean }[] {
  return FLAGS.map((flag) => ({ flag, on: flag.test(job) }))
}

/**
 * `ignore` skips one group (its includes and excludes both). The filter
 * panel uses it for its counts: a status row's count is "what you'd see
 * with this status included", so it applies search, city and the flag
 * group, but not the status group itself.
 */
export function matchesFilters(job: Job, f: Filters, ignore?: 'statuses' | 'flags'): boolean {
  const q = f.query.trim().toLowerCase()
  if (q && !`${job.company} ${job.title} ${job.cities.join(' ')}`.toLowerCase().includes(q)) return false
  // The hub / city box: any of its cities or hubs ("gta" finds markham).
  const c = f.city.trim().toLowerCase()
  if (c && ![...job.cities, ...job.hubs, (job.city ?? '').toLowerCase()].some((x) => x.includes(c))) return false
  if (ignore !== 'statuses' && !groupPasses(f.statuses, [statusOf(job)])) return false
  if (ignore !== 'flags' && !groupPasses(f.flags, activeFlags(job).map((fl) => fl.key))) return false
  return true
}

// One group's verdict, given the row keys this posting matches in it (one
// status, any number of flags).
function groupPasses<K extends string>(modes: Partial<Record<K, FilterMode>>, matched: K[]): boolean {
  if (matched.some((k) => modes[k] === 'exclude')) return false
  // `Object.values` on a Partial map: the modes of every row that's on.
  const anyIncludes = Object.values(modes).includes('include')
  return !anyIncludes || matched.some((k) => modes[k] === 'include')
}

/** The JOBS sort words, in toolbar order (JT-39). */
export const JOB_SORTS: { key: JobSort; label: string }[] = [
  { key: 'deadline', label: 'deadline' },
  { key: 'first_seen', label: 'first seen' },
  { key: 'last_seen', label: 'last seen' },
  { key: 'company', label: 'company' },
  { key: 'status', label: 'status' },
]

export type HubGroup = { hub: string; jobs: Job[] }

export const NO_CITY = 'unknown'

/** The sections a posting appears in: its hubs, or "unknown" with none. */
export function sectionsOf(job: Job): string[] {
  return job.hubs.length > 0 ? job.hubs : [NO_CITY]
}

/**
 * Buckets jobs by hub (JT-38), keeping the incoming (deadline, last_seen)
 * order inside each bucket. A posting in several hubs goes in each of
 * them; cities in one hub put it there once. Biggest hubs first so gta
 * leads, ties by name. A bucket's length counts postings, never copies.
 */
export function groupByHub(jobs: Job[]): HubGroup[] {
  const map = new Map<string, Job[]>()
  for (const job of jobs) {
    for (const hub of sectionsOf(job)) {
      const bucket = map.get(hub)
      if (bucket) bucket.push(job)
      else map.set(hub, [job])
    }
  }
  return [...map]
    .map(([hub, jobs]) => ({ hub, jobs }))
    .sort((a, b) => b.jobs.length - a.jobs.length || a.hub.localeCompare(b.hub))
}

/** "waterloo / toronto": a posting's real cities, for cards and lines. */
export function cityText(job: Job): string {
  return job.cities.length > 0 ? job.cities.join(' / ') : (job.city?.toLowerCase() ?? '—')
}
