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

// Remembered like the JOBS view mode (lib/view.ts): localStorage, and a
// broken value never stops the page from rendering.
const SORT_KEY = 'jt.inbox.sort'

export function loadSort(): MailSort {
  try {
    return localStorage.getItem(SORT_KEY) === 'company' ? 'company' : 'newest'
  } catch {
    return 'newest'
  }
}

export function saveSort(s: MailSort) {
  try {
    localStorage.setItem(SORT_KEY, s)
  } catch {
    // not saved; it still works for this session
  }
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
