import type { FilterMode, FlagKey, Filters, Job, StatusColor, StatusKey } from '../types'
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

/** The row's state; `null` = off. */
export function rowMode(f: Filters, row: FilterRow): FilterMode | null {
  // `as` because TypeScript can't tie `row.group` to the type of `row.key`
  // across the index; the FilterRow union guarantees they match.
  return (f[row.group] as Record<string, FilterMode | undefined>)[row.key] ?? null
}

/** Sets one row's state (`null` = off). Returns a new Filters; never mutates. */
export function setRow(f: Filters, row: FilterRow, mode: FilterMode | null): Filters {
  // Copy the group's map, then add or delete this one key. An off row is
  // removed rather than stored, so a saved filter only lists rows that do
  // something.
  const group: Record<string, FilterMode> = { ...f[row.group] }
  if (mode) group[row.key] = mode
  else delete group[row.key]
  return { ...f, [row.group]: group }
}

const NEXT: Record<'off' | FilterMode, FilterMode | null> = { off: 'include', include: 'exclude', exclude: null }

/** off → include → exclude → off. */
export function cycleRow(f: Filters, row: FilterRow): Filters {
  return setRow(f, row, NEXT[rowMode(f, row) ?? 'off'])
}

/** Every row that isn't off, statuses first, in panel order. Used for the chips and the count. */
export function activeRows(f: Filters): { row: FilterRow; mode: FilterMode }[] {
  return [...STATUS_ROWS, ...FLAG_ROWS].flatMap((row) => {
    const mode = rowMode(f, row)
    // `flatMap` returning [] drops the row; returning [x] keeps it.
    return mode ? [{ row, mode }] : []
  })
}

/**
 * Puts the panel back to its defaults (everything off except removed,
 * which stays excluded); leaves the toolbar's search and city.
 */
export function resetPanel(f: Filters): Filters {
  return { ...f, statuses: DEFAULT_FILTERS.statuses, flags: DEFAULT_FILTERS.flags }
}

/**
 * The count beside each row: postings that would show if that row were the
 * one included in its group, given everything else currently set. So a
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
// Bumped when a new default has to reach filters saved before it existed.
// 2: removed postings excluded by default (JT-26).
const VERSION = 2

// Same storage and try/catch reasoning as `loadView` in view.ts. Anything
// that doesn't look right (older shape, unknown keys) is dropped rather than
// trusted, so a stale save can't hide postings for no visible reason.
export function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_FILTERS
    const saved = JSON.parse(raw) as {
      v?: unknown
      query?: unknown
      city?: unknown
      statuses?: unknown
      flags?: unknown
    }
    const statusKeys = new Set<string>(STATUSES.map((s) => s.key))
    const flagKeys = new Set<string>(FLAGS.map((f) => f.key))
    const flags = loadGroup(saved.flags, flagKeys)
    // A save from before version 2 never had a "removed" row, so its
    // absence means "not chosen yet", not "off": apply the default once.
    // Saved again with `v: 2`, so turning it off afterwards sticks.
    if (saved.v !== VERSION) flags.removed ??= 'exclude'
    return {
      query: typeof saved.query === 'string' ? saved.query : '',
      city: typeof saved.city === 'string' ? saved.city : '',
      statuses: loadGroup(saved.statuses, statusKeys),
      flags,
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

// One group from storage. Saves from before include/exclude are arrays of
// checked keys; those were includes, so they load as includes.
function loadGroup(raw: unknown, keys: Set<string>): Record<string, FilterMode> {
  const out: Record<string, FilterMode> = {}
  if (Array.isArray(raw)) {
    for (const k of raw) if (keys.has(k)) out[k] = 'include'
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (keys.has(k) && (v === 'include' || v === 'exclude')) out[k] = v
  }
  return out
}

export function saveFilters(f: Filters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...f, v: VERSION }))
  } catch {
    // not worth surfacing; it just won't be remembered
  }
}
