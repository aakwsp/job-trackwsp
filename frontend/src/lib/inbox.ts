import * as api from '../api'
import type { InboxRow, StatusColor } from '../types'

// Display rules from design/inbox/*.dc.html.

/** The stage colour an event type is shown in; null = muted. */
export function eventColor(type: string | null): StatusColor | null {
  switch (type) {
    case 'applied':
      return 'sand'
    case 'assessment':
      return 'blue'
    case 'interview':
      return 'pink'
    case 'offer':
      return 'green'
    default:
      return null // rejection, follow-up, scheduling, not parsed yet
  }
}

/** "follow_up" → "follow-up", as the boards write it. */
export function eventLabel(type: string | null): string {
  return type ? type.replace('_', '-') : 'waiting'
}

/** Scores under this are shown pink. */
export const LOW_SCORE = 0.8

// INBOX's sort (JT-18), inside each // checking, // auto, // checked
// section: newest first, or by company A–Z (newest first within one).
export type MailSort = 'newest' | 'company'

export function sortRows(rows: InboxRow[], sort: MailSort): InboxRow[] {
  const recv = (r: InboxRow) => r.received_at ?? ''
  const a = [...rows]
  if (sort === 'company')
    a.sort((x, y) => (x.company ?? '').toLowerCase().localeCompare((y.company ?? '').toLowerCase()) || recv(y).localeCompare(recv(x)))
  else a.sort((x, y) => recv(y).localeCompare(recv(x)))
  return a
}

// Remembered in `settings.inbox_sort`, like JOBS' `jobs_sort` (JT-39).
// Where it used to live: read once, carried over, then removed.
const LEGACY_KEY = 'jt.inbox.sort'

/**
 * The remembered sort. The first time (nothing in settings yet) it takes
 * the old localStorage choice, saves it to settings and drops the old key,
 * so localStorage isn't used again. Never rejects: 'newest' if anything
 * fails, so the page always renders.
 */
export async function loadSort(): Promise<MailSort> {
  try {
    const stored = await api.inboxSort()
    if (stored) return stored
  } catch {
    return 'newest'
  }
  let legacy: string | null = null
  try {
    legacy = localStorage.getItem(LEGACY_KEY)
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // storage unavailable: nothing to carry over
  }
  const s: MailSort = legacy === 'company' ? 'company' : 'newest'
  await saveSort(s)
  return s
}

export async function saveSort(s: MailSort): Promise<void> {
  // Not saved: it still works for this session.
  await api.setInboxSort(s).catch(() => {})
}

/** 'YYYY-MM-DD' of a stored UTC timestamp, in local time. */
export function localDay(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 'YYYY-MM-DD HH:MM' local. */
export function localDayTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${localDay(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
