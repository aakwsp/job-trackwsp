import type { FlagKey, Filters, Job, StatusColor, StatusKey } from '../types'
import { DEFAULT_FILTERS, FLAGS, STATUSES, matchesFilters, statusOf } from './jobs'

// The two groups of the filter panel. Rows come straight from STATUSES and
// FLAGS, so the panel shows the same shapes, colours and words as the cards
// and doubles as the legend.
export type FilterRow =
  | { group: 'statuses'; key: StatusKey; label: string; color: StatusColor; shape: 'marker' }
  | { group: 'flags'; key: FlagKey; label: string; color: StatusColor; shape: 'flag' }

export const STATUS_ROWS: FilterRow[] = STATUSES.map((s) => ({
  group: 'statuses',
  key: s.key,
  label: s.label,
  color: s.color,
  shape: 'marker',
}))

export const FLAG_ROWS: FilterRow[] = FLAGS.map((f) => ({
  group: 'flags',
  key: f.key,
  label: f.label,
  color: f.color,
  shape: 'flag',
}))

export function isChecked(f: Filters, row: FilterRow): boolean {
  // `as` because TypeScript can't tie `row.group` to the type of `row.key`
  // across the index; the FilterRow union guarantees they match.
  return (f[row.group] as string[]).includes(row.key)
}

/** Checks or unchecks one row. Returns a new Filters; never mutates. */
export function toggleRow(f: Filters, row: FilterRow): Filters {
  const current = f[row.group] as string[]
  const next = current.includes(row.key) ? current.filter((k) => k !== row.key) : [...current, row.key]
  return { ...f, [row.group]: next }
}

/** Every checked row, statuses first, in panel order. Used for the chips. */
export function checkedRows(f: Filters): FilterRow[] {
  return [...STATUS_ROWS, ...FLAG_ROWS].filter((row) => isChecked(f, row))
}

/** Unchecks everything in the panel; leaves the toolbar's search and city. */
export function resetPanel(f: Filters): Filters {
  return { ...f, statuses: [], flags: [] }
}

/**
 * The count beside each row: postings that would show if that row were the
 * one checked in its group, given everything else currently set. So a
 * status count respects search, city and the flag group, and a flag count
 * respects search, city and the status group.
 */
export function rowCounts(jobs: Job[], f: Filters): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1)
  for (const job of jobs) {
    if (matchesFilters(job, f, 'statuses')) bump(`statuses:${statusOf(job)}`)
    if (matchesFilters(job, f, 'flags')) for (const fl of FLAGS) if (fl.test(job)) bump(`flags:${fl.key}`)
  }
  return counts
}

export const rowId = (row: FilterRow) => `${row.group}:${row.key}`

const STORAGE_KEY = 'jt.filters'

// Same storage and try/catch reasoning as `loadView` in view.ts. Anything
// that doesn't look right (older shape, unknown keys) is dropped rather than
// trusted, so a stale save can't hide postings for no visible reason.
export function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_FILTERS
    const saved = JSON.parse(raw) as Partial<Filters>
    const statusKeys = new Set<string>(STATUSES.map((s) => s.key))
    const flagKeys = new Set<string>(FLAGS.map((f) => f.key))
    return {
      query: typeof saved.query === 'string' ? saved.query : '',
      city: typeof saved.city === 'string' ? saved.city : '',
      statuses: Array.isArray(saved.statuses) ? saved.statuses.filter((k) => statusKeys.has(k)) : [],
      flags: Array.isArray(saved.flags) ? saved.flags.filter((k) => flagKeys.has(k)) : [],
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f))
  } catch {
    // not worth surfacing; it just won't be remembered
  }
}
