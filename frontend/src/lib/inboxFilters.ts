import type { FilterMode, InboxRow } from '../types'

// INBOX's [ filters ] (JT-18): the same include / exclude toggles as JOBS
// (lib/filters.ts), over the three sections and unread. An included state
// shows only that state (several included = any of them); an excluded one
// hides it. Unread: include = only unread, exclude = only read.

export type InboxFilterKey = 'checking' | 'auto' | 'checked' | 'unread'
export type InboxFilters = Partial<Record<InboxFilterKey, FilterMode>>

export type InboxFilterRow = { key: InboxFilterKey; label: string; shape: 'marker' | 'flag'; color: string }

// Drawn like the JOBS rows (marker = diamond, flag = square), so the panel
// is also the legend. Colours: the routing score's pink for checking, the
// applied sand for auto, green for checked, muted for unread.
export const STATE_ROWS: InboxFilterRow[] = [
  { key: 'checking', label: 'checking', shape: 'marker', color: 'pink' },
  { key: 'auto', label: 'auto', shape: 'marker', color: 'sand' },
  { key: 'checked', label: 'checked', shape: 'marker', color: 'green' },
]
export const READ_ROWS: InboxFilterRow[] = [{ key: 'unread', label: 'unread', shape: 'flag', color: 'muted' }]
const ALL_ROWS = [...STATE_ROWS, ...READ_ROWS]

/** Which section an email is in. */
export function sectionOf(r: InboxRow): 'checking' | 'auto' | 'checked' {
  if (r.status === 'auto') return 'auto'
  if (r.status === 'confirmed' || r.status === 'rejected') return 'checked'
  return 'checking' // checking, and mail still waiting for Gemini or routing
}

export function matchesInboxFilters(r: InboxRow, f: InboxFilters): boolean {
  const s = sectionOf(r)
  if (f[s] === 'exclude') return false
  const included = STATE_ROWS.filter((row) => f[row.key] === 'include')
  if (included.length > 0 && !included.some((row) => row.key === s)) return false
  if (f.unread === 'include' && r.read) return false
  if (f.unread === 'exclude' && !r.read) return false
  return true
}

/** Per-row counts for the panel: how many emails each row covers. */
export function inboxFilterCounts(rows: InboxRow[]): Map<InboxFilterKey, number> {
  const m = new Map<InboxFilterKey, number>()
  for (const r of rows) {
    const s = sectionOf(r)
    m.set(s, (m.get(s) ?? 0) + 1)
    if (!r.read) m.set('unread', (m.get('unread') ?? 0) + 1)
  }
  return m
}

const NEXT: Record<'off' | FilterMode, FilterMode | undefined> = { off: 'include', include: 'exclude', exclude: undefined }

/** off → include → exclude → off; or straight to `mode`. Never mutates. */
export function setInboxRow(f: InboxFilters, key: InboxFilterKey, mode?: FilterMode | null | 'cycle'): InboxFilters {
  const next = mode === 'cycle' ? NEXT[f[key] ?? 'off'] : (mode ?? undefined)
  const out = { ...f }
  if (next) out[key] = next
  else delete out[key]
  return out
}

/** Every row that isn't off, in panel order (chips and the trigger count). */
export function activeInboxRows(f: InboxFilters): { row: InboxFilterRow; mode: FilterMode }[] {
  return ALL_ROWS.flatMap((row) => {
    const mode = f[row.key]
    return mode ? [{ row, mode }] : []
  })
}

// Kept like the JOBS filters: localStorage, try/catch, a broken value
// never stops the list from rendering.
const STORAGE_KEY = 'jt.inbox.filters'

export function loadInboxFilters(): InboxFilters {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    const out: InboxFilters = {}
    for (const row of ALL_ROWS) {
      const v = raw?.[row.key]
      if (v === 'include' || v === 'exclude') out[row.key] = v
    }
    return out
  } catch {
    return {}
  }
}

export function saveInboxFilters(f: InboxFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f))
  } catch {
    // not saved; it still works for this session
  }
}
